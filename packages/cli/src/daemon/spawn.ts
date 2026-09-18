import { dirname, resolve } from "node:path";

/**
 * Markers of Bun's virtual filesystem root, where modules live inside a
 * `bun build --compile` binary. `/$bunfs/` on POSIX, `B:\~BUN\` on Windows.
 */
const VIRTUAL_ROOT_MARKERS = ["/$bunfs/", "\\$bunfs\\", "/~BUN/", "\\~BUN\\"];

/**
 * True when this code is running inside the compiled `kerstel` binary rather
 * than from source under `bun run`.
 *
 * `process.execPath` alone cannot answer this: compiled it is the `kerstel`
 * binary, from source it is the `bun` binary, and the two look identical.
 * `import.meta.path` does distinguish them -- inside the binary every module
 * reports a path under Bun's virtual root, which no real file ever has.
 */
export function isCompiledBinary(): boolean {
  const here = import.meta.path;
  return VIRTUAL_ROOT_MARKERS.some((marker) => here.includes(marker));
}

/**
 * The argv that starts a detached resolver daemon.
 *
 * THE CONSTRAINT: `process.execPath` means two different things depending on
 * how this process was started. Compiled, it is the `kerstel` binary and
 * `[execPath, "daemon", "serve"]` is exactly right. From source it is the `bun`
 * binary, and that same argv asks Bun to execute a file called `daemon` --
 * which fails in a way that looks like the daemon crashed rather than like the
 * caller built the wrong command. From source we therefore have to name the CLI
 * entry point explicitly.
 *
 * Both spawn sites (`kerstel daemon start` and `ensureDaemon`) go through here
 * so the two can never drift apart.
 */
export function daemonServeCommand(): string[] {
  if (isCompiledBinary()) return [process.execPath, "daemon", "serve"];
  // src/daemon/spawn.ts -> src/index.ts
  const entry = resolve(dirname(import.meta.path), "..", "index.ts");
  return [process.execPath, "run", entry, "daemon", "serve"];
}
