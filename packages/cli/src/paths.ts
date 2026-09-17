import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
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
  return home;
}
