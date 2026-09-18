import { join } from "node:path";
import { openContext } from "../context";
import { ensureDaemon } from "../daemon/client";
import { fail } from "../output";
import { socketPath } from "../paths";
import { cliName } from "../ui/cli-name";

/**
 * Runs one command with Kerstel's runtime hook wired in, then gets out of the
 * way. This is what the wizard writes into `package.json` scripts, so it has
 * to be boring: no argument rewriting, no shell, no resolution.
 *
 * It deliberately does NOT resolve references. `kerstel run` snapshots the
 * whole environment into plaintext up front (spec §6.2's universal fallback);
 * `exec` hands the child the references untouched and lets the hook resolve
 * each one lazily, on the read, through the daemon -- which is what makes the
 * audit log meaningful and what level 2 (spec §3) will gate on.
 */

export function preloadPathFor(hookDir: string): string {
  return join(hookDir, "preload.cjs");
}

export function buildExecEnv(options: {
  base: NodeJS.ProcessEnv;
  socketPath: string;
  token: string;
  hookDir: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.base)) {
    if (typeof value === "string") env[name] = value;
  }

  env.KERSTEL_SOCKET = options.socketPath;
  env.KERSTEL_TOKEN = options.token;
  env.KERSTEL_HOOK_DIR = options.hookDir;

  const preload = preloadPathFor(options.hookDir);
  const existing = env.NODE_OPTIONS ?? "";
  // JSON.stringify, exactly as packages/hook/src/preload.js does when it
  // propagates the flag to grandchildren: a home directory with a space in it
  // ("/Users/Ada Lovelace/...") otherwise splits into two broken options.
  // Skipped when the path is already there, so a nested `exec` (a wrapped
  // script that calls another wrapped script) does not grow NODE_OPTIONS
  // without bound.
  if (!existing.includes(preload)) {
    const flag = `--require ${JSON.stringify(preload)}`;
    env.NODE_OPTIONS = existing ? `${existing} ${flag}` : flag;
  }

  return env;
}

/**
 * True when the command Bun would run is the `bun` runtime itself, so the
 * preload has to arrive as a `--preload` argument rather than through
 * NODE_OPTIONS (which Bun does not honour -- see the probe test in
 * test/exec.test.ts). Covers `bun x.js`, `bun run dev` and `bunx`, with or
 * without a directory in front of the executable and with or without `.exe`.
 */
export function isBunCommand(command: string[]): boolean {
  const executable = command[0];
  if (!executable) return false;
  const name = (executable.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  return name === "bun" || name === "bunx";
}

/**
 * Inserts `--preload=<hookDir>/preload.cjs` immediately after the executable,
 * which is where Bun accepts runtime flags -- after a subcommand like `run`
 * they belong to the script, not to Bun. Idempotent: a command that already
 * carries this preload is returned unchanged, and the hook's own
 * KERSTEL_ACTIVE guard makes a double install a no-op anyway.
 *
 * ONE ARGUMENT, JOINED BY "=", not the two-argument `--preload <path>` form.
 * Verified on Bun 1.3.10: `bun --preload <path> run dev` prints `bun run`'s
 * usage and exits 0 WITHOUT running the script -- the split form makes Bun
 * lose the subcommand, so the wizard's own `bun run dev` would become a
 * silent no-op that still looks like a success. `bun --preload=<path> run dev`
 * and `bunx --preload=<path> <pkg>` both behave normally.
 */
export function withBunPreload(command: string[], hookDir: string): string[] {
  if (!isBunCommand(command)) return command;
  const preload = preloadPathFor(hookDir);
  if (command.some((argument) => argument.includes(preload))) return command;
  const [executable, ...rest] = command;
  return [executable as string, `--preload=${preload}`, ...rest];
}

export async function execCommand(args: string[]): Promise<number> {
  const separator = args.indexOf("--");
  const command = separator === -1 ? args : args.slice(separator + 1);
  if (command.length === 0) {
    fail(`Usage: ${cliName()} exec -- <command> [args...]`);
    return 2;
  }

  // Opening the context is what installs/refreshes ~/.kerstel/hook/ and mints
  // the session token. The vault itself is not needed here -- `exec` never
  // reads a secret -- so it is closed before anything long-running starts.
  const ctx = await openContext();
  const { token, hookDir, hookInstall } = ctx;
  ctx.vault.close();

  if (!hookInstall.installed) {
    fail(
      `Kerstel could not install its runtime hook into ${hookDir}: ${hookInstall.error ?? "unknown error"}. ` +
        "Without it the child would receive raw kerstel:// references. " +
        `Fix the permissions, or use \`${cliName()} run -- <command>\` instead.`,
    );
    return 1;
  }

  // The daemon must be listening BEFORE the child starts: the hook resolves on
  // the first property read, which can be microseconds into the process.
  let client;
  try {
    client = await ensureDaemon();
  } catch (error) {
    fail((error as Error).message);
    return 1;
  }
  client.close();

  const env = buildExecEnv({ base: process.env, socketPath: socketPath(), token, hookDir });
  const argv = withBunPreload(command, hookDir);
  const child = Bun.spawn(argv, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}
