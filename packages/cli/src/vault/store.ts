import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { ensureHome, vaultPath } from "../paths";
import type { SecretRef } from "../reference";
import { decrypt, encrypt } from "./crypto";
import { SCHEMA_VERSION, migrate } from "./schema";

export { SCHEMA_VERSION };

export interface SecretSummary {
  scope: string;
  key: string;
  updatedAt: number;
}

export interface ProjectRecord {
  name: string;
  rootPath: string;
  /** The package.json name when `init` last ran here, or null (no name, or registered before schema 3). */
  packageName: string | null;
  createdAt: number;
}

export interface AuditEntry {
  ts: number;
  event: string;
  scope: string;
  key: string;
  pid: number | null;
  processName: string | null;
}

export interface Vault {
  setSecret(ref: SecretRef, value: string): void;
  getSecret(ref: SecretRef): string | null;
  listSecrets(scope?: string): SecretSummary[];
  removeSecret(ref: SecretRef): boolean;
  registerProject(name: string, rootPath: string, packageName?: string | null): void;
  listProjects(): ProjectRecord[];
  appendAudit(entry: AuditEntry): void;
  listAudit(limit: number): AuditEntry[];
  /** Reads a `vault_meta` row. Not secret -- see meta.ts. */
  getMeta(key: string): string | null;
  /** Writes a `vault_meta` row, replacing any existing value. */
  setMeta(key: string, value: string): void;
  close(): void;
}

/**
 * Opens (creating and migrating as needed) the encrypted vault.
 * `dataKey` comes from the OS credential store and is held in memory only.
 */
export function openVault(dataKey: Buffer, file?: string): Vault {
  const target = file ?? vaultPath();
  if (!file) ensureHome();

  const db = new Database(target, { create: true });
  // Mode 0600 is asserted on every open, not only on creation, and before
  // migrate() runs. A crash between file creation and this point (or an
  // older build that only chmod'd on creation) can strand the vault at the
  // umask default (typically 0644); re-asserting here every time makes a
  // stranded vault repair itself on its next open instead of staying wrong
  // forever. Do not gate this behind an "isNew" check.
  //
  // Guarded on existence for the same reason the sidecar loop below is: this
  // assumes SQLite materialized the file during `new Database(..., {create:
  // true})`, which it does today but is not contractually obliged to do (a
  // deferred first write would leave nothing to chmod and throw ENOENT here,
  // failing every command on a fresh machine).
  if (process.platform !== "win32" && existsSync(target)) chmodSync(target, 0o600);
  migrate(db);
  if (process.platform !== "win32") {
    // WAL mode (set inside migrate()) creates these sidecar files. They never
    // hold plaintext values, but they carry the same scope/key metadata as
    // the main file, so they get the same permissions. SQLite may not have
    // created them yet on a fresh vault, so guard on existence.
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${target}${suffix}`;
      if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
    }
  }

  const now = (): number => Date.now();

  return {
    setSecret(ref: SecretRef, value: string): void {
      const { ciphertext, nonce } = encrypt(value, dataKey);
      const ts = now();
      db.query(
        `INSERT INTO secrets (scope, key, value_ciphertext, nonce, environment, created_at, updated_at)
         VALUES ($scope, $key, $ct, $nonce, NULL, $ts, $ts)
         ON CONFLICT(scope, key) DO UPDATE SET
           value_ciphertext = excluded.value_ciphertext,
           nonce            = excluded.nonce,
           updated_at       = excluded.updated_at`,
      ).run({ $scope: ref.scope, $key: ref.key, $ct: ciphertext, $nonce: nonce, $ts: ts });
    },

    getSecret(ref: SecretRef): string | null {
      const row = db
        .query<{ value_ciphertext: Uint8Array; nonce: Uint8Array }, { $scope: string; $key: string }>(
          "SELECT value_ciphertext, nonce FROM secrets WHERE scope = $scope AND key = $key",
        )
        .get({ $scope: ref.scope, $key: ref.key });
      if (!row) return null;

      return decrypt(
        { ciphertext: Buffer.from(row.value_ciphertext), nonce: Buffer.from(row.nonce) },
        dataKey,
      );
    },

    listSecrets(scope?: string): SecretSummary[] {
      const rows = scope
        ? db
            .query<{ scope: string; key: string; updated_at: number }, { $scope: string }>(
              "SELECT scope, key, updated_at FROM secrets WHERE scope = $scope ORDER BY key",
            )
            .all({ $scope: scope })
        : db
            .query<{ scope: string; key: string; updated_at: number }, []>(
              "SELECT scope, key, updated_at FROM secrets ORDER BY scope, key",
            )
            .all();

      return rows.map((r) => ({ scope: r.scope, key: r.key, updatedAt: r.updated_at }));
    },

    removeSecret(ref: SecretRef): boolean {
      const result = db
        .query("DELETE FROM secrets WHERE scope = $scope AND key = $key")
        .run({ $scope: ref.scope, $key: ref.key });
      return result.changes > 0;
    },

    registerProject(name: string, rootPath: string, packageName: string | null = null): void {
      // One row per folder (checkouts spec §6.1): a second checkout adds a row,
      // and re-running in a folder updates only that folder's row.
      db.query(
        `INSERT INTO projects (name, root_path, package_name, created_at)
         VALUES ($name, $root, $pkg, $ts)
         ON CONFLICT(root_path) DO UPDATE SET
           name         = excluded.name,
           package_name = excluded.package_name`,
      ).run({ $name: name, $root: rootPath, $pkg: packageName, $ts: now() });
    },

    listProjects(): ProjectRecord[] {
      return db
        .query<{ name: string; root_path: string; package_name: string | null; created_at: number }, []>(
          "SELECT name, root_path, package_name, created_at FROM projects ORDER BY name, root_path",
        )
        .all()
        .map((r) => ({ name: r.name, rootPath: r.root_path, packageName: r.package_name, createdAt: r.created_at }));
    },

    appendAudit(entry: AuditEntry): void {
      db.query(
        `INSERT INTO audit_log (ts, event, scope, key, pid, process_name)
         VALUES ($ts, $event, $scope, $key, $pid, $proc)`,
      ).run({
        $ts: entry.ts,
        $event: entry.event,
        $scope: entry.scope,
        $key: entry.key,
        $pid: entry.pid,
        $proc: entry.processName,
      });
    },

    listAudit(limit: number): AuditEntry[] {
      return db
        .query<
          { ts: number; event: string; scope: string; key: string; pid: number | null; process_name: string | null },
          { $limit: number }
        >("SELECT ts, event, scope, key, pid, process_name FROM audit_log ORDER BY id DESC LIMIT $limit")
        .all({ $limit: limit })
        .map((r) => ({
          ts: r.ts,
          event: r.event,
          scope: r.scope,
          key: r.key,
          pid: r.pid,
          processName: r.process_name,
        }));
    },

    getMeta(key: string): string | null {
      const row = db
        .query<{ value: string }, { $key: string }>("SELECT value FROM vault_meta WHERE key = $key")
        .get({ $key: key });
      return row?.value ?? null;
    },

    setMeta(key: string, value: string): void {
      db.query(
        `INSERT INTO vault_meta (key, value) VALUES ($key, $value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run({ $key: key, $value: value });
    },

    close(): void {
      db.close();
    },
  };
}
