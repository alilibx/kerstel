import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookDir } from "./paths";

// The runtime hook is never `npm install`ed -- it is written to ~/.kerstel/hook/
// by this binary. These two imports are what make that possible from a single
// self-contained artifact: `bun build --compile` embeds any file imported with
// `with { type: "file" }` into the binary, and the import evaluates to a path
// under the virtual /$bunfs/ root that Bun.file()/readFileSync can read. Running
// from source (`bun run src/index.ts`) the same import yields the real path in
// packages/hook/dist, so one code path serves both.
//
// `packages/cli`'s `build` script runs `build:hook` first, so both files exist
// at compile time. Do not reorder that.
import preloadAsset from "../../hook/dist/preload.cjs" with { type: "file" };
import workerAsset from "../../hook/dist/worker.cjs" with { type: "file" };

/** The files the hook needs at runtime, in the names `bridge.js` expects. */
const ASSETS: ReadonlyArray<readonly [name: string, source: string]> = [
  ["preload.cjs", preloadAsset],
  ["worker.cjs", workerAsset],
];

export interface HookInstallResult {
  /** Where the hook belongs, whether or not this call managed to write it. */
  dir: string;
  /** True when both assets are on disk and current after this call. */
  installed: boolean;
  /** Why the install failed, for `kerstel doctor` to report. Never secret. */
  error?: string;
}

/**
 * Writes the embedded hook assets into `~/.kerstel/hook/`, creating the
 * directory when needed.
 *
 * Idempotent and content-addressed: a file whose bytes already match is left
 * alone, so an upgraded binary refreshes the hook on its next vault-opening
 * command without rewriting it on every invocation.
 *
 * NEVER THROWS. This runs from openContext(), i.e. on the way into every
 * vault-opening command, and the hook is an optional convenience: it makes
 * references resolve lazily inside an app, and `kerstel run` covers the same
 * ground without it. A read-only `~/.kerstel` (a binary upgrade mid-flight, a
 * restrictive umask, a hook dir someone chmodded) must therefore not be able to
 * take down `kerstel ls`, `kerstel get`, or -- least helpfully of all --
 * `kerstel doctor`, the one command whose job is to explain the problem. The
 * failure is recorded and reported there instead.
 *
 * These files are program text, not secrets -- mode 0644 is deliberate. The
 * privacy boundary is the 0700 home directory they sit inside, which
 * `ensureHome()` creates and this function inherits by placing `hook/` under it.
 */
export function installHookAssets(): HookInstallResult {
  const dir = hookDir();

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    for (const [name, source] of ASSETS) {
      const target = join(dir, name);
      const desired = readFileSync(source);

      let current: Buffer | null = null;
      try {
        current = readFileSync(target);
      } catch {
        // Missing or unreadable -- write it.
      }
      if (current && current.equals(desired)) continue;

      writeFileSync(target, desired, { mode: 0o644 });
      // writeFileSync's `mode` applies only when it creates the file, so an
      // existing file keeps whatever mode it had. Assert it either way.
      if (process.platform !== "win32") chmodSync(target, 0o644);
    }
  } catch (error) {
    // A filesystem error message carries paths and errno text, never file
    // contents, so nothing from the hook or the vault leaks through here.
    return { dir, installed: false, error: (error as Error).message };
  }

  return { dir, installed: true };
}

/** True when both hook files are present and match what this binary carries. */
export function hookAssetsInstalled(): boolean {
  const dir = hookDir();
  for (const [name, source] of ASSETS) {
    try {
      if (!readFileSync(join(dir, name)).equals(readFileSync(source))) return false;
    } catch {
      return false;
    }
  }
  return true;
}
