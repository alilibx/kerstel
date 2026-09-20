import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { detectPackageManager, readPackageJson } from "../init/detect";
import { fail } from "../output";

/**
 * What a shell exits with when the command it was asked to run does not
 * exist, so `npm run` and `bun run` report the failure the same way they
 * would for an unwrapped script.
 */
export const EXIT_COMMAND_NOT_FOUND = 127;

/** A command with a path separator is run as a file and never looked up on PATH. */
function isPathForm(executable: string): boolean {
  return /[\\/]/.test(executable);
}

/**
 * Whether any directory from `dir` upwards holds a `node_modules`. A workspace
 * member with hoisted dependencies has none of its own, so looking only at the
 * project directory would call an installed workspace "not installed".
 */
function hasNodeModulesAbove(dir: string): boolean {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, "node_modules"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * The line `exec` and `run` print when the child cannot be started because its
 * executable does not exist. Bun's own error, `Executable not found in $PATH`,
 * is true but unhelpful: in a wired project the missing binary is almost
 * always a dependency that was never installed, so the message names the
 * install command for the project's package manager, and says outright when
 * no `node_modules` exists at all. A command given as a path is a different
 * mistake, a file that is not there, so it gets no install hint.
 */
export function missingExecutableMessage(executable: string, cwd: string): string {
  if (isPathForm(executable)) {
    return isAbsolute(executable)
      ? `"${executable}" does not exist.`
      : `"${executable}" does not exist in ${cwd}.`;
  }

  const base = `"${executable}" was not found on PATH.`;
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) return base;

  const manager = detectPackageManager(cwd, readPackageJson(packageJsonPath).json);
  const install = `\`${manager} install\``;
  if (!hasNodeModulesAbove(cwd)) {
    return `${base} This project has no node_modules yet: run ${install}, then try again.`;
  }
  return `${base} If it is a dependency of this project, run ${install} to install it, then try again.`;
}

/**
 * Whether the command's executable can be found the way spawn will look for
 * it: a path is checked as a file, anything else is looked up on this
 * process's PATH, which is the PATH the child inherits.
 */
export function executableExists(executable: string, cwd: string = process.cwd()): boolean {
  if (isPathForm(executable)) return existsSync(isAbsolute(executable) ? executable : join(cwd, executable));
  return Bun.which(executable) !== null;
}

/**
 * The check `exec` and `run` make BEFORE opening the vault or starting the
 * daemon: a command that cannot start should unlock nothing and prompt for
 * nothing. Returns the exit code to end with, or null when the command can
 * run. `spawnChild` still handles ENOENT as the backstop, for a file that
 * disappears in between or an edge where this lookup and the spawn disagree.
 */
export function refuseMissingExecutable(command: string[]): number | null {
  const executable = command[0] ?? "";
  if (executableExists(executable)) return null;
  fail(missingExecutableMessage(executable, process.cwd()));
  return EXIT_COMMAND_NOT_FOUND;
}

/**
 * Starts the child with inherited stdio and waits for it. A command whose
 * executable does not exist is reported as a shell would report it, message
 * plus exit 127, instead of surfacing as an internal error. Every other
 * failure to spawn is rethrown for the top-level handler.
 */
export async function spawnChild(command: string[], env: Record<string, string>): Promise<number> {
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      fail(missingExecutableMessage(command[0] ?? "", process.cwd()));
      return EXIT_COMMAND_NOT_FOUND;
    }
    throw error;
  }
  return await child.exited;
}
