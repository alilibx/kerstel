import { accessSync, constants, existsSync, lstatSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { LAUNCHER_RELATIVE_PATH } from "../init/launcher";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { openExistingVault } from "../context";
import { stopDaemonIfRunning } from "../daemon/client";
import { isCompiledBinary } from "../daemon/spawn";
import { CancelledError, ClackPrompter, type Prompter } from "../init/prompts";
import { renderDiff } from "../init/wiring";
import { SyncHttpError, type Fetch, type SyncClient } from "../sync/http";
import { syncTimer, type SyncTimer } from "../sync/timer";
import { loadSync, shownAddress, SYNC_META } from "../sync/state";
import { syncLockPath, waitForSyncLock } from "../sync/background";
import { clientFor, LOCK_WAIT_MS } from "./sync";
import { manageLine, removeServerKeepingData, serverPlace, type SyncServerDeps } from "./sync-server";
import { readInstallRecord } from "../sync/install-record";
import { fail, info, ok, yellow } from "../output";
import { kerstelHome } from "../paths";
import { emptyPlan, hasLoss, planUninstall, type RestoredProject, type UninstallPlan } from "../uninstall/plan";
import { printBanner } from "../ui/banner";
import { cliName } from "../ui/cli-name";
import { step } from "../ui/steps";
import { theme } from "../ui/theme";
import { VERSION } from "../version";

/**
 * Plan-5 spec §6. Three phases: plan (read only), show and gate, then apply:
 * every project file first, and only once all of them are written, the
 * daemon, the data key, ~/.kerstel, and the binary.
 */

/**
 * Whether the vault key belongs to this home alone, and so is uninstall's to
 * delete. The file backend keeps the key inside the home. The native stores
 * keep it in ONE machine-wide item (`serviceName()`), shared by every home on
 * the machine: under a custom KERSTEL_HOME it may be the key that the real
 * ~/.kerstel depends on, and deleting it would make that vault unreadable.
 * A rebound service name (KERSTEL_KEYCHAIN_SERVICE) is a slot of its own.
 */
export function keyBelongsToHome(backendName: string): boolean {
  if (backendName === "file") return true;
  if (process.env.KERSTEL_KEYCHAIN_SERVICE) return true;
  return resolve(kerstelHome()) === resolve(join(homedir(), ".kerstel"));
}

export interface UninstallOptions {
  dryRun: boolean;
  yes: boolean;
  force: boolean;
}

export function parseUninstallArgs(args: string[]): UninstallOptions | { error: string } {
  const options: UninstallOptions = { dryRun: false, yes: false, force: false };
  for (const arg of args) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--force") options.force = true;
    else return { error: `Unknown option "${arg}". ${cliName()} uninstall accepts: --dry-run, --yes, --force.` };
  }
  return options;
}

export interface LinkSearch {
  /**
   * The path the binary was invoked through (`process.argv0`). Bun resolves
   * symlinks into `process.execPath`, so this is the only record of the folder
   * the user's `kerstel` link lives in when that folder is not on PATH.
   */
  invokedAs?: string;
  /** Folders to search for links, `PATH` split on the platform delimiter by default. */
  pathDirs?: string[];
}

/** The names install.sh creates: the binary or a link to it, and the shortcut. */
const LINK_NAMES = ["kerstel", "ks"] as const;

export interface LinkSweep {
  /** `binaryPath` with every symlink resolved: the file to delete once the links are gone. */
  target: string;
  removed: string[];
  /** Links that resolve to the binary but could not be deleted, with the OS's reason. */
  failed: { path: string; reason: string }[];
}

/**
 * Removes every `kerstel` and `ks` symlink that resolves to `binaryPath`, in
 * the binary's own folder, the folder it was invoked from, and every folder
 * on PATH.
 *
 * Only symlinks that resolve to THIS binary go. A `ks` that is a real file,
 * or a link to something else, or a dangling link, belongs to someone else
 * and stays. Both sides go through `realpathSync` before comparing: on macOS
 * `/tmp` (and the test runner's own tmpdir) is a symlink into `/private/tmp`,
 * so a bare string comparison would false-negative even for a link this
 * installer created.
 *
 * Every candidate is resolved BEFORE anything is deleted. `ks -> kerstel` is
 * relative to a `kerstel` that may itself be a link; delete that link first
 * and `ks` dangles, resolves to nothing, and would be kept as "not ours".
 *
 * A link that cannot be deleted (a folder on PATH that root owns, say) is
 * reported rather than thrown: by the time this runs the vault is gone, and
 * an exception here would leave the binary in place with nothing to open.
 *
 * Callers must invoke this BEFORE deleting the binary -- `realpathSync` on
 * an already-deleted binary throws, which would turn every real link into a
 * false "not ours". Returns null when `binaryPath` does not resolve.
 */
