import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { cliActor, type AuditActor } from "../audit/actor";
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

export type AuditAction = "resolve" | "run" | "reveal" | "set" | "remove" | "sync" | "device";
export const AUDIT_ACTIONS: readonly AuditAction[] = ["resolve", "run", "reveal", "set", "remove", "sync", "device"];

export interface AuditEntry {
  ts: number;
  event: AuditAction;
  /** '' for a keyless row. */
  scope: string;
  /** '' for a keyless row. */
  key: string;
  pid: number | null;
  processName: string | null;
  /** The caller's parent process names, stored as JSON text. */
  chain?: string[] | null;
  /** Only selects `project_id` (deepest registered checkout containing it); never stored. */
  cwd?: string | null;
}

export interface AuditRow {
  id: number;
  ts: number;
  event: AuditAction;
  scope: string;
  key: string;
  pid: number | null;
  processName: string | null;
  chain: string[] | null;
  project: { name: string; rootPath: string } | null;
}

export interface AuditFilter {
  limit: number;
  scope?: string;
  key?: string;
  /** An empty list is the same as none: every action. */
  events?: AuditAction[];
  /** Rows at or after this timestamp. */
  since?: number;
}

export interface AuditCounts {
  reveals: number;
  appReads: number;
  processes: number;
  projects: number;
  changes: number;
}

export interface AppReadGroup {
  project: string | null;
  process: string;
  keys: string[];
  processes: number;
}

/** One key's sync bookkeeping. Sync spec §6.3. */
export interface SyncRow {
  scope: string;
  key: string;
  /** The server revision this copy is based on; 0 if it was never pushed. */
  baseRev: number;
  /** Changed here and not yet accepted by the server. */
  dirty: boolean;
  /** Raised by every local set or remove of this key. */
  change: number;
  /** The other device's record while a conflict is open. */
  conflict: { rev: number; blob: string | null } | null;
}

/** Marks a vault as synced: present once `ks sync setup` or `join` has run. */
export const SYNC_VAULT_META = "sync_vault_id";

export interface SyncTable {
  enabled(): boolean;
  /** Turns tracking on: every stored secret becomes dirty, to be pushed. */
  trackAll(): void;
  rows(): SyncRow[];
  row(ref: SecretRef): SyncRow | null;
  /**
   * Writes a pulled value, or deletes the secret for a pulled deletion,
   * without marking it dirty, and records `rev`. Only if the key has not
   * changed here since `expectedChange` was read: otherwise it does nothing
   * and returns false, and the next sync sees the local change.
   */
  applyRemote(ref: SecretRef, value: string | null, rev: number, expectedChange: number): boolean;
  /** The server holds `rev` for this key; clears `dirty` only if `change` is still `expectedChange`. */
  adopt(ref: SecretRef, rev: number, expectedChange: number): void;
  setConflict(ref: SecretRef, conflict: { rev: number; blob: string | null } | null): void;
  /** Keep this device's value over an open conflict: based on the other device's revision, still dirty. */
  keepLocal(ref: SecretRef, rev: number): void;
  /** Moves a row to the revision a key rotation gave its record, leaving `dirty` as it is. */
  rebase(ref: SecretRef, rev: number): void;
  /** Forget every row: sync is off. */
  clear(): void;
}

export interface Vault {
  setSecret(ref: SecretRef, value: string): void;
  getSecret(ref: SecretRef): string | null;
  listSecrets(scope?: string): SecretSummary[];
  removeSecret(ref: SecretRef): boolean;
  registerProject(name: string, rootPath: string, packageName?: string | null): void;
  listProjects(): ProjectRecord[];
  appendAudit(entry: AuditEntry): void;
  /** Writes an audit row stamped with this vault's actor. A null ref writes an empty scope and key. */
  record(event: AuditAction, ref: SecretRef | null): void;
  /** Newest first. A number means `{ limit: n }`. */
  listAudit(filter: number | AuditFilter): AuditRow[];
  auditCounts(filter: Omit<AuditFilter, "limit">): AuditCounts;
  /** `resolve` and `run` rows grouped by project and process, largest group first; `limit` bounds the groups. */
  appReadGroups(filter: AuditFilter): AppReadGroup[];
  /** Deletes rows with `ts` before the cutoff; returns how many. */
  pruneAudit(before: number): number;
  /** Reads a `vault_meta` row. Not secret -- see meta.ts. */
  getMeta(key: string): string | null;
  /** Writes a `vault_meta` row, replacing any existing value. */
  setMeta(key: string, value: string): void;
  /** Removes a `vault_meta` row. */
  deleteMeta(key: string): void;
  /** Runs `work` in one SQLite transaction: every write in it lands, or none does. */
  transaction<T>(work: () => T): T;
  sync: SyncTable;
  /** The vault file, so a sync can take the lock beside it. */
  readonly file: string;
  close(): void;
}

