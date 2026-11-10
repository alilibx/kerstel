import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { daemonCwd, daemonEnv } from "../daemon/env";
import { cliCommand } from "../daemon/spawn";
import { kerstelHome, vaultPath } from "../paths";
import { SYNC_META } from "./state";

/**
 * Sync in the background. Sync spec §8.1: a command that writes the vault
 * starts a detached `kerstel sync --background`, `run` and `exec` start one
 * when the last sync is more than five minutes old, and one lock file keeps
 * syncs from overlapping. None of it ever waits on the network or fails the
 * command that started it.
 */

/** `run` and `exec` sync in the background when no sync finished in this long. */
export const BACKGROUND_PULL_AFTER_MS = 5 * 60_000;
/** `doctor` warns when the last successful sync is older than this. */
export const STALE_SYNC_MS = 7 * 24 * 60 * 60_000;
/** A lock older than this is left over from a sync that died: every request inside it times out sooner. */
const LOCK_MAX_AGE_MS = 10 * 60_000;

/** What a command can learn about sync from `vault.db` alone: no data key, no credential store. */
export interface SyncGlance {
  on: boolean;
  /** Changes made here that are waiting to be pushed. */
  pending: number;
  conflicts: number;
  server: string | null;
  lastOk: number | null;
  lastTry: number | null;
  lastError: string | null;
}

const OFF: SyncGlance = { on: false, pending: 0, conflicts: 0, server: null, lastOk: null, lastTry: null, lastError: null };

/** Read-only, so it never creates, migrates or locks the vault. Off whenever the file can't be read. */
export function glanceSync(file: string = vaultPath()): SyncGlance {
  if (!existsSync(file)) return OFF;
  let db: Database | null = null;
  try {
    db = new Database(file, { readonly: true });
    const meta = new Map(
      db
        .query<{ key: string; value: string }, []>("SELECT key, value FROM vault_meta WHERE key LIKE 'sync_%'")
        .all()
        .map((row) => [row.key, row.value]),
    );
    if (!meta.has(SYNC_META.vaultId)) return OFF;
    const counts = db
      .query<{ pending: number | null; conflicts: number | null }, []>(
        `SELECT SUM(CASE WHEN dirty = 1 AND conflict IS NULL THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN conflict IS NOT NULL THEN 1 ELSE 0 END) AS conflicts
         FROM sync_state`,
      )
      .get();
    const time = (key: string) => (meta.has(key) ? Number(meta.get(key)) : null);
    return {
      on: true,
      pending: counts?.pending ?? 0,
      conflicts: counts?.conflicts ?? 0,
      server: meta.get(SYNC_META.server) ?? null,
      lastOk: time(SYNC_META.lastOk),
      lastTry: time(SYNC_META.lastTry),
      lastError: meta.get(SYNC_META.lastError) ?? null,
    };
  } catch {
    return OFF;
  } finally {
    db?.close();
  }
}

// ---- The lock ---------------------------------------------------------------

/** `~/.kerstel/sync.lock`: beside the vault it guards. */
export function syncLockPath(vaultFile: string = join(kerstelHome(), "vault.db")): string {
  return join(dirname(vaultFile), "sync.lock");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock whose process is gone, or that has been held far longer than any sync takes. */
function isStale(file: string, now: number): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
    if (now - statSync(file).mtimeMs > LOCK_MAX_AGE_MS) return true;
    return typeof pid !== "number" || !alive(pid);
  } catch {
    // Half written, or removed meanwhile: only age can tell.
    try {
      return now - statSync(file).mtimeMs > LOCK_MAX_AGE_MS;
    } catch {
      return true;
    }
  }
}

/**
 * Takes `~/.kerstel/sync.lock`, or returns null when another sync holds it.
 * The returned function releases it. A lock left by a sync that died is taken over.
 */
export function tryLockSync(file: string = syncLockPath(), now: number = Date.now()): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      if (!isStale(file, now)) return null;
      rmSync(file, { force: true });
      continue;
    }
    const mine = JSON.stringify({ pid: process.pid, at: now });
    try {
      writeSync(fd, mine);
    } finally {
      closeSync(fd);
    }
    return () => {
      // Only our own: a lock taken over after this one went stale belongs to another sync.
      try {
        if (readFileSync(file, "utf8") === mine) rmSync(file, { force: true });
      } catch {
        // Already gone.
      }
    };
  }
  return null;
}

/** For a sync someone is waiting on: waits for a background sync to finish, up to `timeoutMs`. */
export async function waitForSyncLock(file: string, timeoutMs: number): Promise<(() => void) | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryLockSync(file);
    if (release || Date.now() >= deadline) return release;
    await Bun.sleep(250);
  }
}

// ---- Starting one -----------------------------------------------------------

/**
 * Network settings a sync may need, on top of the daemon's allowlist: a
 * proxy, and a certificate authority for a self-hosted server. Never
 * NODE_OPTIONS or BUN_OPTIONS (see daemonEnv), and never the caller's other
 * variables, which under `exec` can be resolved secrets.
 */
const NETWORK_SETTINGS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

export function backgroundSyncEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = daemonEnv(base);
  for (const name of NETWORK_SETTINGS) {
    const value = base[name];
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

/** Starts `kerstel sync --background` in its own session, so closing the terminal or Ctrl-C doesn't end it. */
export function spawnBackgroundSync(): void {
  Bun.spawn(cliCommand(["sync", "--background"]), {
    cwd: daemonCwd(),
    env: backgroundSyncEnv(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  }).unref();
}

/** Commands that write the vault, and so push what they wrote. */
const WRITES = new Set(["set", "rm", "remove", "init", "move", "ui"]);
/** Commands that start an app, and so pull what other devices changed. */
const RUNS = new Set(["run", "exec"]);

export interface BackgroundDeps {
  glance?: () => SyncGlance;
  spawn?: () => void;
  now?: () => number;
}

/**
 * Before a command runs: `run` and `exec` start a sync when none finished in
 * the last five minutes. Before, and not after, because the app they start
 * may run for hours. Never throws.
 */
export function syncBeforeCommand(command: string, deps: BackgroundDeps = {}): boolean {
  if (!RUNS.has(command)) return false;
  try {
    const sync = (deps.glance ?? glanceSync)();
    if (!sync.on) return false;
    const last = Math.max(sync.lastOk ?? 0, sync.lastTry ?? 0);
    if ((deps.now ?? Date.now)() - last < BACKGROUND_PULL_AFTER_MS) return false;
    (deps.spawn ?? spawnBackgroundSync)();
    return true;
  } catch {
    return false;
  }
}

/** After a command that writes the vault: a sync, when it left changes to push. Never throws. */
export function syncAfterCommand(command: string, deps: BackgroundDeps = {}): boolean {
  if (!WRITES.has(command)) return false;
  try {
    const sync = (deps.glance ?? glanceSync)();
    if (!sync.on || sync.pending === 0) return false;
    (deps.spawn ?? spawnBackgroundSync)();
    return true;
  } catch {
    return false;
  }
}

/** Sync spec §8.4: the line every command prints while a conflict is open. Null when there is none. */
export function conflictLine(command: string, cli: string, glance: () => SyncGlance = glanceSync): string | null {
  // `sync` reports its own conflicts, and asks about them.
  if (command === "sync") return null;
  try {
    const { on, conflicts } = glance();
    if (!on || conflicts === 0) return null;
    return `kerstel: ${conflicts} sync conflict${conflicts === 1 ? "" : "s"}. Run \`${cli} sync\` to choose which value stays.`;
  } catch {
    return null;
  }
}
