import { hostname } from "node:os";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { openContext, type CliContext } from "../context";
import { ClackPrompter, DefaultsPrompter, type Prompter } from "../init/prompts";
import { bold, dim, fail, info, ok, yellow } from "../output";
import {
  fingerprint,
  generateDeviceKeys,
  generateSyncKey,
  newPairingSecret,
  openName,
  verifiedName,
  openPairingAnswer,
  openSyncKey,
  pairingCode,
  pairingConfirmation,
  pairingIdOf,
  parsePairingCode,
  publicKeyOf,
  same,
  sealName,
  sealPairingAnswer,
  sealSyncKey,
} from "../sync/crypto";
import {
  conflictValue,
  describe,
  openConflicts,
  pull,
  push,
  rotateKey,
  settle,
  syncOnce,
  type SyncContext,
  type SyncReport,
} from "../sync/engine";
import { leaveSyncNotice, syncLockPath, waitForSyncLock } from "../sync/background";
import { SyncHttpError, pairingClient, syncClient, type Fetch } from "../sync/http";
import {
  forgetSync,
  isSafeServerUrl,
  lastResult,
  loadSync,
  normaliseServerUrl,
  recordResult,
  saveSync,
  setFullPull,
  SYNC_META,
  writeSync,
  type SyncConfig,
} from "../sync/state";
import { syncTimer, type EnsureResult, type SyncTimer, type TimerStatus } from "../sync/timer";
import type { SecretRef } from "../reference";
import { vaultPath } from "../paths";
import { cliName } from "../ui/cli-name";
import type { Vault } from "../vault/store";
import { TIMING, isId, isPublicKey, newId } from "../../../server/src/protocol";

/**
 * `ks sync`: end-to-end encrypted sync of the vault between your own
 * devices, through a `kerstel-server` you run. Sync spec §7, §8 and §10.
 */

export interface SyncDeps {
  fetch?: Fetch;
  prompter?: Prompter;
  /** Whether stdin and stdout are a terminal, for conflict questions. */
  interactive?: boolean;
  context?: () => Promise<CliContext>;
  /** For tests: the clock requests are signed with. */
  now?: () => number;
  /** For tests: how pairing waits between polls. */
  sleep?: (ms: number) => Promise<void>;
  /** For tests: this device's name, in place of the host name. */
  deviceName?: string;
  /** For tests: the pull timer, in place of the real launchd agent or systemd timer. */
  timer?: SyncTimer;
}

/** How often each side of a pairing asks the server for news. The new device's polls count against a per-address limit of 30 a minute. */
const POLL_MS = { addDevice: 2_000, join: 3_000 } as const;

const USAGE = `Usage:
  ${cliName()} sync setup <url> [--yes]      Turn sync on and upload this vault
  ${cliName()} sync [--keep local|remote] [--reveal]
                                       Pull, push, and settle conflicts
  ${cliName()} sync status                  Server, pending changes, conflicts, last sync
  ${cliName()} sync devices                 List the devices in this vault
  ${cliName()} sync add-device              Show a one-time code to pair another device
  ${cliName()} sync join <url> <code>       Join a synced vault from this device
  ${cliName()} sync remove-device <name>    Remove a device and replace the sync key
  ${cliName()} sync off [--delete-vault]    Stop syncing this device`;

function thisDevice(deps: SyncDeps): { name: string; platform: string } {
  const platform = process.platform === "darwin" ? "macOS" : process.platform === "linux" ? "Linux" : process.platform;
  return { name: deps.deviceName ?? (hostname() || "this device"), platform };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function when(ms: number | null): string {
  if (ms === null) return "never";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

/** The server no longer knows this device: another device removed it, or the vault was deleted. */
function isUnknownDevice(error: unknown): boolean {
  return error instanceof SyncHttpError && error.code === "unauthorized" && error.message.startsWith("Unknown device");
}

/** One line for a failure: the server's own message, which never carries a value. */
function explain(error: unknown): string {
  if (isUnknownDevice(error)) {
    return (
      "The server no longer knows this device: another device removed it, or the vault was deleted. " +
      `Run ${cliName()} sync off, then pair it again with ${cliName()} sync join.`
    );
  }
  return (error as Error).message;
}

const emptyReport = (): SyncReport => ({ applied: [], pushed: [], conflicts: [], backups: [] });

const isInteractive = (deps: SyncDeps) => deps.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);

/**
 * Asks `check` until it returns something, for as long as a pairing slot
 * lives. Null when the slot is gone: it expired, or the other device said no.
 * A dropped connection or the rate limit only slows it down.
 */
async function waitFor<T>(check: () => Promise<T | null>, everyMs: number, deps: SyncDeps): Promise<T | null> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = Date.now() + TIMING.pairingTtlMs + 30_000;
  while (Date.now() < deadline) {
    try {
      const found = await check();
      if (found !== null) return found;
    } catch (error) {
      if (!(error instanceof SyncHttpError)) throw error;
      if (error.code === "not_found") return null;
      if (error.code === "rate_limited") {
        await sleep(everyMs * 5);
        continue;
      }
      if (error.code !== "unreachable") throw error;
    }
    await sleep(everyMs);
  }
  return null;
}

