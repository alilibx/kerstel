"use strict";

const { existsSync } = require("node:fs");
const path = require("node:path");

/**
 * Finds the directory the hook is actually running from, and the worker file
 * inside it, WITHOUT consulting `__dirname` or `__filename`.
 *
 * Why this file exists
 * --------------------
 * `Bun.build({ target: "node", format: "cjs" })` does not leave `__dirname`,
 * `__filename`, `module.filename`, `module.path` or `module.id` alone: it
 * replaces every one of them with a STRING LITERAL holding the BUILD machine's
 * SOURCE path. The emitted preload.cjs opens with, literally:
 *
 *   var __dirname = "/Users/<builder>/.../packages/hook/src",
 *       __filename = "/Users/<builder>/.../packages/hook/src/bridge.js";
 *
 * Those paths exist on exactly one computer in the world. Any hook shipped in
 * the binary and installed to ~/.kerstel/hook/ that derives its worker path
 * from them points at a file the user does not have, the Worker never boots,
 * and every resolveSync() parks for the full deadline before reporting a
 * misleading "is the daemon running?" timeout. So: nothing in the hook may
 * trust a compile-time path. This module is the single place that decides.
 *
 * What IS dynamic under the bundler
 * ---------------------------------
 * `require` itself is the real Node CJS require of the emitted file, so
 * `require.resolve` answers relative to wherever that file truly sits at
 * runtime. But the bundler still tries to resolve `require.resolve()` calls
 * statically, and two failure modes were observed and must be designed around:
 *
 *   1. `require.resolve("./worker.js")`, when that specifier RESOLVES at build
 *      time, is rewritten to the absolute build-machine path — the same defect
 *      as `__dirname`, just better hidden.
 *   2. `require.resolve("./" + "worker.cjs")` is constant-folded WRONG: the
 *      emitted call is `require.resolve("./")`, silently dropping the second
 *      operand and resolving a directory instead of the worker.
 *
 * A specifier built from a VARIABLE is left intact by both passes — verified
 * against the emitted bundle, and guarded from here on by the build test in
 * test/build.test.ts, which greps dist/*.cjs for absolute machine paths and
 * fails if the bundler ever starts baking these again.
 */

/**
 * Bundled, the worker ships as `worker.cjs` beside `preload.cjs`. Running from
 * source (bridge.test.ts imports src/bridge.js directly) it is `worker.js`
 * beside it. The right one is decided by what is ON DISK at runtime, never by
 * inspecting our own filename — which is precisely the thing that is baked.
 */
const WORKER_NAMES = ["worker.cjs", "worker.js"];

function resolveWorkerFile() {
  const failures = [];
  for (const name of WORKER_NAMES) {
    try {
      // `"./" + name` with `name` a VARIABLE, never two literals. See the
      // module comment: a literal specifier gets baked, and a folded pair of
      // literals gets mangled into `require.resolve("./")`.
      return require.resolve("./" + name);
    } catch (error) {
      failures.push(`${name} (${(error && error.code) || "unresolved"})`);
    }
  }
  const error = new Error(
    `Kerstel hook could not locate its resolver worker. Tried ${failures.join(", ")}. ` +
      "Re-run any Kerstel command to reinstall ~/.kerstel/hook/, or run `kerstel doctor`.",
  );
  error.code = "internal";
  throw error;
}

/**
 * Returns `{ dir, workerFile }` for the running hook.
 *
 * `KERSTEL_HOOK_DIR` wins when it names a directory that actually holds a
 * worker: the CLI sets it, and a child re-exec'd through NODE_OPTIONS inherits
 * it, so this keeps a whole process tree pointed at one install. A value that
 * does not hold a worker is ignored rather than trusted into a stall, and the
 * runtime-resolved location is used instead.
 */
function locateHook() {
  const fromEnv = process.env.KERSTEL_HOOK_DIR;
  if (fromEnv) {
    for (const name of WORKER_NAMES) {
      const candidate = path.join(fromEnv, name);
      if (existsSync(candidate)) return { dir: fromEnv, workerFile: candidate };
    }
  }

  // The worker's own resolved path defines the directory: whatever loader
  // found it is by definition where the hook lives.
  const workerFile = resolveWorkerFile();
  return { dir: path.dirname(workerFile), workerFile };
}

module.exports = { locateHook, resolveWorkerFile, WORKER_NAMES };
