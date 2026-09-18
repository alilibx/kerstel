import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/daemon/server";
import { generateDataKey } from "../../src/vault/crypto";
import { openVault, type Vault } from "../../src/vault/store";

/**
 * Boots a throwaway daemon over a throwaway vault, and remembers both so the
 * test file can tear them down in one call.
 *
 * Shared by daemon-client, daemon-server and the hook's preload tests, which
 * had drifted into three near-identical copies of this. NOT used by
 * bridge.test.ts: that one deliberately boots its daemon in a CHILD PROCESS,
 * because resolveSync parks the calling thread on Atomics.wait and an
 * in-process daemon on that same stopped event loop could never accept the
 * worker's connection. Its fixture is load-bearing, not duplication.
 */

const running: DaemonHandle[] = [];
const vaults: Vault[] = [];

export interface BootedDaemon {
  /** Unix socket path, or a named pipe on Windows. */
  sock: string;
  /** The vault the daemon is serving, open for the test to seed directly. */
  vault: Vault;
  handle: DaemonHandle;
}

export interface BootOptions {
  /** Distinguishes this file's temp dirs and pipe names from every other's. */
  prefix: string;
  token: string;
  idleMs?: number;
}

export async function bootDaemon(options: BootOptions): Promise<BootedDaemon> {
  const dir = mkdtempSync(join(tmpdir(), `kerstel-${options.prefix}-`));
  // Windows has no socket files; the pipe name has to be unique per daemon, so
  // it carries the prefix and a timestamp rather than the temp directory.
  const sock =
    process.platform === "win32"
      ? `\\\\.\\pipe\\kerstel-${options.prefix}-${Date.now()}-${running.length}`
      : join(dir, "k.sock");

  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  vaults.push(vault);

  const handle = await startDaemon({
    vault,
    socketPath: sock,
    token: options.token,
    backendName: "file",
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  });
  running.push(handle);

  return { sock, vault, handle };
}

/**
 * Stops every daemon and closes every vault this helper opened. Call from
 * afterEach: a leaked `daemon serve` outlives the test run and keeps a vault
 * open on a socket later tests may try to bind.
 */
export async function cleanupDaemons(): Promise<void> {
  while (running.length) await running.pop()!.close();
  while (vaults.length) vaults.pop()!.close();
}

/**
 * Hands a handle back to the caller and stops tracking it, for tests that
 * close it themselves or assert on its `closed` signal.
 */
export function releaseDaemon(handle: DaemonHandle): DaemonHandle {
  const index = running.indexOf(handle);
  if (index !== -1) running.splice(index, 1);
  return handle;
}
