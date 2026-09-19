import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Names under `node_modules/.bin` that would run in place of Kerstel.
 *
 * `kerstel exec -- <command>` is what `init` writes into every package script,
 * and npm, pnpm, yarn, and bun all put `node_modules/.bin` (of the package and
 * of every ancestor directory) in front of `PATH` when they run one. A
 * dependency that declares `"bin": {"kerstel": "./x.js"}` is therefore what
 * `npm run dev` executes, with the full command line, and nothing stops it
 * calling the real binary by absolute path to read the whole vault before
 * delegating so the app still starts. `--ignore-scripts` does not prevent bin
 * linking, and the package never has to be `require`d.
 *
 * Kerstel is not an npm package, so there is no legitimate reason for any of
 * these to exist. On Windows npm writes `.cmd` and `.ps1` shims next to the
 * shell one.
 */
export const SHADOW_NAMES: readonly string[] = [
  "kerstel",
  "kerstel.cmd",
  "kerstel.ps1",
  "kerstel.exe",
  "ks",
  "ks.cmd",
  "ks.ps1",
  "ks.exe",
];

/**
 * Every `node_modules/.bin/<name>` that exists in `root` or any ancestor, as
 * absolute paths, nearest first. Existence is judged with `lstat`, so a
 * dangling symlink (the usual shape of a bin link) still counts: npm would
 * still try to run it.
 */
export function findShadowedBinaries(root: string): string[] {
  const found: string[] = [];
  let dir = root;
  for (;;) {
    const bin = join(dir, "node_modules", ".bin");
    for (const name of SHADOW_NAMES) {
      const path = join(bin, name);
      try {
        lstatSync(path);
        found.push(path);
      } catch {
        // Not there; the common case for every directory on the way up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

/** The refusal `init` and `exec` print, and the fix `doctor` suggests. */
export function shadowedBinaryMessage(paths: string[]): string {
  const list = paths.join(", ");
  // Both bin names, since the detector refuses both.
  const find = "grep -lE '\"(kerstel|ks)\"' node_modules/*/package.json node_modules/@*/*/package.json";
  return (
    `${list} would run in place of Kerstel: npm and bun put node_modules/.bin first on PATH when ` +
    "they run a script, so a wired script would hand its command line, and access to the vault, to that " +
    "file instead. Kerstel is not an npm package, so nothing legitimate installs it there. Find the " +
    `dependency that does (${find}), remove it, and delete the file.`
  );
}
