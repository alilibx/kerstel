import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 1;

/**
 * Ordered migrations. Index 0 takes the database from version 0 to version 1.
 * Never edit a shipped migration — append a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    root_path   TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE secrets (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    scope             TEXT    NOT NULL,
    project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    key               TEXT    NOT NULL,
    value_ciphertext  BLOB    NOT NULL,
    nonce             BLOB    NOT NULL,
    -- Reserved for environments (dev/staging/prod). Unused in v1; every row
    -- stores NULL so the column can join the unique index without migration.
    environment       TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE(scope, key)
  );

  CREATE INDEX secrets_scope_idx ON secrets(scope);

  CREATE TABLE audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    event         TEXT    NOT NULL,
    scope         TEXT    NOT NULL,
    key           TEXT    NOT NULL,
    pid           INTEGER,
    process_name  TEXT,
    project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL
  );

  CREATE INDEX audit_log_ts_idx ON audit_log(ts DESC);
  `,
];

export function migrate(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const current = row?.user_version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}