/** How long a sync you started waits for a background one to finish. */
const LOCK_WAIT_MS = 30_000;
/** How long a background sync waits for the one before it, which may be a pairing that takes minutes. */
const BACKGROUND_LOCK_WAIT_MS = 2 * 60_000;

/**
 * Opens the vault and takes the sync lock beside it (§8.1), so this sync and a
 * background one never pull, push or rotate at the same time. Closing the
 * vault releases the lock.
 */
function lockedOpen(open: () => Promise<CliContext>): () => Promise<CliContext> {
  return async () => {
    const ctx = await open();
    const lock = syncLockPath(ctx.vault.file);
    const release = await waitForSyncLock(lock, LOCK_WAIT_MS);
    if (!release) {
      ctx.vault.close();
      throw new Error(`Another sync is still running on this device. Try again in a moment, or delete ${lock} if none is.`);
    }
    const close = ctx.vault.close;
    ctx.vault.close = () => {
      try {
        close();
      } finally {
        release();
      }
    };
    return ctx;
  };
}

export async function syncCommand(args: string[], deps: SyncDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  const plain = deps.context ?? (() => openContext());
  const open = lockedOpen(plain);

  if (sub === "--background") return background(rest, deps, plain);
  if (sub === "setup") return setup(rest, deps, open);
  if (sub === "status") return status(rest, deps, plain);
  if (sub === "devices") return devices(rest, deps, plain);
  if (sub === "off") return off(rest, deps, open);
  if (sub === "add-device") return addDevice(rest, deps, open);
  if (sub === "join") return join(rest, deps, open);
  if (sub === "remove-device") return removeDevice(rest, deps, open);
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
    const device = thisDevice(deps);
    console.log("Kerstel sync, end-to-end encrypted. The server stores ciphertext only.");
    console.log(`  Server       ${server}`);
    console.log(`  Vault        new, ${plural(secrets.length, "secret")} in ${plural(scopes.size, "scope")}`);
    console.log(`  This device  ${device.name} ${dim("(the name is sealed; the server never sees it)")}`);

    if (!yes && !isInteractive(deps)) {
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
          sealedName: sealName(syncKey, vaultId, deviceId, {
            ...device,
            signPub: publicKeyOf(keys.sign),
            encPub: publicKeyOf(keys.enc),
          }),
        },
        sealedKey: sealSyncKey(syncKey, publicKeyOf(keys.enc), { vaultId, deviceId, epoch: 1 }),
      },
      process.env.KERSTEL_SYNC_ENROLL_TOKEN || null,
    );

    const config = { server, vaultId, deviceId, epoch: 1, syncKey, keys, head: 0 };
    saveSync(ctx.vault, ctx.dataKey, config);
    ctx.vault.sync.trackAll();
    const report = emptyReport();
    await push({ vault: ctx.vault, dataKey: ctx.dataKey, config, client }, report);
    recordResult(ctx.vault, null);
    ok(`Synced ${plural(report.pushed.length, "secret")}. Add another device with: ${cliName()} sync add-device`);
    schedule(ctx.vault, deps);
    return 0;
  } catch (error) {
    fail(`Sync setup failed: ${explain(error)}`);
    return 1;
  } finally {
    ctx.vault.close();
  }
}

/** A signed client for this device's vault. */
export function clientFor(config: SyncConfig, deps: Pick<SyncDeps, "fetch" | "now"> = {}) {
  return syncClient({
    server: config.server,
    vaultId: config.vaultId,
    deviceId: config.deviceId,
    sign: config.keys.sign,
    fetch: deps.fetch,
    now: deps.now,
  });
}