/** The WHERE clause and bindings for an audit filter; `extra` is ANDed on. */
function auditWhere(
  f: Omit<AuditFilter, "limit">,
  extra?: string,
): { where: string; params: Record<string, string | number> } {
  const clauses: string[] = extra ? [extra] : [];
  const params: Record<string, string | number> = {};
  if (f.scope !== undefined) {
    clauses.push("a.scope = $scope");
    params.$scope = f.scope;
  }
  if (f.key !== undefined) {
    clauses.push("a.key = $key");
    params.$key = f.key;
  }
  if (f.events && f.events.length > 0) {
    clauses.push(`a.event IN (${f.events.map((_, i) => `$ev${i}`).join(", ")})`);
    f.events.forEach((e, i) => (params[`$ev${i}`] = e));
  }
  if (f.since !== undefined) {
    clauses.push("a.ts >= $since");
    params.$since = f.since;
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/**
 * Opens (creating and migrating as needed) the encrypted vault.
 * `dataKey` comes from the OS credential store and is held in memory only.
 */
export function openVault(dataKey: Buffer, file?: string, options: { actor?: AuditActor } = {}): Vault {
  const actor = options.actor ?? cliActor();
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

  const insertAudit = (entry: AuditEntry): void => {
    const project = entry.cwd
      ? db
          .query<{ id: number }, { $cwd: string }>(
            `SELECT id FROM projects
             WHERE $cwd = root_path OR substr($cwd, 1, length(root_path) + 1) = root_path || '/'
             ORDER BY length(root_path) DESC LIMIT 1`,
          )
          .get({ $cwd: entry.cwd })
      : null;
    db.query(
      `INSERT INTO audit_log (ts, event, scope, key, pid, process_name, chain, project_id)
       VALUES ($ts, $event, $scope, $key, $pid, $proc, $chain, $project)`,
    ).run({
      $ts: entry.ts,
      $event: entry.event,
      $scope: entry.scope,
      $key: entry.key,
      $pid: entry.pid,
      $proc: entry.processName,
      $chain: entry.chain ? JSON.stringify(entry.chain) : null,
      $project: project?.id ?? null,
    });
  };

  /** One row for this vault's actor; runs inside the caller's transaction when there is one. */
  const record = (event: AuditAction, ref: SecretRef | null): void => {
    insertAudit({
      ts: now(),
      event,
      scope: ref?.scope ?? "",
      key: ref?.key ?? "",
      pid: actor.pid,
      processName: actor.processName,
      chain: actor.chain(),
      cwd: actor.cwd,
    });
  };

  const syncOn = (): boolean =>
    db.query<{ value: string }, [string]>("SELECT value FROM vault_meta WHERE key = ?").get(SYNC_VAULT_META) !== null;

  /** Sync spec §6.3: a local write marks the key dirty and raises `change`, in the writer's transaction. */
  const touch = (ref: SecretRef): void => {
    if (!syncOn()) return;
    db.query(
      `INSERT INTO sync_state (scope, key, base_rev, dirty, change, conflict)
       VALUES ($scope, $key, 0, 1, 1, NULL)
       ON CONFLICT(scope, key) DO UPDATE SET dirty = 1, change = change + 1`,
    ).run({ $scope: ref.scope, $key: ref.key });
  };

  const writeSecret = (ref: SecretRef, value: string): void => {
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
  };

  const deleteSecret = (ref: SecretRef): boolean =>
    db.query("DELETE FROM secrets WHERE scope = $scope AND key = $key").run({ $scope: ref.scope, $key: ref.key })
      .changes > 0;

  type RawSyncRow = { scope: string; key: string; base_rev: number; dirty: number; change: number; conflict: string | Uint8Array | null };
  const toRow = (r: RawSyncRow): SyncRow => ({
    scope: r.scope,
    key: r.key,
    baseRev: r.base_rev,
    dirty: r.dirty === 1,
    change: r.change,
    conflict: r.conflict === null ? null : JSON.parse(typeof r.conflict === "string" ? r.conflict : Buffer.from(r.conflict).toString("utf8")),
  });

  const sync: SyncTable = {
    enabled: syncOn,
    trackAll() {
      db.transaction(() => {
        db.exec(
          `INSERT INTO sync_state (scope, key, base_rev, dirty, change, conflict)
           SELECT scope, key, 0, 1, 1, NULL FROM secrets WHERE true
           ON CONFLICT(scope, key) DO UPDATE SET dirty = 1, change = change + 1`,
        );
      })();
    },
    rows() {
      return db
        .query<RawSyncRow, []>("SELECT scope, key, base_rev, dirty, change, conflict FROM sync_state ORDER BY scope, key")
        .all()
        .map(toRow);
    },
    row(ref) {
      const r = db
        .query<RawSyncRow, { $scope: string; $key: string }>(
          "SELECT scope, key, base_rev, dirty, change, conflict FROM sync_state WHERE scope = $scope AND key = $key",
        )
        .get({ $scope: ref.scope, $key: ref.key });
      return r ? toRow(r) : null;
    },
    applyRemote(ref, value, rev, expectedChange) {
      return db.transaction(() => {
        const current = sync.row(ref);
        if ((current?.change ?? 0) !== expectedChange) return false;
        if (value === null) deleteSecret(ref);
        else writeSecret(ref, value);
        db.query(
          `INSERT INTO sync_state (scope, key, base_rev, dirty, change, conflict)
           VALUES ($scope, $key, $rev, 0, 0, NULL)
           ON CONFLICT(scope, key) DO UPDATE SET base_rev = $rev, dirty = 0, conflict = NULL`,
        ).run({ $scope: ref.scope, $key: ref.key, $rev: rev });
        record("sync", ref);
        return true;
      })();
    },
    adopt(ref, rev, expectedChange) {
      // One statement: a write that raised `change` meanwhile keeps the row dirty.
      db.query(
        `UPDATE sync_state SET base_rev = $rev, dirty = CASE WHEN change = $change THEN 0 ELSE 1 END
         WHERE scope = $scope AND key = $key`,
      ).run({ $scope: ref.scope, $key: ref.key, $rev: rev, $change: expectedChange });
    },
    setConflict(ref, conflict) {
      db.query("UPDATE sync_state SET conflict = $c WHERE scope = $scope AND key = $key").run({
        $scope: ref.scope,
        $key: ref.key,
        $c: conflict === null ? null : JSON.stringify(conflict),
      });
    },
    keepLocal(ref, rev) {
      db.transaction(() => {
        db.query(
          "UPDATE sync_state SET base_rev = $rev, dirty = 1, conflict = NULL WHERE scope = $scope AND key = $key",
        ).run({ $scope: ref.scope, $key: ref.key, $rev: rev });
        record("sync", ref);
      })();
    },
    rebase(ref, rev) {
      db.query("UPDATE sync_state SET base_rev = $rev WHERE scope = $scope AND key = $key").run({
        $scope: ref.scope,
        $key: ref.key,
        $rev: rev,
      });
    },
    clear() {
      db.exec("DELETE FROM sync_state");
    },
  };

  return {
    file: target,
    sync,

    setSecret(ref: SecretRef, value: string): void {
      db.transaction(() => {
        writeSecret(ref, value);
        touch(ref);
        record("set", ref);
      })();
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
      return db.transaction(() => {
        const removed = deleteSecret(ref);
        // A removal syncs as a deletion; removing nothing changes nothing.
        if (removed) {
          touch(ref);
          record("remove", ref);
        }
        return removed;
      })();
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

    appendAudit: insertAudit,

    record,

    listAudit(filter: number | AuditFilter): AuditRow[] {
      const f = typeof filter === "number" ? { limit: filter } : filter;
      const { where, params } = auditWhere(f);
      return db
        .query<
          {
            id: number;
            ts: number;
            event: AuditAction;
            scope: string;
            key: string;
            pid: number | null;
            process_name: string | null;
            chain: string | null;
            project_name: string | null;
            project_root: string | null;
          },
          Record<string, string | number>
        >(
          `SELECT a.id, a.ts, a.event, a.scope, a.key, a.pid, a.process_name, a.chain,
                  p.name AS project_name, p.root_path AS project_root
           FROM audit_log a LEFT JOIN projects p ON p.id = a.project_id
           ${where} ORDER BY a.id DESC LIMIT $limit`,
        )
        .all({ ...params, $limit: f.limit })
        .map((r) => ({
          id: r.id,
          ts: r.ts,
          event: r.event,
          scope: r.scope,
          key: r.key,
          pid: r.pid,
          processName: r.process_name,
          chain: r.chain === null ? null : (JSON.parse(r.chain) as string[]),
          project: r.project_name === null ? null : { name: r.project_name, rootPath: r.project_root! },
        }));
    },

    auditCounts(filter: Omit<AuditFilter, "limit">): AuditCounts {
      const { where, params } = auditWhere(filter);
      const r = db
        .query<
          { reveals: number | null; app_reads: number | null; processes: number; projects: number; changes: number | null },
          Record<string, string | number>
        >(
          `SELECT
             SUM(a.event = 'reveal') AS reveals,
             SUM(a.event IN ('resolve', 'run')) AS app_reads,
             COUNT(DISTINCT CASE WHEN a.event IN ('resolve', 'run') THEN a.pid END) AS processes,
             COUNT(DISTINCT CASE WHEN a.event IN ('resolve', 'run') THEN p.name END) AS projects,
             SUM(a.event IN ('set', 'remove', 'sync', 'device')) AS changes
           FROM audit_log a LEFT JOIN projects p ON p.id = a.project_id ${where}`,
        )
        .get(params)!;
      return {
        reveals: r.reveals ?? 0,
        appReads: r.app_reads ?? 0,
        processes: r.processes,
        projects: r.projects,
        changes: r.changes ?? 0,
      };
    },

    appReadGroups(filter: AuditFilter): AppReadGroup[] {
      const { where, params } = auditWhere(filter, "a.event IN ('resolve', 'run')");
      return db
        .query<
          { project: string | null; process: string; keys: string; processes: number },
          Record<string, string | number>
        >(
          `SELECT project, process, json_group_array(DISTINCT key) AS keys,
                  COUNT(DISTINCT pid) AS processes
           FROM (
             SELECT p.name AS project, a.key AS key, a.pid AS pid,
                    CASE WHEN a.event = 'run' THEN 'kerstel run' ELSE COALESCE(a.process_name, 'unknown') END AS process
             FROM audit_log a LEFT JOIN projects p ON p.id = a.project_id
             ${where}
           )
           GROUP BY project, process
           ORDER BY COUNT(*) DESC, project, process
           LIMIT $limit`,
        )
        .all({ ...params, $limit: filter.limit })
        .map((r) => ({
          project: r.project,
          process: r.process,
          keys: (JSON.parse(r.keys) as string[]).sort(),
          processes: r.processes,
        }));
    },

    pruneAudit(before: number): number {
      return db.query("DELETE FROM audit_log WHERE ts < $before").run({ $before: before }).changes;
    },

    getMeta(key: string): string | null {
      const row = db
        .query<{ value: string }, { $key: string }>("SELECT value FROM vault_meta WHERE key = $key")
        .get({ $key: key });
      return row?.value ?? null;
    },

    transaction<T>(work: () => T): T {
      return db.transaction(work)();
    },

    deleteMeta(key: string): void {
      db.query("DELETE FROM vault_meta WHERE key = $key").run({ $key: key });
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
