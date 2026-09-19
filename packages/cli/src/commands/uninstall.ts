import { accessSync, constants, lstatSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openExistingVault } from "../context";
import { stopDaemonIfRunning } from "../daemon/client";
import { isCompiledBinary } from "../daemon/spawn";
import { CancelledError, ClackPrompter, type Prompter } from "../init/prompts";
import { renderDiff } from "../init/wiring";
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

/**
 * Removes `<dirname(binaryPath)>/ks` when, and only when, it is a symlink
 * that resolves to the binary being removed. Both sides go through
 * `realpathSync` before comparing: on macOS `/tmp` (and the test runner's own
 * tmpdir) is a symlink into `/private/tmp`, so a bare string comparison of
 * the raw resolved target against `binaryPath` would false-negative even for
 * a link this installer created.
 *
 * Callers must invoke this BEFORE deleting `binaryPath` -- `realpathSync` on
 * an already-deleted binary throws, which would turn a real link into a
 * false "not-ours".
 */
export function removeShortcut(binaryPath: string): "removed" | "absent" | "not-ours" {
  const link = join(dirname(binaryPath), "ks");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(link);
  } catch {
    return "absent";
  }
  if (!stat.isSymbolicLink()) return "not-ours";

  try {
    const target = realpathSync(resolve(dirname(link), readlinkSync(link)));
    if (target !== realpathSync(binaryPath)) return "not-ours";
  } catch {
    // A dangling link (or an unreadable binary) is never ours to remove.
    return "not-ours";
  }

  rmSync(link);
  return "removed";
}

function printPlan(plan: UninstallPlan): void {
  printBanner(theme, VERSION);
  if (plan.files.length === 0) info("No project files need restoring.");

  for (const project of plan.restored) {
    const prefix = `${project.name}: `;
    const diffs = plan.files.filter((file) => file.label.startsWith(prefix));
    if (diffs.length === 0) continue;
    const lines: string[] = [];
    for (const file of diffs) {
      if (lines.length > 0) lines.push("");
      lines.push(...renderDiff(file.label.slice(prefix.length), file.diffBefore, file.diffAfter).split("\n"));
    }
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
    "Values init kept only in its encrypted backup, which would be deleted with it:",
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

export async function uninstallCommand(
  args: string[],
  prompterOverride?: Prompter,
  binary: { path: string; compiled: boolean } = { path: process.execPath, compiled: isCompiledBinary() },
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
  // With no vault, a key left in the credential store is an orphan: nothing
  // it could decrypt remains, so a real run deletes it. exists() is read-only.
  let orphanedKey = false;
  const ownsKey = keyBelongsToHome(existing.backend.name);
  if (existing.vault) {
    try {
      plan = planUninstall(existing.vault, existing.key);
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

  printPlan(plan);
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
  }

  // Phase 1: project files. Nothing below runs unless every one is written.
  //
  // Checked up front, before any file is touched: a write failing partway
  // through would restore some files but not others, and a re-run would then
  // see the already-restored files as no longer referencing their secrets --
  // tripping the loss gate on secrets that were never actually lost. Failing
  // here instead means either every file is written, or none is.
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

  // Phase 2: Kerstel itself. ~/.kerstel goes before the credential-store key:
  // a leftover key with no vault is harmless, but a keyless vault would block
  // every re-run if the key delete happened first and this one failed after.
  if (await stopDaemonIfRunning()) ok("Stopped the Kerstel daemon.");
  const home = kerstelHome();
  rmSync(home, { recursive: true, force: true });
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
    // The shortcut check has to run before the binary is gone: it
    // realpath()s binary.path, which throws once nothing is there to
    // resolve.
    const shortcut = removeShortcut(binary.path);
    rmSync(binary.path, { force: true });
    ok(`Removed ${binary.path}.`);
    if (shortcut === "removed") ok(`Removed ${join(dirname(binary.path), "ks")}.`);
  } else {
    info(`Running from source, so ${binary.path} was left in place.`);
  }

  console.log("");
  for (const project of plan.restored) ok(`Restored ${project.name} (${project.rootPath}).`);
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