function contextFor(ctx: CliContext, deps: SyncDeps): SyncContext | null {
  const config = loadSync(ctx.vault, ctx.dataKey);
  if (!config) return null;
  return { vault: ctx.vault, dataKey: ctx.dataKey, config, client: clientFor(config, deps) };
}

const notOn = () => info(`Sync is off for this vault. Turn it on with ${cliName()} sync setup <url>.`);

// ---- The pull timer ---------------------------------------------------------
// Every call goes through these, so a timer that throws never fails a sync.

/** The one place the real timer is built, and only when a command needs it. */
function timerOf(deps: SyncDeps): SyncTimer {
  return deps.timer ?? syncTimer();
}

function ensureTimer(deps: SyncDeps, rewrite: boolean): EnsureResult {
  try {
    return timerOf(deps).ensure({ rewrite });
  } catch {
    return "unavailable";
  }
}

function timerStatus(deps: SyncDeps): TimerStatus {
  try {
    return timerOf(deps).status();
  } catch (error) {
    return { state: "unavailable", reason: (error as Error).message };
  }
}

function removeTimer(deps: SyncDeps): void {
  try {
    timerOf(deps).remove();
  } catch {
    // Nothing to report: a timer left behind on a vault with sync off removes itself on its next run.
  }
}

/** Why pulls can't be scheduled here, for a message. */
function unavailableReason(deps: SyncDeps): string {
  const status = timerStatus(deps);
  if (status.state === "unavailable") return status.reason;
  return `${status.kind} would not load it`;
}

const cantSchedule = (reason: string) =>
  `Can't schedule pulls here (${reason}). Kerstel still pulls when you run, exec, or change a secret.`;

/** Marks this device as told that pulls can't be scheduled. False when it already was. */
function noteOnce(vault: Vault): boolean {
  try {
    if (vault.getMeta(SYNC_META.timerNoted) !== null) return false;
    vault.setMeta(SYNC_META.timerNoted, "1");
    return true;
  } catch {
    return false;
  }
}

/** After `setup` or `join`: schedule pulls, and say whether they are. */
function schedule(vault: Vault, deps: SyncDeps): void {
  if (ensureTimer(deps, true) !== "unavailable") {
    ok("Pulls changes every five minutes on its own.");
    return;
  }
  noteOnce(vault);
  info(cantSchedule(unavailableReason(deps)));
}

/**
 * After a sync you ran: bring the timer up to date with this shell's settings.
 * One that can't be scheduled says so every time: you asked for this sync, and
 * it is the one place the reason shows.
 */
function refreshTimer(vault: Vault, deps: SyncDeps): void {
  const result = ensureTimer(deps, true);
  if (result === "updated") console.log(dim("Updated the scheduled pull to match this shell's settings."));
  else if (result === "installed") {
    ok("Pulls changes every five minutes on its own.");
    console.log(dim(`Run \`${cliName()} sync off\` to stop syncing this device.`));
  } else if (result === "unavailable") {
    // Marked, so a background sync does not leave the same line for the next command.
    noteOnce(vault);
    info(cantSchedule(unavailableReason(deps)));
  }
}

/**
 * Whether this vault still syncs. A background sync asks after it released the
 * lock: `uninstall` or `sync off` may have removed the vault or turned sync off
 * meanwhile, and installing the timer then would bring it back.
 */
function stillSynced(vault: Vault): boolean {
  try {
    return existsSync(vault.file) && vault.getMeta(SYNC_META.vaultId) !== null;
  } catch {
    return false;
  }
}

/** After a background sync: install a missing timer, and leave a line for the next command. Never throws. */
function backgroundTimer(vault: Vault, deps: SyncDeps): void {
  const home = dirname(vault.file);
  if (!stillSynced(vault)) return;
  const result = ensureTimer(deps, false);
  if (result === "installed") {
    leaveSyncNotice(
      `kerstel: sync now pulls changes every five minutes on its own. Run \`${cliName()} sync off\` to stop syncing this device.`,
      home,
    );
  } else if (result === "unavailable" && noteOnce(vault)) {
    leaveSyncNotice(
      `kerstel: can't schedule sync pulls here (${unavailableReason(deps)}). Kerstel still pulls when you run, exec, or change a secret.`,
      home,
    );
  }
}

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
    let report: SyncReport | null = null;
    try {
      report = await syncOnce(sync);
    } catch (error) {
      recordResult(ctx.vault, explain(error));
      fail(`Sync failed: ${explain(error)}`);
    }
    const code = report === null ? 1 : await finish(sync, report, { keep, reveal, deps });
    refreshTimer(ctx.vault, deps);
    return code;
  } finally {
    ctx.vault.close();
  }
}

