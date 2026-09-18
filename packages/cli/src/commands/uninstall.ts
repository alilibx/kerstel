import { accessSync, constants, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openExistingVault } from "../context";
import { connectDaemon, isDaemonRunning } from "../daemon/client";
import { isCompiledBinary } from "../daemon/spawn";
import { TtyPrompter, type Prompter } from "../init/prompts";
import { renderDiff } from "../init/wiring";
import { bold, fail, info, ok, yellow } from "../output";
import { kerstelHome } from "../paths";
import { emptyPlan, hasLoss, planUninstall, type RestoredProject, type UninstallPlan } from "../uninstall/plan";

/**
 * Plan-5 spec §6. Three phases: plan (read only), show and gate, then apply:
 * every project file first, and only once all of them are written, the
 * daemon, the data key, ~/.kerstel, and the binary.
 */

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
    else return { error: `Unknown option "${arg}". kerstel uninstall accepts: --dry-run, --yes, --force.` };
  }
  return options;
}

function printPlan(plan: UninstallPlan): void {
  console.log(bold("kerstel uninstall"));
  if (plan.files.length === 0) info("No project files need restoring.");
  for (const file of plan.files) {
    console.log("");
    console.log(renderDiff(file.label, file.diffBefore, file.diffAfter));
  }

  // Names and references only. Values never reach the terminal.
  if (plan.unreachable.length > 0) {
    console.log("");
    console.log(yellow("!  Projects Kerstel cannot reach, whose references stay as they are:"));
    for (const p of plan.unreachable) info(`${p.name} at ${p.rootPath}: ${p.reason}`);
  }
  if (plan.unresolvable.length > 0) {
    console.log("");
    console.log(yellow("!  References the vault cannot resolve, which stay as they are:"));
    for (const r of plan.unresolvable) info(`${r.reference} in ${r.file}`);
  }
  if (plan.unused.length > 0) {
    console.log("");
    console.log(yellow("!  Secrets no reachable project uses, which would be deleted with the vault:"));
    for (const reference of plan.unused) info(reference);
  }
  if (plan.backupOnly.length > 0) {
    console.log("");
    console.log(yellow("!  Values init kept only in its encrypted backup, which would be deleted with it:"));
    for (const b of plan.backupOnly) {
      info(`${b.project}: ${b.key} in ${b.files.join(", ")} (backup ${b.backupDir})`);
    }
  }
}

async function stopDaemonIfRunning(): Promise<void> {
  if (!(await isDaemonRunning())) return;
  const client = await connectDaemon();
  await client.shutdown();
  client.close();
  // shutdown() returns once the request is sent, not once the daemon has let
  // go of the vault and socket. Deleting the home under a daemon still
  // writing to it could leave a stray socket or vault file behind.
  for (let waited = 0; waited < 5000 && (await isDaemonRunning()); waited += 100) {
    await Bun.sleep(100);
  }
  ok("Stopped the Kerstel daemon.");
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
  if (existing.vault) {
    try {
      plan = planUninstall(existing.vault, existing.key);
    } finally {
      existing.vault.close();
    }
  } else {
    orphanedKey = await existing.backend.exists();
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
        "`kerstel get <scope>/<KEY> --reveal`. A value kept only in the backup cannot be read back " +
        "through the CLI: if you still need it, recover it from where it came from. Then re-run with --force.",
    );
    return 1;
  }

  if (!options.yes) {
    const prompter = prompterOverride ?? (process.stdin.isTTY === true ? new TtyPrompter() : null);
    if (!prompter) {
      fail("kerstel uninstall asks for confirmation, and this is not a terminal. Re-run with --yes.");
      return 2;
    }
    try {
      const go = await prompter.confirm("Restore these files and delete Kerstel from this machine?", false);
      if (!go) {
        info("Nothing was changed.");
        return 0;
      }
    } finally {
      if (prompter !== prompterOverride && prompter instanceof TtyPrompter) prompter.close();
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
  await stopDaemonIfRunning();
  const home = kerstelHome();
  rmSync(home, { recursive: true, force: true });
  ok(`Deleted ${home}.`);
  if (existing.vault || orphanedKey) {
    await existing.backend.delete();
    // The backends run the platform's delete tool without checking its exit
    // code, so a denied Keychain prompt would pass silently. Check the result.
    if (await existing.backend.exists()) {
      fail(
        `Could not delete the vault key from the ${existing.backend.name} credential store. ` +
          "Everything else is gone; run `kerstel uninstall` again to retry, or delete the key by hand.",
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
    rmSync(binary.path, { force: true });
    ok(`Removed ${binary.path}.`);
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
