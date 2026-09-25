import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 3;

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
    -- Reserved for environments (dev/staging/prod). Unused for now; every row
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

  // v2: unencrypted bookkeeping about the vault itself.
  //
  // Holds two rows, neither of them secret:
  //   keychain_backend -- which credential store minted the data key. Without
  //     it, a session where the native backend is unavailable (macOS over SSH
  //     with a locked login keychain) silently falls through to the file
  //     backend, finds no key, and mints a SECOND one -- leaving every existing
  //     secret undecryptable here and anything written here undecryptable
  //     everywhere else.
  //   key_check -- a fixed constant sealed with the data key, so a wrong key is
  //     caught on open rather than on whichever secret is touched first.
  //
  // Deliberately readable without the key: it has to be consulted BEFORE the
  // key is fetched, since its whole job is to decide whether fetching one is
  // safe. See meta.ts.
  `
  CREATE TABLE vault_meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
  `,

  // v3: one row per checkout (#13, checkouts spec §6.1).
  //
  // v2 keyed projects on `name`, so a second checkout of one package (a git
  // worktree) replaced the first one's root, and `uninstall` restored only the
  // folder it happened to remember. Now `root_path` is the key and a scope can
  // hold any number of rows. `package_name` tells a second checkout of the same
  // package from an unrelated package whose name slugifies the same.
  //
  // Rebuilt rather than altered: SQLite cannot drop a UNIQUE constraint. The
  // new table is created under another name, filled, and renamed into place
  // AFTER the old one is dropped. Renaming the old table first would rewrite
  // the REFERENCES clauses in `secrets` and `audit_log` to follow it. Every
  // `id` is kept, but migrate() turns foreign keys on, so DROP TABLE's implicit
  // DELETE fires ON DELETE SET NULL: any `secrets.project_id` or
  // `audit_log.project_id` set would be cleared. No code writes either column,
  // so nothing is lost. A v2 vault can hold two rows for one folder (`init --scope a`,
  // then `--scope b`); the newest one per folder is kept.
  `
  CREATE TABLE projects_v3 (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    root_path     TEXT    NOT NULL UNIQUE,
    package_name  TEXT,
    created_at    INTEGER NOT NULL
  );

  INSERT INTO projects_v3 (id, name, root_path, package_name, created_at)
    SELECT id, name, root_path, NULL, created_at FROM projects p
    WHERE NOT EXISTS (
      SELECT 1 FROM projects q
      WHERE q.root_path = p.root_path
        AND (q.created_at > p.created_at OR (q.created_at = p.created_at AND q.id > p.id))
    );

  DROP TABLE projects;
  ALTER TABLE projects_v3 RENAME TO projects;
  CREATE INDEX projects_name_idx ON projects(name);
  `,
];

export function migrate(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Two Kerstel processes legitimately hold the vault at once -- a `daemon
  // serve` resolving for a running app while the user types `kerstel set` in a
  // terminal. WAL lets them read concurrently, but a writer still has to wait
  // for the writer ahead of it, and SQLite's default is to not wait at all:
  // the second writer gets SQLITE_BUSY immediately, surfacing as a failed
  // command for what is a few milliseconds of contention. Wait instead.
  db.exec("PRAGMA busy_timeout = 5000");

  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const current = row?.user_version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}
