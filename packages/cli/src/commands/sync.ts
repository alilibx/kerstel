import { hostname } from "node:os";
import { openContext, type CliContext } from "../context";
import { ClackPrompter, DefaultsPrompter, type Prompter } from "../init/prompts";
import { bold, dim, fail, info, ok, yellow } from "../output";
import {
  fingerprint,
  generateDeviceKeys,
  generateSyncKey,
  openName,
  publicKeyOf,
  sealName,
  sealSyncKey,
} from "../sync/crypto";
import { conflictValue, describe, openConflicts, push, settle, syncOnce, type SyncContext, type SyncReport } from "../sync/engine";
import { SyncHttpError, syncClient, type Fetch } from "../sync/http";
import { forgetSync, isSafeServerUrl, lastResult, loadSync, normaliseServerUrl, recordResult, saveSync } from "../sync/state";
import { cliName } from "../ui/cli-name";
import { newId } from "../../../server/src/protocol";

/**
 * `ks sync`: end-to-end encrypted sync of the vault between your own
 * devices, through a `kerstel-server` you run. Sync spec §7, §8 and §10.
 * This PR covers one device's side: setup, sync, status, devices, off.
 * Pairing more devices is `add-device` and `join`, next.
 */

export interface SyncDeps {
  fetch?: Fetch;
  prompter?: Prompter;
  /** Whether stdin and stdout are a terminal, for conflict questions. */
  interactive?: boolean;
  context?: () => Promise<CliContext>;
  /** For tests: the clock requests are signed with. */
  now?: () => number;
}

const USAGE = `Usage:
  ${cliName()} sync setup <url> [--yes]      Turn sync on and upload this vault
  ${cliName()} sync [--keep local|remote] [--reveal]
                                       Pull, push, and settle conflicts
  ${cliName()} sync status                  Server, pending changes, conflicts, last sync
  ${cliName()} sync devices                 List the devices in this vault
  ${cliName()} sync off [--delete-vault]    Stop syncing this device`;

