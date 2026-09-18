import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Preloaded by `bun test` (see bunfig.toml). Points TMPDIR at one directory
 * per test run and deletes it when the run exits.
 *
 * Tests create throwaway homes that hold a file-backend data key, a vault.db,
 * and encrypted backups. Cleaning them up file by file missed dozens of them
 * per run, so the run owns one parent and removes it whole. os.tmpdir() reads
 * TMPDIR on every call, so every test, and every child process it spawns,
 * lands inside it.
 *
 * Outside Windows it lives in /tmp, not os.tmpdir(): macOS caps a Unix socket
 * path at 104 bytes, daemon tests put a socket two directories below this
 * one, and macOS's default temp path (/var/folders/...) alone spends ~50.
 */
const base = process.platform === "win32" ? tmpdir() : "/tmp";
const runDir = mkdtempSync(join(base, "kt-"));
process.env.TMPDIR = runDir;

// Registered from a preload, afterAll runs once after every test file has
// finished. `process.on("exit")` does not fire under `bun test`.
afterAll(() => {
  rmSync(runDir, { recursive: true, force: true });
});