export function removeLinks(binaryPath: string, search: LinkSearch): LinkSweep | null {
  let target: string;
  try {
    target = realpathSync(binaryPath);
  } catch {
    return null;
  }

  const pathDirs = search.pathDirs ?? (process.env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
  // Keyed by real path, so one folder reached two ways -- `~/.local/bin` and
  // `~/.local/bin/`, or `/tmp` and `/private/tmp` -- is scanned once. Scanned
  // twice, its links would be collected twice, removed once, and the second
  // attempt reported as a failure.
  const folders = new Map<string, string>();
  const addFolder = (dir: string): void => {
    const absolute = resolve(dir);
    let key = absolute;
    try {
      key = realpathSync(absolute);
    } catch {
      // A folder that does not exist has no links in it; keep it so the
      // lstat below finds nothing, rather than guessing here.
    }
    if (!folders.has(key)) folders.set(key, absolute);
  };
  addFolder(dirname(binaryPath));
  // A bare `ks` (found through PATH) says nothing about its folder, but
  // `./bin/ks` or `/opt/kerstel/ks` does, relative to the cwd or not.
  const invoked = search.invokedAs;
  if (invoked && (invoked.includes("/") || invoked.includes(sep))) addFolder(dirname(invoked));
  for (const dir of pathDirs) addFolder(dir);

  const ours: string[] = [];
  for (const folder of folders.values()) {
    for (const name of LINK_NAMES) {
      const link = join(folder, name);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(link);
      } catch {
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      try {
        if (realpathSync(link) === target) ours.push(link);
      } catch {
        // A dangling link, or one through a folder we cannot read: never ours.
      }
    }
  }

  const removed: string[] = [];
  const failed: LinkSweep["failed"] = [];
  for (const link of ours) {
    try {
      rmSync(link);
      removed.push(link);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      failed.push({ path: link, reason: code ?? (error instanceof Error ? error.message : String(error)) });
    }
  }
  return { target, removed, failed };
}

function printPlan(plan: UninstallPlan): void {
  printBanner(theme, VERSION);
  if (plan.files.length === 0) info("No project files need restoring.");

  for (const project of plan.restored) {
    const prefix = `${project.name}: `;
    const diffs = plan.files.filter((file) => file.label.startsWith(prefix));
    const lines: string[] = [];
    for (const file of diffs) {
      if (lines.length > 0) lines.push("");
      lines.push(...renderDiff(file.label.slice(prefix.length), file.diffBefore, file.diffAfter).split("\n"));
    }
    for (const launcher of plan.launchers.filter((entry) => entry.project === project.name)) {
      if (lines.length > 0) lines.push("");
      lines.push(`${LAUNCHER_RELATIVE_PATH} is deleted (${launcher.path})`);
    }
    if (lines.length === 0) continue;
    step(project.name, lines);
  }

  // Names and references only. Values never reach the terminal.
  const lost: string[] = [];
  const section = (header: string, items: string[]): void => {
    if (items.length === 0) return;
    if (lost.length > 0) lost.push("");
    lost.push(header, ...items);
  };
  section(
    "Projects Kerstel cannot reach, whose references stay as they are:",
    plan.unreachable.map((p) => `${p.name} at ${p.rootPath}: ${p.reason}`),
  );
  section(
    "References the vault cannot resolve, which stay as they are:",
    plan.unresolvable.map((r) => `${r.reference} in ${r.file}`),
  );
  section("Secrets no reachable project uses, which would be deleted with the vault:", plan.unused);
  section(
    `Values kept only in an encrypted backup of init or ${cliName()} move, which would be deleted with it:`,
    plan.backupOnly.map((b) => `${b.project}: ${b.key} in ${b.files.join(", ")} (backup ${b.backupDir})`),
  );
  section(
    "Backups Kerstel cannot read, which may hold values kept nowhere else:",
    plan.unreadableBackups.map((b) => `${b.project}: ${b.backupDir} (${b.reason})`),
  );
  if (lost.length > 0) step("Would be lost", lost.map(yellow));
}

/**
 * The restored env files git already tracks, by name, or null when git is not
 * installed or `root` is not inside a repository. A .gitignore entry does not
 * untrack a tracked file, and `init` encourages committing reference-only ones.
 */
function gitTrackedEnvFiles(project: RestoredProject): string[] | null {
  if (project.envFiles.length === 0) return [];
  try {
    const result = Bun.spawnSync(["git", "-C", project.rootPath, "ls-files", "--", ...project.envFiles], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return null;
    const tracked = new Set(result.stdout.toString().split("\n").filter((line) => line !== ""));
    return project.envFiles.filter((name) => tracked.has(name));
  } catch {
    return null;
  }
}

/** The synced vault this device leaves: one client for every request, so a server's addresses are tried once. */
interface SyncedVault {
  client: SyncClient;
  /** The server's address to name before one has answered: the one that answered last, or the first. */
  shown: string;
}

async function deviceCount(synced: SyncedVault): Promise<number | null> {
  try {
    return (await synced.client.devices()).devices.length;
  } catch {
    return null;
  }
}

/**
 * Removes this device from its synced vault, or deletes the vault when asked.
 * Never stops the uninstall: a server that is gone for good must not keep
 * Kerstel installed, so a failure is reported with what to do instead.
 */
async function leaveSyncedVault(synced: SyncedVault, deleteRemote: boolean): Promise<void> {
  const { client } = synced;
  const server = () => client.address() ?? synced.shown;
  try {
    if (deleteRemote) {
      await client.deleteVault();
      ok(`Deleted the synced vault from ${server()}.`);
    } else {
      await client.removeSelf();
      ok(`Removed this device from the synced vault on ${server()}.`);
    }
  } catch (error) {
    if (error instanceof SyncHttpError && error.code === "last_device") {
      info(
        `The synced vault stays on ${server()}, encrypted, and no device can read it now. ` +
          "Delete it on the server if you no longer need it.",
      );
      return;
    }
    console.log(
      yellow(
        `Could not leave the synced vault on ${server()}: ${(error as Error).message.replace(/\.$/, "")}. ` +
          `Remove this device from another one with \`${cliName()} sync remove-device <name>\`.`,
      ),
    );
  }
}

export async function uninstallCommand(
  args: string[],
  prompterOverride?: Prompter,
  binary: { path: string; compiled: boolean } & LinkSearch = {
    path: process.execPath,
    compiled: isCompiledBinary(),
    invokedAs: process.argv0,
  },
  /** For tests: how the sync server is reached, the timer, how long to wait for the sync lock, and where an installed server runs. */
  syncDeps: { fetch?: Fetch; now?: () => number; timer?: SyncTimer; lockWaitMs?: number; hostFor?: SyncServerDeps["hostFor"] } = {},
): Promise<number> {
  const options = parseUninstallArgs(args);
  if ("error" in options) {
    fail(options.error);
    return 2;
  }

  // Read-only: never creates ~/.kerstel, a hook install, a token, or a vault
  // key. A --dry-run, a declined prompt, or a loss-gate refusal must be able
  // to touch nothing, and this machine may genuinely have no vault yet.
  const existing = await openExistingVault();
  let plan: UninstallPlan;
  // A synced device leaves the vault on the server before its keys are deleted. Sync spec §7.3.
  let synced: SyncedVault | null = null;
  // With no vault, a key left in the credential store is an orphan: nothing
  // it could decrypt remains, so a real run deletes it. exists() is read-only.
  let orphanedKey = false;
  const ownsKey = keyBelongsToHome(existing.backend.name);
  if (existing.vault) {
    try {
      plan = planUninstall(existing.vault, existing.key);
      try {
        const config = loadSync(existing.vault, existing.key);
        if (config) {
          synced = {
            client: clientFor(config, syncDeps),
            shown: shownAddress(config.servers, existing.vault.getMeta(SYNC_META.lastAddress)),
          };
        }
      } catch {
        // Settings too broken to load have no device to remove either.
      }
    } finally {
      existing.vault.close();
    }
  } else {
    orphanedKey = ownsKey && (await existing.backend.exists());
    info(
      orphanedKey
        ? `Kerstel has no vault on this machine, but the ${existing.backend.name} credential store still holds its key.`
        : "Kerstel has no data on this machine.",
    );
    plan = emptyPlan();
  }

  // The sync server this device installed, if any. Other devices may still use it.
  const server = readInstallRecord();

  printPlan(plan);
  const timer = syncDeps.timer ?? syncTimer();
  let timerInstalled = false;
  try {
    timerInstalled = timer.status().state === "installed";
  } catch {
    // An unreadable timer is not a reason to stop.
  }
  if (timerInstalled) info("Removes the scheduled sync pull.");
  if (synced) info(`This device leaves the synced vault on ${synced.shown} first.`);
  if (server) info(`Asks whether to also remove the sync server on ${serverPlace(server)}.`);
  console.log("");

  if (options.dryRun) {
    info("--dry-run: nothing was written or deleted.");
    return 0;
  }

  if (hasLoss(plan) && !options.force) {
    fail(
      "Uninstalling now would lose the secrets and values listed above. Save each secret first with " +
        `\`${cliName()} get <scope>/<KEY> --reveal\`. A value kept only in the backup cannot be read back ` +
        "through the CLI: if you still need it, recover it from where it came from. Then re-run with --force.",
    );
    return 1;
  }

  // --yes never deletes the server's copy, nor removes the server: that takes a person saying so.
  let deleteRemote = false;
  let removeServer = false;
  if (!options.yes) {
    const prompter = prompterOverride ?? (process.stdin.isTTY === true ? new ClackPrompter() : null);
    if (!prompter) {
      fail(`${cliName()} uninstall asks for confirmation, and this is not a terminal. Re-run with --yes.`);
      return 2;
    }
    let answer: "yes" | "no";
    try {
      answer = await prompter.select(
        "Restore these files and delete Kerstel from this machine?",
        [
          { value: "no", label: "No, keep Kerstel" },
          { value: "yes", label: "Yes, restore and delete" },
        ],
        "no",
      );
    } catch (error) {
      if (error instanceof CancelledError) {
        fail(error.message);
        return 130;
      }
      throw error;
    }
    if (answer !== "yes") {
      info("Nothing was changed.");
      return 0;
    }
    if (synced && (await deviceCount(synced)) === 1) {
      try {
        const remove = await prompter.select(
          `This is the last device in the synced vault on ${synced.client.address() ?? synced.shown}. Delete the vault from the server too?`,
          [
            { value: "no", label: "No, leave it on the server" },
            { value: "yes", label: "Yes, delete it from the server" },
          ],
          "no",
        );
        deleteRemote = remove === "yes";
      } catch (error) {
        if (error instanceof CancelledError) {
          fail(error.message);
          return 130;
        }
        throw error;
      }
    }
    if (server) {
      try {
        const remove = await prompter.select(
          `Also remove the sync server on ${serverPlace(server)}? Other devices may still use it.`,
          [
            { value: "no", label: "No, keep it running" },
            { value: "yes", label: "Yes, remove it and keep its database" },
          ],
          "no",
        );
        removeServer = remove === "yes";
      } catch (error) {
        if (error instanceof CancelledError) {
          fail(error.message);
          return 130;
        }
        throw error;
      }
    }
  }

  // Phase 1: project files. Nothing below runs unless every one is written.
  //
  // Checked up front, before any file is touched: a write failing partway
  // through would restore some files but not others, and a re-run would then
  // see the already-restored files as no longer referencing their secrets --
  // tripping the loss gate on secrets that were never actually lost. Failing
  // here instead means either every file is written, or none is.
  for (const launcher of plan.launchers) {
    try {
      accessSync(dirname(launcher.path), constants.W_OK);
    } catch {
      fail(
        `Cannot delete ${launcher.path}: its directory is not writable. Kerstel is still installed and nothing was ` +
          "written. Fix the permissions and re-run.",
      );
      return 1;
    }
  }
  for (const file of plan.files) {
    try {
      accessSync(file.path, constants.W_OK);
    } catch {
      fail(
        `Cannot write ${file.path}: it is not writable. Kerstel is still installed and nothing was ` +
          "written. Fix the file's permissions and re-run.",
      );
      return 1;
    }
  }

  const written: string[] = [];
  for (const file of plan.files) {
    try {
      writeFileSync(file.path, file.after);
      written.push(file.path);
    } catch (error) {
      fail(
        `Could not write ${file.path} (${(error as Error).message}). Kerstel is still installed and ` +
          "nothing was deleted. A re-run will list this project's secrets as unused, because the " +
          "restored files no longer reference them. Once you have confirmed they are saved, re-run with --force.",
      );
      if (written.length > 0) info(`Already restored: ${written.join(", ")}`);
      return 1;
    }
  }

  // The launcher goes once every restored file is written: a script no longer
  // names it, so nothing runs through it any more.
  for (const launcher of plan.launchers) {
    rmSync(launcher.path, { force: true });
    try {
      rmdirSync(dirname(launcher.path));
    } catch {
      // Not empty, or already gone: either way it is the user's directory now.
    }
  }

  if (synced) await leaveSyncedVault(synced, deleteRemote);
  // After leaving the vault, which needs the server. Like leaving, a failure
  // never stops the uninstall; the record goes with the home either way.
  if (server && !(removeServer && (await removeServerKeepingData(server, { hostFor: syncDeps.hostFor })))) {
    info(manageLine(server));
  }
  const home = kerstelHome();
  // A background sync installs a missing timer only under the sync lock, and
  // only while the vault is there. Held from the timer's removal until the
  // home is gone, so no sync finishing meanwhile brings the timer back. A sync
  // that keeps it past the wait does not keep Kerstel installed.
  const lock = syncLockPath(join(home, "vault.db"));
  const held = existsSync(home) ? await waitForSyncLock(lock, syncDeps.lockWaitMs ?? LOCK_WAIT_MS) : null;
  const releaseLock = () => {
    try {
      held?.();
    } catch {
      // Its file went with the home, so the commit fails; the close after it still frees the lock.
    }
  };
  try {
    try {
      timer.remove();
    } catch {
      // A pull timer that will not go must not keep Kerstel installed.
    }

    // Phase 2: Kerstel itself. ~/.kerstel goes before the credential-store key:
    // a leftover key with no vault is harmless, but a keyless vault would block
    // every re-run if the key delete happened first and this one failed after.
    if (await stopDaemonIfRunning({ settle: true })) ok("Stopped the Kerstel daemon.");
    // Windows can't delete a file that is open. It has no pull timer to guard.
    if (process.platform === "win32") releaseLock();
    // Retried: a process that still had a file open in the home (a daemon
    // stopped by hand a moment ago, an editor) can make one pass fail with
    // ENOTEMPTY or EBUSY. Checked: `force` would otherwise hide that.
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } finally {
    releaseLock();
  }
  if (existsSync(home)) {
    fail(`Could not delete ${home}: something still has files open in it. Close it, then run uninstall again.`);
    return 1;
  }
  ok(`Deleted ${home}.`);
  if (existing.vault && !ownsKey) {
    info(
      `Left the vault key in the ${existing.backend.name} credential store: every Kerstel home on this ` +
        `machine shares it, and ${home} is not the default ~/.kerstel. Delete it by hand once no vault needs it.`,
    );
  } else if (existing.vault || orphanedKey) {
    await existing.backend.delete();
    // The backends run the platform's delete tool without checking its exit
    // code, so a denied Keychain prompt would pass silently. Check the result.
    if (await existing.backend.exists()) {
      fail(
        `Could not delete the vault key from the ${existing.backend.name} credential store. ` +
          `Everything else is gone; run \`${cliName()} uninstall\` again to retry, or delete the key by hand.`,
      );
      return 1;
    }
    ok(
      existing.vault
        ? `Deleted the vault key from the ${existing.backend.name} credential store.`
        : `Deleted the orphaned vault key from the ${existing.backend.name} credential store.`,
    );
  }

  if (binary.compiled) {
    // The link sweep has to run before the binary is gone: it realpath()s
    // binary.path, which throws once nothing is there to resolve.
    const sweep = removeLinks(binary.path, binary);
    // The resolved target, not binary.path: were binary.path itself a link,
    // the sweep would have taken it and the real binary would survive.
    const file = sweep?.target ?? binary.path;
    rmSync(file, { force: true });
    ok(`Removed ${file}.`);
    for (const link of sweep?.removed ?? []) ok(`Removed ${link}.`);
    for (const { path, reason } of sweep?.failed ?? []) {
      console.log(yellow(`!  Could not remove ${path} (${reason}). It now points at nothing; delete it by hand.`));
    }
  } else {
    info(`Running from source, so ${binary.path} was left in place.`);
  }

  console.log("");
  for (const project of plan.restored) ok(`Restored ${project.name} (${project.rootPath}).`);
  for (const launcher of plan.foreignLaunchers) {
    console.log(yellow(`!  ${launcher.path} is not Kerstel's, so it was left alone.`));
  }
  if (plan.restored.some((project) => project.envFiles.length > 0)) {
    console.log(
      yellow("!  Those .env files hold plaintext secrets again. Keep them out of git: check your .gitignore."),
    );
    for (const project of plan.restored) {
      for (const name of gitTrackedEnvFiles(project) ?? []) {
        console.log(
          yellow(
            `!  ${join(project.rootPath, name)} is tracked by git, and .gitignore does not untrack it. ` +
              `Run \`git rm --cached ${name}\` in ${project.rootPath} before your next commit.`,
          ),
        );
      }
    }
  }
  return 0;
}
