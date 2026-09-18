import { rmSync, writeFileSync } from "node:fs";
import { openContext } from "../context";
import { connectDaemon, isDaemonRunning } from "../daemon/client";
import { isCompiledBinary } from "../daemon/spawn";
import { TtyPrompter, type Prompter } from "../init/prompts";
import { renderDiff } from "../init/wiring";
import { bold, fail, info, ok, yellow } from "../output";
import { kerstelHome } from "../paths";
import { hasLoss, planUninstall, type UninstallPlan } from "../uninstall/plan";
import { selectBackend } from "../vault/keychain";

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
}

async function stopDaemonIfRunning(): Promise<void> {
  if (!(await isDaemonRunning())) return;
  const client = await connectDaemon();
  await client.shutdown();
  client.close();
  ok("Stopped the Kerstel daemon.");
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

  const ctx = await openContext();
  let plan: UninstallPlan;
  try {
    plan = planUninstall(ctx.vault);
  } finally {
    ctx.vault.close();
  }

  printPlan(plan);
  console.log("");

  if (options.dryRun) {
    info("--dry-run: nothing was written or deleted.");
    return 0;
  }

  if (hasLoss(plan) && !options.force) {
    fail(
      "Uninstalling now would lose the secrets listed above. Save each one first with " +
        "`kerstel get <scope>/<KEY> --reveal`, then re-run with --force.",
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
  const written: string[] = [];
  for (const file of plan.files) {
    try {
      writeFileSync(file.path, file.after);
      written.push(file.path);
    } catch (error) {
      fail(
        `Could not write ${file.path} (${(error as Error).message}). Kerstel is still installed and ` +
          "nothing was deleted. Fix the file's permissions and re-run.",
      );
      if (written.length > 0) info(`Already restored: ${written.join(", ")}`);
      return 1;
    }
  }

  // Phase 2: Kerstel itself.
  await stopDaemonIfRunning();
  const backend = await selectBackend();
  await backend.delete();
  ok(`Deleted the vault key from the ${backend.name} credential store.`);
  const home = kerstelHome();
  rmSync(home, { recursive: true, force: true });
  ok(`Deleted ${home}.`);

  if (binary.compiled) {
    rmSync(binary.path, { force: true });
    ok(`Removed ${binary.path}.`);
  } else {
    info(`Running from source, so ${binary.path} was left in place.`);
  }

  console.log("");
  for (const project of plan.restored) ok(`Restored ${project.name} (${project.rootPath}).`);
  if (plan.restored.length > 0) {
    console.log(
      yellow("!  Those .env files hold plaintext secrets again. Keep them out of git: check your .gitignore."),
    );
  }
  return 0;
}
