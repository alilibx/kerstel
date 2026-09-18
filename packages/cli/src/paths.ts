import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all Kerstel state. Read fresh on every call so tests can rebind it. */
export function kerstelHome(): string {
  const override = process.env.KERSTEL_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), ".kerstel");
}

export function vaultPath(): string {
  return join(kerstelHome(), "vault.db");
}

export function tokenPath(): string {
  return join(kerstelHome(), "session.token");
}

export function hookDir(): string {
  return join(kerstelHome(), "hook");
}

export function backupsDir(): string {
  return join(kerstelHome(), "backups");
}

/**
 * Unix: a socket file inside the 0700 home.
 * Windows: a named pipe, whose name is derived from the home path so that
 * separate KERSTEL_HOME values (including parallel tests) never collide.
 */
export function socketPath(): string {
  if (process.platform === "win32") {
    const id = createHash("sha256").update(kerstelHome()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\kerstel-${id}`;
  }
  return join(kerstelHome(), "kerstel.sock");
}

/** Creates the home directory if needed and returns it. Owner-only access. */
export function ensureHome(): string {
  const home = kerstelHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Mode 0700 is asserted on every call, not only on creation -- the same
  // rule store.ts applies to the vault file, for the same reason. mkdirSync's
  // `mode` applies only when it creates the directory, and it is masked by the
  // umask even then, so a home that already exists keeps whatever mode it has:
  // 0755 from a permissive umask, or from a user who made ~/.kerstel by hand.
  // Every protection Kerstel claims rests on this directory being private (the
  // token, the socket and the file-backend key are all "0600 inside a 0700
  // home"), so re-assert it rather than trusting the one call that created it.
  // Do not gate this behind an "isNew" check.
  if (process.platform !== "win32") chmodSync(home, 0o700);
  return home;
}
