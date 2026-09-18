import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 2;

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