/**
 * `kerstel sync --background`, started detached after a write and before
 * `run` or `exec` (§8.1). Nobody sees its output, so it prints nothing: the
 * result goes to `vault_meta` for `sync status` and `doctor`, and a conflict
 * is kept, never chosen (§8.4), for the line every command prints. When
 * another sync holds the lock, that one does the work.
 *
 * `--timer` marks a run the pull timer started. One that finds sync off
 * removes its own timer: `sync off` may not have been able to. One that finds
 * no vault file does nothing and keeps its timer: the home may be on a volume
 * that isn't mounted yet, and opening a vault there would create a vault and
 * a new key. `uninstall` and `sync off` remove the timer.
 *
 * Once the vault is open and syncs, the run installs a missing timer whatever
 * the sync's outcome, so a device whose server is briefly down still gets it.
 */
async function background(args: string[], deps: SyncDeps, open: () => Promise<CliContext>): Promise<number> {
  const fromTimer = args.includes("--timer");
  if (args.some((a) => a !== "--timer")) return 2;
  if (fromTimer && !existsSync(vaultPath())) return 0;
  const started = Date.now();
  const ctx = await open();
  try {
    if (ctx.vault.getMeta(SYNC_META.vaultId) === null) {
      if (fromTimer) removeTimer(deps);
      return 0;
    }
    if (fromTimer) {
      try {
        ctx.vault.setMeta(SYNC_META.lastTimer, String(started));
      } catch {
        // Only `sync status` reads it: never a reason to skip the pull.
      }
    }
    const code = await backgroundSync(ctx, deps, started);
    try {
      backgroundTimer(ctx.vault, deps);
    } catch {
      // The timer never changes what a sync returns.
    }
    return code;
  } finally {
    ctx.vault.close();
  }
}

/** The sync half of `background`: its exit code. */
async function backgroundSync(ctx: CliContext, deps: SyncDeps, started: number): Promise<number> {
  // Waits rather than leaving the work to the holder: it may have collected
  // its changes before the write that started this sync.
  const release = await waitForSyncLock(syncLockPath(ctx.vault.file), BACKGROUND_LOCK_WAIT_MS);
  if (!release) return 0;
  try {
    // Read after the wait: the holder may have replaced the key, or turned sync off.
    const sync = contextFor(ctx, deps);
    if (!sync) return 0;
    // A sync that finished after this one started, and left nothing to push, did its work.
    const lastTry = Number(ctx.vault.getMeta(SYNC_META.lastTry) ?? "0");
    const pending = ctx.vault.sync.rows().some((row) => row.dirty && row.conflict === null);
    if (lastTry >= started && !pending) return 0;
    await syncOnce(sync);
    recordResult(ctx.vault, null);
    return 0;
  } catch (error) {
    recordResult(ctx.vault, explain(error));
    return 1;
  } finally {
    release();
  }
}

/** A failed audit write must not turn a finished pairing or removal into a failure. */
function recordDevice(vault: Vault): void {
  try {
    vault.record("device", null);
  } catch (error) {
    process.stderr.write(`Could not write the audit row for this device change: ${explain(error)}\n`);
  }
}

