import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectPackageManager } from "../init/detect";
import { fail } from "../output";

/**
 * What a shell exits with when the command it was asked to run does not
 * exist, so `npm run` and `bun run` report the failure the same way they
 * would for an unwrapped script.
 */
export const EXIT_COMMAND_NOT_FOUND = 127;

function readPackageJson(dir: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The line `exec` and `run` print when the child cannot be started because its
 * executable is not on PATH. Bun's own error, `Executable not found in $PATH`,
 * is true but unhelpful: in a wired project the missing binary is almost
 * always a dependency that was never installed, so the message names the
 * install command for the project's package manager, and says outright when
 * `node_modules` is not there at all.
 */
export function missingExecutableMessage(executable: string, cwd: string): string {
  const base = `"${executable}" was not found on PATH.`;
  if (!existsSync(join(cwd, "package.json"))) return base;

  const manager = detectPackageManager(cwd, readPackageJson(cwd));
  const install = `\`${manager} install\``;
  if (!existsSync(join(cwd, "node_modules"))) {
    return `${base} This project has no node_modules yet: run ${install}, then try again.`;
  }
  return `${base} If it is a dependency of this project, run ${install} to install it, then try again.`;
}

/**
 * Starts the child with inherited stdio and waits for it. A command whose
 * executable does not exist is reported as a shell would report it, message
 * plus exit 127, instead of surfacing as an internal error. Every other
 * failure to spawn is rethrown for the top-level handler.
 */
export async function spawnChild(command: string[], env: Record<string, string>): Promise<number> {
  let child: ReturnType<typeof Bun.spawn>;
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
