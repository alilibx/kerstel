import { isAbsolute } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Where the OS credential-store helpers (`security`, `secret-tool`,
 * `powershell`) are allowed to live. This is deliberately NOT the caller's
 * `PATH`: `npm run` and `bun run` put `node_modules/.bin` in front of it, and
 * `kerstel exec` is what `init` writes into every package script. A dependency
 * that declared `"bin": {"security": "./steal.js"}` would otherwise run in
 * place of the real tool the next time a script opened the vault, and read the
 * data key straight off the pipe. Only root-owned system directories qualify.
 */
export function trustedPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/usr/bin:/bin";
    case "win32": {
      const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
      return `${root}\\System32\\WindowsPowerShell\\v1.0;${root}\\System32`;
    }
    default:
      // /usr/local/bin for a distro-less install from source; NixOS links its
      // system profile under /run/current-system. All root-owned.
      return "/usr/bin:/bin:/usr/local/bin:/run/current-system/sw/bin";
  }
}

/**
 * The absolute path of a helper by bare name, searched only in
 * `trustedPath()`, or null when no trusted directory has it. An absolute or
 * relative path is refused: callers name tools, they never point at files.
 */
export function resolveHelper(name: string): string | null {
  if (name.length === 0 || isAbsolute(name) || name.includes("/") || name.includes("\\")) return null;
  return Bun.which(name, { PATH: trustedPath() }) ?? null;
}

/**
 * Runs a helper without a shell. `cmd[0]` is a bare tool name resolved through
 * `resolveHelper`, never through the caller's `PATH`. Secret material is
 * passed on stdin, never as an argv entry, so it cannot leak through the
 * process table.
 */
export async function run(cmd: string[], stdin?: string): Promise<ExecResult> {
  const [name, ...args] = cmd;
  const bin = name === undefined ? null : resolveHelper(name);
  if (bin === null) {
    throw new Error(`${name ?? "(empty command)"} was not found in ${trustedPath()}.`);
  }
  const proc = Bun.spawn([bin, ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Whether a helper exists in a trusted directory. Kept async for its callers. */
export async function commandExists(name: string): Promise<boolean> {
  return resolveHelper(name) !== null;
}