/** Reports a sync, settles its conflicts, and pushes what was settled. The exit code. */
async function finish(
  sync: SyncContext,
  report: SyncReport,
  options: { keep: "local" | "remote" | null; reveal: boolean; deps: SyncDeps },
): Promise<number> {
  if (report.applied.length > 0) ok(`Pulled ${plural(report.applied.length, "change")} from your other devices.`);
  if (report.pushed.length > 0) ok(`Pushed ${plural(report.pushed.length, "change")}.`);
  for (const dir of report.backups) info(`Values a pull replaced are in the encrypted backup at ${dir}`);

  if (report.conflicts.length > 0) {
    const settled = await settleConflicts(sync, report, options);
    if (settled === null) {
      recordResult(sync.vault, null);
      return 1;
    }
    // Push what was kept here.
    try {
      const after = emptyReport();
      await push(sync, after);
      if (after.pushed.length > 0) ok(`Pushed ${plural(after.pushed.length, "settled value")}.`);
      // Another device may have changed a key again while you were choosing.
      const still = openConflicts(sync.vault);
      if (still.length > 0) {
        fail(`${plural(still.length, "key was", "keys were")} changed on another device again while you chose:`);
        for (const ref of still) console.log(`  ${describe(ref)}`);
        console.log(`Run ${cliName()} sync again to choose.`);
        recordResult(sync.vault, null);
        return 1;
      }
    } catch (error) {
      recordResult(sync.vault, explain(error));
      fail(`Sync failed: ${explain(error)}`);
      return 1;
    }
  }
  if (report.applied.length + report.pushed.length + report.conflicts.length === 0) ok("Up to date.");
  recordResult(sync.vault, null);
  return 0;
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
    const keep = options.keep;
    settle(sync, conflicts.map((ref) => ({ ref, keep })), report);
    ok(`Kept the ${options.keep === "local" ? "value on this device" : "other device's value"} for ${plural(conflicts.length, "conflict")}.`);
    return conflicts.length;
  }
  if (!isInteractive(options.deps)) {
    fail(`${plural(conflicts.length, "key was", "keys were")} changed on this device and another one:`);
    for (const ref of conflicts) console.log(`  ${describe(ref)}`);
    console.log(`Run ${cliName()} sync in a terminal to choose, or ${cliName()} sync --keep local|remote.`);
    return null;
  }
  const prompter = options.deps.prompter ?? new ClackPrompter();
  const shown = (value: string | null) =>
    value === null ? "deleted" : options.reveal ? value : `${plural(value.length, "character")}`;
  // Every answer first; then one backup of every losing value, then the changes.
  const choices: { ref: SecretRef; keep: "local" | "remote" }[] = [];
  const keptRevealed: number[] = [];
  for (const ref of conflicts) {
    const row = sync.vault.sync.row(ref)!;
    const local = sync.vault.getSecret(ref);
    const remote = conflictValue(sync, ref, row.conflict!);
    // --reveal puts values in the labels below: log the reveal before it is on screen.
    // One row per conflict, however many of its two values are shown.
    const revealRow = options.reveal && (local !== null || remote !== null) ? sync.vault.record("reveal", ref) : null;
    const answer = await prompter.select(
      `${bold(ref.key)} (${ref.scope}) was changed on this device and another one. Which value stays?`,
      [
        { value: "local", label: `This device (${shown(local)})` },
        { value: "remote", label: `The other device (${shown(remote)})` },
      ],
      "local",
    );
    choices.push({ ref, keep: answer as "local" | "remote" });
    if (revealRow !== null && answer === "remote" && remote !== null) keptRevealed.push(revealRow);
  }
  settle(sync, choices, report);
  // Keeping the other device's value rewrites the secret after the reveal was
  // logged. Move the row past that write, or the rotation hint would read the
  // revealed value as already changed.
  for (const id of keptRevealed) sync.vault.restampAudit(id);
  ok(`Settled ${plural(conflicts.length, "conflict")}. The value that lost is in the sync backup.`);
  return conflicts.length;
}

/** The `Pulls` value in `sync status`. */
function pullsLine(vault: Vault, deps: SyncDeps): string {
  const timer = timerStatus(deps);
  if (timer.state === "unavailable") return dim(`not scheduled (${timer.reason})`);
  if (timer.state === "missing") return yellow("not scheduled yet: added on the next sync");
  const last = vault.getMeta(SYNC_META.lastTimer);
  return `every 5 minutes (${timer.kind}), last ran ${when(last === null ? null : Number(last))}`;
}

async function status(args: string[], deps: SyncDeps, open: () => Promise<CliContext>): Promise<number> {
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
    console.log(`Pulls         ${pullsLine(ctx.vault, deps)}`);
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
      const name = verifiedName(sync.config.syncKey, sync.config.vaultId, d);
      // A name this key cannot open was sealed after a rotation elsewhere: a sync picks up the new key.
      // A name it opens whose keys differ from the listed ones is a real mismatch.
      const label = name
        ? `${name.name}${name.platform ? ` (${name.platform})` : ""}`
        : openName(sync.config.syncKey, sync.config.vaultId, d.id, d.sealedName)
          ? yellow("(unverified: its keys do not match its sealed name)")
          : dim(`(name sealed with a newer key: run ${cliName()} sync to read it)`);
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
      if (isUnknownDevice(error)) {
        // Already out of the vault: there is nothing to leave on the server.
        forgetSync(ctx.vault);
        removeTimer(deps);
        ok("This device was no longer in the synced vault. Sync is off for it; your secrets stay here.");
        return 0;
      }
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
    recordDevice(ctx.vault);
    forgetSync(ctx.vault);
    removeTimer(deps);
    ok(deleteVault ? "Deleted the vault on the server. Sync is off; your secrets stay here." : "Sync is off for this device. Your secrets stay here.");
    return 0;
  } finally {
    ctx.vault.close();
  }
}