function thisDevice(): { name: string; platform: string } {
  const platform = process.platform === "darwin" ? "macOS" : process.platform === "linux" ? "Linux" : process.platform;
  return { name: hostname() || "this device", platform };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function when(ms: number | null): string {
  if (ms === null) return "never";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

/** One line for a failure: the server's own message, which never carries a value. */
function explain(error: unknown): string {
  if (error instanceof SyncHttpError) return error.message;
  return (error as Error).message;
}

export async function syncCommand(args: string[], deps: SyncDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  const open = deps.context ?? (() => openContext());

  if (sub === "setup") return setup(rest, deps, open);
  if (sub === "status") return status(rest, open);
  if (sub === "devices") return devices(rest, deps, open);
  if (sub === "off") return off(rest, deps, open);
  if (sub === "--help" || sub === "help") {
    console.log(USAGE);
    return 0;
  }
  if (sub !== undefined && !sub.startsWith("-")) {
    fail(`Unknown sync command "${sub}".`);
    console.log(USAGE);
    return 2;
  }
  return run(args, deps, open);
}

async function setup(args: string[], deps: SyncDeps, open: () => Promise<CliContext>): Promise<number> {
  const yes = args.includes("--yes");
  const urls = args.filter((a) => !a.startsWith("-"));
  const unknown = args.filter((a) => a.startsWith("-") && a !== "--yes");
  if (urls.length !== 1 || unknown.length > 0) {
    fail(`Usage: ${cliName()} sync setup <url> [--yes]`);
    return 2;
  }
  const server = normaliseServerUrl(urls[0]!);
  if (!isSafeServerUrl(server)) {
    fail(`${urls[0]} is not a server Kerstel will send your vault to. Use https://, or http:// to this machine.`);
    return 2;
  }

  const ctx = await open();
  try {
    if (loadSync(ctx.vault, ctx.dataKey)) {
      fail(`Sync is already on for this vault. Run ${cliName()} sync status to see where.`);
      return 1;
    }
    const secrets = ctx.vault.listSecrets();
    const scopes = new Set(secrets.map((s) => s.scope));
    const device = thisDevice();
    console.log("Kerstel sync, end-to-end encrypted. The server stores ciphertext only.");
    console.log(`  Server       ${server}`);
    console.log(`  Vault        new, ${plural(secrets.length, "secret")} in ${plural(scopes.size, "scope")}`);
    console.log(`  This device  ${device.name} ${dim("(the name is sealed; the server never sees it)")}`);

    const interactive = deps.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
    if (!yes && !interactive) {
      fail(`${cliName()} sync setup asks before uploading. Re-run with --yes to upload without asking.`);
      return 2;
    }
    const prompter = deps.prompter ?? (yes ? new DefaultsPrompter() : new ClackPrompter());
    const answer = await prompter.select(
      "Upload the vault?",
      [
        { value: "yes", label: "Yes, upload it" },
        { value: "no", label: "No" },
      ],
      "yes",
    );
    if (answer !== "yes") {
      info("Nothing was uploaded.");
      return 0;
    }

    const vaultId = newId();
    const deviceId = newId();
    const keys = generateDeviceKeys();
    const syncKey = generateSyncKey();
    const client = syncClient({ server, vaultId, deviceId, sign: keys.sign, fetch: deps.fetch, now: deps.now });
    await client.createVault(
      {
        vaultId,
        device: {
          id: deviceId,
          signPub: publicKeyOf(keys.sign),
          encPub: publicKeyOf(keys.enc),
          sealedName: sealName(syncKey, vaultId, deviceId, device),
        },
        sealedKey: sealSyncKey(syncKey, publicKeyOf(keys.enc), { vaultId, deviceId, epoch: 1 }),
      },
      process.env.KERSTEL_SYNC_ENROLL_TOKEN || null,
    );

    const config = { server, vaultId, deviceId, epoch: 1, syncKey, keys, head: 0 };
    saveSync(ctx.vault, ctx.dataKey, config);
    ctx.vault.sync.trackAll();
    const report: SyncReport = { applied: [], pushed: [], conflicts: [], backups: [] };
    await push({ vault: ctx.vault, dataKey: ctx.dataKey, config, client }, report);
    recordResult(ctx.vault, null);
    ok(`Synced ${plural(report.pushed.length, "secret")}. Sync stays on for this vault; run ${cliName()} sync any time.`);
    return 0;
  } catch (error) {
    fail(`Sync setup failed: ${explain(error)}`);
    return 1;
  } finally {
    ctx.vault.close();
  }
}

function contextFor(ctx: CliContext, deps: SyncDeps): SyncContext | null {
  const config = loadSync(ctx.vault, ctx.dataKey);
  if (!config) return null;
  return {
    vault: ctx.vault,
    dataKey: ctx.dataKey,
    config,
    client: syncClient({
      server: config.server,
      vaultId: config.vaultId,
      deviceId: config.deviceId,
      sign: config.keys.sign,
      fetch: deps.fetch,
      now: deps.now,
    }),
  };
}

const notOn = () => info(`Sync is off for this vault. Turn it on with ${cliName()} sync setup <url>.`);

async function run(args: string[], deps: SyncDeps, open: () => Promise<CliContext>): Promise<number> {
  let keep: "local" | "remote" | null = null;
  let reveal = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--reveal") reveal = true;
    else if (arg === "--keep" && (args[i + 1] === "local" || args[i + 1] === "remote")) keep = args[++i] as "local" | "remote";
    else {
      fail(`Unknown option ${arg}.`);
      console.log(USAGE);
      return 2;
    }
  }

  const ctx = await open();
  try {
    const sync = contextFor(ctx, deps);
    if (!sync) {
      notOn();
      return 1;
    }
    let report: SyncReport;
    try {
      report = await syncOnce(sync);
    } catch (error) {
      recordResult(ctx.vault, explain(error));
      fail(`Sync failed: ${explain(error)}`);
      return 1;
    }
    if (report.applied.length > 0) ok(`Pulled ${plural(report.applied.length, "change")} from your other devices.`);
    if (report.pushed.length > 0) ok(`Pushed ${plural(report.pushed.length, "change")}.`);
    for (const dir of report.backups) info(`Values a pull replaced are in the encrypted backup at ${dir}`);

    if (report.conflicts.length > 0) {
      const settled = await settleConflicts(sync, report, { keep, reveal, deps });
      if (settled === null) {
        recordResult(ctx.vault, null);
        return 1;
      }
      // Push what was kept here.
      try {
        const after: SyncReport = { applied: [], pushed: [], conflicts: [], backups: [] };
        await push(sync, after);
        if (after.pushed.length > 0) ok(`Pushed ${plural(after.pushed.length, "settled value")}.`);
      } catch (error) {
        recordResult(ctx.vault, explain(error));
        fail(`Sync failed: ${explain(error)}`);
        return 1;
      }
    }
    if (report.applied.length + report.pushed.length + report.conflicts.length === 0) ok("Up to date.");
    recordResult(ctx.vault, null);
    return 0;
  } finally {
    ctx.vault.close();
  }
}

/**
 * Sync spec §8.4: ask which value stays for each conflict, naming the other
 * device's change only by its length unless --reveal. Without a terminal,
 * --keep decides; with neither, list them and stop. Null when some stay open.
 */
async function settleConflicts(
  sync: SyncContext,
  report: SyncReport,
  options: { keep: "local" | "remote" | null; reveal: boolean; deps: SyncDeps },
): Promise<number | null> {
  const conflicts = openConflicts(sync.vault);
  if (options.keep) {
    for (const ref of conflicts) settle(sync, ref, options.keep, report);
    ok(`Kept the ${options.keep === "local" ? "value on this device" : "other device's value"} for ${plural(conflicts.length, "conflict")}.`);
    return conflicts.length;
  }
  const interactive = options.deps.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!interactive) {
    fail(`${plural(conflicts.length, "key was", "keys were")} changed on this device and another one:`);
    for (const ref of conflicts) console.log(`  ${describe(ref)}`);
    console.log(`Run ${cliName()} sync in a terminal to choose, or ${cliName()} sync --keep local|remote.`);
    return null;
  }
  const prompter = options.deps.prompter ?? new ClackPrompter();
  const shown = (value: string | null) =>
    value === null ? "deleted" : options.reveal ? value : `${plural(value.length, "character")}`;
  for (const ref of conflicts) {
    const row = sync.vault.sync.row(ref)!;
    const local = sync.vault.getSecret(ref);
    const remote = conflictValue(sync, ref, row.conflict!);
    const answer = await prompter.select(
      `${bold(ref.key)} (${ref.scope}) was changed on this device and another one. Which value stays?`,
      [
        { value: "local", label: `This device (${shown(local)})` },
        { value: "remote", label: `The other device (${shown(remote)})` },
      ],
      "local",
    );
    settle(sync, ref, answer as "local" | "remote", report);
  }
  ok(`Settled ${plural(conflicts.length, "conflict")}. The value that lost is in the sync backup.`);
  return conflicts.length;
}

