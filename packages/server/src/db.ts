import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";

export const SCHEMA_VERSION = 1;

/**
 * Ordered migrations, as in the CLI's vault. Never edit a shipped one.
 *
 * Nothing here is plaintext a user wrote. Records, sealed keys and sealed
 * device names are ciphertext the server cannot open; IDs are random. What the
 * server learns is the sync spec §4 table: counts, sizes, timing, and which
 * opaque record changed.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE vaults (
    id          TEXT    PRIMARY KEY,
    epoch       INTEGER NOT NULL,
    -- The revision of the vault's latest change. Every accepted record gets head + 1.
    head        INTEGER NOT NULL DEFAULT 0,
    -- A pull whose cursor is below this must start again from 0: tombstones up
    -- to here may be gone, and a key rotation replaces every record ID.
    pruned_rev  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE devices (
    vault_id     TEXT    NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    id           TEXT    NOT NULL,
    sign_pub     TEXT    NOT NULL,
    enc_pub      TEXT    NOT NULL,
    sealed_name  TEXT    NOT NULL,
    added_at     INTEGER NOT NULL,
    added_by     TEXT,
    last_seen    INTEGER,
    PRIMARY KEY (vault_id, id)
  );

  -- The current epoch's sync key, sealed to each device. Older epochs are deleted on rotation.
  CREATE TABLE sealed_keys (
    vault_id   TEXT    NOT NULL,
    device_id  TEXT    NOT NULL,
    epoch      INTEGER NOT NULL,
    sealed     TEXT    NOT NULL,
    PRIMARY KEY (vault_id, device_id),
    FOREIGN KEY (vault_id, device_id) REFERENCES devices(vault_id, id) ON DELETE CASCADE
  );

  CREATE TABLE records (
    vault_id    TEXT    NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    id          TEXT    NOT NULL,
    rev         INTEGER NOT NULL,
    blob        TEXT,               -- NULL is a deletion (tombstone)
    size        INTEGER NOT NULL,   -- decoded bytes of blob, 0 for a tombstone
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (vault_id, id)
  );

  CREATE INDEX records_rev_idx ON records(vault_id, rev);

  CREATE TABLE pairings (
    id               TEXT    PRIMARY KEY,
    vault_id         TEXT    NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    created_by       TEXT    NOT NULL,
    payload          TEXT,
    accepted_device  TEXT,
    -- HMAC(pairingSecret, "kerstel pairing-confirm v1" ‖ vaultId ‖ deviceId ‖ epoch ‖ sealedKey),
    -- from the device that accepted. The server cannot compute or check it;
    -- the new device checks it before trusting the sealed key. Spec §7.1.
    confirmation     TEXT,
    expires_at       INTEGER NOT NULL
  );

  -- Signatures already accepted, kept until their timestamp could no longer pass.
  CREATE TABLE seen_signatures (
    signature   TEXT    PRIMARY KEY,
    expires_at  INTEGER NOT NULL
  );
  `,
];

export function openDatabase(file: string): Database {
  const db = new Database(file, { create: true });
  if (file !== ":memory:" && process.platform !== "win32") {
    for (const path of [file, `${file}-wal`, `${file}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const current = row?.user_version ?? 0;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `${file} uses database schema ${current}, newer than this kerstel-server supports (${MIGRATIONS.length}). Upgrade kerstel-server.`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
  return db;
}