/**
 * Sync spec §7.1, on a device already in the vault: open a pairing slot,
 * show its code, wait for the new device's answer, and add that device only
 * once someone here says yes. The answer is sealed with the code's secret, so
 * one the server wrote itself does not open.
 */
async function addDevice(args: string[], deps: SyncDeps, open: () => Promise<CliContext>): Promise<number> {
  if (args.length > 0) {
    fail(`Usage: ${cliName()} sync add-device`);
    return 2;
  }
  // The question cannot be answered ahead of time: there is no --yes for it.
  if (!isInteractive(deps)) {
    fail(`${cliName()} sync add-device asks you to confirm the new device, so it needs a terminal.`);
    return 2;
  }
  const ctx = await open();
  try {
    const sync = contextFor(ctx, deps);
    if (!sync) {
      notOn();
      return 1;
    }
    const secret = newPairingSecret();
    const pairingId = pairingIdOf(secret);
    try {
      // The key a new device receives must be the current one.
      await pull(sync, emptyReport());
      await sync.client.openPairing(pairingId);
    } catch (error) {
      fail(`Could not start pairing: ${explain(error)}`);
      return 1;
    }

    let added = false;
    /** False while the server may have added the device without saying so. */
    let settled = true;
    let answerId: string | null = null;
    try {
      console.log("On the new device, run:");
      console.log("");
      console.log(`  ${cliName()} sync join ${sync.config.server} ${pairingCode(secret)}`);
      console.log("");
      console.log(dim("The code works once and expires in 10 minutes. Waiting for the new device…"));

      const payload = await waitFor(async () => (await sync.client.readPairing(pairingId)).payload, POLL_MS.addDevice, deps);
      if (payload === null) {
        fail(`The code expired before a device used it. Run ${cliName()} sync add-device for a new one.`);
        return 1;
      }
      const answer = openPairingAnswer(secret, payload);
      if (!answer || !isId(answer.deviceId) || !isPublicKey(answer.signPub) || !isPublicKey(answer.encPub)) {
        fail("A device answered without this code's secret, so it was not added. Nothing was changed.");
        return 1;
      }
      answerId = answer.deviceId;
      const label = `${answer.name}${answer.platform ? ` (${answer.platform})` : ""}`;
      console.log(`New device: ${bold(label)}, key fingerprint ${fingerprint(answer.signPub)}`);
      const prompter = deps.prompter ?? new ClackPrompter();
      const choice = await prompter.select(
        "Add it? It will be able to read every secret in this vault.",
        [
          { value: "no", label: "No" },
          { value: "yes", label: "Yes, add it" },
        ],
        "no",
      );
      if (choice !== "yes") {
        info("The device was not added.");
        return 0;
      }

      const { vaultId, epoch, syncKey } = sync.config;
      const sealedKey = sealSyncKey(syncKey, answer.encPub, { vaultId, deviceId: answer.deviceId, epoch });
      // Past this point a failure may not mean the device was refused: the
      // server may have added it and lost the answer. The slot then holds the
      // confirmation the new device is waiting for, so it stays unless the
      // device is known not to be in the vault.
      settled = false;
      await sync.client.addDevice({
        device: {
          id: answer.deviceId,
          signPub: answer.signPub,
          encPub: answer.encPub,
          sealedName: sealName(syncKey, vaultId, answer.deviceId, {
            name: answer.name,
            platform: answer.platform,
            signPub: answer.signPub,
            encPub: answer.encPub,
          }),
        },
        epoch,
        sealedKey,
        pairingId,
        confirmation: pairingConfirmation(secret, { vaultId, deviceId: answer.deviceId, epoch, sealedKey }),
      });
      added = true;
      recordDevice(ctx.vault);
      ok(`Added ${label}. It pulls the vault as it finishes joining.`);
      return 0;
    } catch (error) {
      if (!settled) {
        const refused = error instanceof SyncHttpError && error.status >= 400 && error.status < 500;
        if (refused) settled = true;
        else {
          try {
            const listed = (await sync.client.devices()).devices.some((d) => d.id === answerId);
            if (listed) {
              added = true;
              recordDevice(ctx.vault);
              ok("Added the device. It pulls the vault as it finishes joining.");
              return 0;
            }
            settled = true;
          } catch {
            // Still unknown: leave the slot to expire, so a device that was added can finish joining.
          }
        }
      }
      if (error instanceof SyncHttpError && error.code === "epoch_mismatch") {
        fail(`The sync key changed while you were pairing. Run ${cliName()} sync add-device again.`);
      } else {
        fail(`Could not add the device: ${explain(error)}`);
      }
      return 1;
    } finally {
      // Declined, expired or refused: the slot goes, and the new device's wait ends.
      if (!added && settled) await sync.client.closePairing(pairingId).catch(() => undefined);
    }
  } finally {
    ctx.vault.close();
  }
}

