import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { cliName } from "../../ui/cli-name";

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
 * data key straight off the pipe.
 *
 * Listing a directory here is not enough on its own: `resolveHelperIn` also
 * checks that the directory and the file are owned by root and writable by
 * nobody else, so a `/usr/local/bin` that someone chowned to themselves is
 * skipped rather than trusted.
 */
export function trustedDirs(): string[] {
  switch (process.platform) {
    case "darwin":
      return ["/usr/bin", "/bin"];
    case "win32": {
      // A fixed root, on purpose. `SystemRoot` and `windir` come from the
      // caller's environment, and the caller is who this guards against.
      const root = "C:\\Windows";
      return [`${root}\\System32\\WindowsPowerShell\\v1.0`, `${root}\\System32`];
    }
    default:
      // /usr/local/bin for a distro-less install from source; NixOS and Guix
      // link their system profiles under /run/current-system.
      return ["/usr/bin", "/bin", "/usr/local/bin", "/run/current-system/sw/bin", "/run/current-system/profile/bin"];
  }
}

/** `trustedDirs()` as one search-path string, for messages. */
export function trustedPath(): string {
  return trustedDirs().join(process.platform === "win32" ? ";" : ":");
}

/**
 * Owned by root and writable only by root. `statSync` follows symlinks, so a
 * NixOS or Guix profile link is judged by the root-owned store path it points
 * at. Windows has no POSIX ownership; there the fixed drive-letter root in
 * `trustedDirs` is the whole guarantee.
 */
function isSystemOwned(path: string): boolean {
  if (process.platform === "win32") return true;
  try {
    const stat = statSync(path);
    return stat.uid === 0 && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * The absolute path of a helper by bare name, searched only in `dirs`, or null
 * when none holds an executable of that name that passes `isSystemOwned` for
 * both the directory and the file. Anything with a path separator is refused:
 * callers name tools, they never point at files.
 */
export function resolveHelperIn(name: string, dirs: string[]): string | null {
  if (name.length === 0 || name.includes("/") || name.includes("\\")) return null;
  for (const dir of dirs) {
    const candidates = process.platform === "win32" ? [join(dir, `${name}.exe`), join(dir, name)] : [join(dir, name)];
    for (const path of candidates) {
      let file;
      try {
        file = statSync(path);
      } catch {
        continue;
      }
      if (!file.isFile()) continue;
      try {
        accessSync(path, constants.X_OK);
      } catch {
        continue;
      }
      if (!isSystemOwned(dir) || !isSystemOwned(path)) continue;
      return path;
    }
  }
  return null;
}

/** `resolveHelperIn` over `trustedDirs()`. */
export function resolveHelper(name: string): string | null {
  return resolveHelperIn(name, trustedDirs());
}

/** The error for a helper that no trusted directory holds, with the way out. */
export function helperNotFoundError(name: string): Error {
  return new Error(
    `${name} was not found in ${trustedPath()}. Kerstel runs it only from one of those directories, ` +
      `and only when the directory and the file are owned by root and writable by nobody else; it never ` +
      `looks on PATH. Install it there, or set KERSTEL_KEYCHAIN_BACKEND=file to keep the vault key in a ` +
      `0600 file instead; \`${cliName()} doctor\` shows which store this vault uses.`,
  );
}

/**
 * Runs a helper without a shell. `cmd[0]` is a bare tool name resolved through
 * `resolveHelper`, never through the caller's `PATH`. Secret material is
 * passed on stdin, never as an argv entry, so it cannot leak through the
 * process table.
 */
export async function run(cmd: string[], stdin?: string): Promise<ExecResult> {
  const [name, ...args] = cmd;
  if (name === undefined) throw new Error("run() needs a helper name.");
  const bin = resolveHelper(name);
  if (bin === null) throw helperNotFoundError(name);
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
