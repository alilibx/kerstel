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
  registerProject(name: string, rootPath: string): void;
  listProjects(): ProjectRecord[];
  appendAudit(entry: AuditEntry): void;
  listAudit(limit: number): AuditEntry[];
  close(): void;
}

/**
 * Opens (creating and migrating as needed) the encrypted vault.
 * `dataKey` comes from the OS credential store and is held in memory only.
 */
export function openVault(dataKey: Buffer, file?: string): Vault {
  const target = file ?? vaultPath();
  if (!file) ensureHome();

  const isNew = !existsSync(target);
  const db = new Database(target, { create: true });
  migrate(db);
  if (isNew && process.platform !== "win32") chmodSync(target, 0o600);

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

    registerProject(name: string, rootPath: string): void {
      db.query(
        `INSERT INTO projects (name, root_path, created_at)
         VALUES ($name, $root, $ts)
         ON CONFLICT(name) DO UPDATE SET root_path = excluded.root_path`,
      ).run({ $name: name, $root: rootPath, $ts: now() });
    },

    listProjects(): ProjectRecord[] {
      return db
        .query<{ name: string; root_path: string; created_at: number }, []>(
          "SELECT name, root_path, created_at FROM projects ORDER BY name",
        )
        .all()
        .map((r) => ({ name: r.name, rootPath: r.root_path, createdAt: r.created_at }));
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

    close(): void {
      db.close();
    },
  };
}