/**
 * Sync spec §7.1 and §10, on the new device: answer the pairing slot, wait
 * for the other device to confirm, check that the sealed key is the one it
 * confirmed, then pull the vault and merge this vault's own secrets into it.
 */
async function join(args: string[], deps: SyncDeps, open: () => Promise<CliContext>): Promise<number> {
  if (args.length !== 2 || args.some((a) => a.startsWith("-"))) {
    fail(`Usage: ${cliName()} sync join <url> <code>`);
    return 2;
  }
  const server = normaliseServerUrl(args[0]!);
  if (!isSafeServerUrl(server)) {
    fail(`${args[0]} is not a server Kerstel will send your vault to. Use https://, or http:// to this machine.`);
    return 2;
  }
  const secret = parsePairingCode(args[1]!);
  if (!secret) {
    fail(`That is not a pairing code. Copy the whole KS-… code that ${cliName()} sync add-device shows.`);
    return 2;
  }

  const ctx = await open();
  try {
    if (loadSync(ctx.vault, ctx.dataKey)) {
      fail(`Sync is already on for this vault. To join another one, run ${cliName()} sync off first.`);
      return 1;
    }
    const keys = generateDeviceKeys();
    const deviceId = newId();
    const me = thisDevice(deps);
    const signPub = publicKeyOf(keys.sign);
    const pairingId = pairingIdOf(secret);
    const pairing = pairingClient(server, deps.fetch);
    try {
      await pairing.answer(
        pairingId,
        sealPairingAnswer(secret, { v: 1, deviceId, signPub, encPub: publicKeyOf(keys.enc), ...me }),
      );
    } catch (error) {
      if (error instanceof SyncHttpError && (error.code === "not_found" || error.code === "pairing_used")) {
        fail(`That code expired or was already used. Run ${cliName()} sync add-device on the other device for a new one.`);
      } else {
        fail(`Could not join: ${explain(error)}`);
      }
      return 1;
    }
    console.log(`This device: ${bold(me.name)}, key fingerprint ${fingerprint(signPub)}`);
    console.log(dim("Confirm it on the other device, and check that it shows the same fingerprint. Waiting…"));

    let accepted;
    try {
      accepted = await waitFor(
        async () => {
          const state = await pairing.state(pairingId);
          return state.state === "accepted" ? state : null;
        },
        POLL_MS.join,
        deps,
      );
    } catch (error) {
      fail(`Could not join: ${explain(error)}`);
      return 1;
    }
    if (!accepted) {
      fail("The code expired, or the other device said no. Nothing was changed.");
      return 1;
    }

    const client = syncClient({ server, vaultId: accepted.vaultId, deviceId, sign: keys.sign, fetch: deps.fetch, now: deps.now });
    let sealed;
    try {
      sealed = await client.keys();
    } catch (error) {
      fail(`Could not join: ${explain(error)}`);
      return 1;
    }
    // The other device made this HMAC with the code's secret over the key it
    // sealed. A key the server sealed itself, or a vault it swapped in, fails here.
    const expected = pairingConfirmation(secret, {
      vaultId: accepted.vaultId,
      deviceId,
      epoch: sealed.epoch,
      sealedKey: sealed.sealedKey,
    });
    if (!same(Buffer.from(expected), Buffer.from(String(accepted.confirmation ?? "")))) {
      fail(
        "The key the server sent is not the one the other device confirmed, so this device did not join and nothing " +
          `was saved. On the other device, remove this one (${cliName()} sync remove-device "${me.name}"), then pair again. ` +
          "If it happens again, do not trust this server.",
      );
      return 1;
    }
    const config: SyncConfig = {
      server,
      vaultId: accepted.vaultId,
      deviceId,
      epoch: sealed.epoch,
      syncKey: openSyncKey(sealed.sealedKey, keys.enc, { vaultId: accepted.vaultId, deviceId, epoch: sealed.epoch }),
      keys,
      head: 0,
    };
    // One transaction: the settings, every secret here marked to merge, and a
    // full pull owed. An interrupted join finishes on the next sync.
    ctx.vault.transaction(() => {
      writeSync(ctx.vault, ctx.dataKey, config);
      ctx.vault.sync.trackAll();
      setFullPull(ctx.vault, true);
    });
    recordDevice(ctx.vault);
    ok(`Joined the vault on ${server}.`);

    const sync: SyncContext = { vault: ctx.vault, dataKey: ctx.dataKey, config, client };
    let report: SyncReport | null = null;
    try {
      report = await syncOnce(sync);
    } catch (error) {
      recordResult(ctx.vault, explain(error));
      fail(`The first sync failed: ${explain(error)}. Run ${cliName()} sync to finish it.`);
    }
    const code = report === null ? 1 : await finish(sync, report, { keep: null, reveal: false, deps });
    // The device has joined either way: its pulls finish a first sync that failed.
    schedule(ctx.vault, deps);
    return code;
  } finally {
    ctx.vault.close();
  }
}