async function status(args: string[], open: () => Promise<CliContext>): Promise<number> {
  if (args.length > 0) {
    fail(`Usage: ${cliName()} sync status`);
    return 2;
  }
  const ctx = await open();
  try {
    const config = loadSync(ctx.vault, ctx.dataKey);
    if (!config) {
      notOn();
      return 0;
    }
    const rows = ctx.vault.sync.rows();
    const pending = rows.filter((r) => r.dirty && !r.conflict).length;
    const conflicts = rows.filter((r) => r.conflict).length;
    const { lastOk, lastError } = lastResult(ctx.vault);
    console.log(`Server        ${config.server}`);
    console.log(`Last sync     ${when(lastOk)}`);
    console.log(`Pending       ${plural(pending, "change")} to push`);
    console.log(`Conflicts     ${conflicts === 0 ? "none" : yellow(`${conflicts} open: run ${cliName()} sync to settle`)}`);
    if (lastError) console.log(yellow(`Last error    ${lastError}`));
    return 0;
  } finally {
    ctx.vault.close();
  }
}

async function devices(args: string[], deps: SyncDeps, open: () => Promise<CliContext>): Promise<number> {
  if (args.length > 0) {
    fail(`Usage: ${cliName()} sync devices`);
    return 2;
  }
  const ctx = await open();
  try {
    const sync = contextFor(ctx, deps);
    if (!sync) {
      notOn();
      return 1;
    }
    let list;
    try {
      list = (await sync.client.devices()).devices;
    } catch (error) {
      fail(`Could not list devices: ${explain(error)}`);
      return 1;
    }
    for (const d of list) {
      const name = openName(sync.config.syncKey, sync.config.vaultId, d.id, d.sealedName);
      const label = name ? `${name.name}${name.platform ? ` (${name.platform})` : ""}` : "(name sealed with another key)";
      const me = d.id === sync.config.deviceId ? `  ${dim("this device")}` : "";
      console.log(
        `${label}  ${dim(fingerprint(d.signPub))}  added ${when(d.addedAt)}  last seen ${when(d.lastSeen)}${me}`,
      );
    }
    return 0;
  } finally {
    ctx.vault.close();
  }
}

async function off(args: string[], deps: SyncDeps, open: () => Promise<CliContext>): Promise<number> {
  const deleteVault = args.includes("--delete-vault");
  if (args.some((a) => a !== "--delete-vault")) {
    fail(`Usage: ${cliName()} sync off [--delete-vault]`);
    return 2;
  }
  const ctx = await open();
  try {
    const sync = contextFor(ctx, deps);
    if (!sync) {
      notOn();
      return 0;
    }
    try {
      if (deleteVault) await sync.client.deleteVault();
      else await sync.client.removeSelf();
    } catch (error) {
      if (error instanceof SyncHttpError && error.code === "last_device") {
        fail(
          `This is the vault's last device. Run ${cliName()} sync off --delete-vault to delete the vault on the server too, ` +
            "or keep syncing.",
        );
        return 1;
      }
      fail(`Could not leave the vault: ${explain(error)}. Sync stays on.`);
      return 1;
    }
    forgetSync(ctx.vault);
    ok(deleteVault ? "Deleted the vault on the server. Sync is off; your secrets stay here." : "Sync is off for this device. Your secrets stay here.");
    return 0;
  } finally {
    ctx.vault.close();
  }
}