/** Sync spec §7.3: remove another device, which replaces the sync key. */
async function removeDevice(args: string[], deps: SyncDeps, open: () => Promise<CliContext>): Promise<number> {
  if (args.length !== 1 || args[0]!.startsWith("-")) {
    fail(`Usage: ${cliName()} sync remove-device <name>`);
    return 2;
  }
  const wanted = args[0]!;
  const ctx = await open();
  try {
    const sync = contextFor(ctx, deps);
    if (!sync) {
      notOn();
      return 1;
    }
    const report = emptyReport();
    let list;
    try {
      // Names are sealed with the current key: after a rotation elsewhere, only a pull can read them.
      await pull(sync, report);
      list = (await sync.client.devices()).devices;
    } catch (error) {
      recordResult(ctx.vault, explain(error));
      fail(`Could not list devices: ${explain(error)}`);
      return 1;
    }
    // A name, or a fingerprint for two devices with the same name.
    const compact = (s: string) => s.replace(/\s/g, "").toUpperCase();
    const matches = list
      .map((d) => ({ device: d, name: verifiedName(sync.config.syncKey, sync.config.vaultId, d) }))
      .filter((d) => d.name?.name === wanted || compact(fingerprint(d.device.signPub)) === compact(wanted));
    if (matches.length === 0) {
      fail(`No device in this vault is called "${wanted}". Run ${cliName()} sync devices to see their names.`);
      return 1;
    }
    if (matches.length > 1) {
      fail(`${matches.length} devices are called "${wanted}". Name one by its fingerprint, from ${cliName()} sync devices.`);
      return 1;
    }
    const target = matches[0]!;
    if (target.device.id === sync.config.deviceId) {
      fail(`That is this device. To stop syncing it, run ${cliName()} sync off.`);
      return 1;
    }

    const fp = fingerprint(target.device.signPub);
    const label = target.name ? `${target.name.name} (${fp})` : fp;
    try {
      await rotateKey(sync, [target.device.id], report);
      // Changes made here before the rotation go out under the new key.
      await push(sync, report);
    } catch (error) {
      recordResult(ctx.vault, explain(error));
      fail(`Could not remove ${label}: ${explain(error)}`);
      return 1;
    }
    recordResult(ctx.vault, null);
    recordDevice(ctx.vault);
    if (report.applied.length > 0) ok(`Pulled ${plural(report.applied.length, "change")} from your other devices.`);
    ok(`Removed ${label} and replaced the sync key. Your other devices pick up the new key on their next sync.`);
    console.log(
      yellow(
        `${label} already had every value in this vault. Rotate any secret it should no longer hold, at its provider: ` +
          "Kerstel cannot do that for you.",
      ),
    );
    return 0;
  } finally {
    ctx.vault.close();
  }
}
