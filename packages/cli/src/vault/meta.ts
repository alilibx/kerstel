import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { decrypt, encrypt } from "./crypto";

/** Which credential store minted the data key this vault is encrypted with. */
export const META_KEYCHAIN_BACKEND = "keychain_backend";
/** A fixed constant sealed with the data key, used to detect a wrong key. */
export const META_KEY_CHECK = "key_check";

/**
 * The plaintext behind `key_check`. A fixed, non-secret 32-byte constant: its
 * only job is to be something we can try to decrypt. Never change it -- every
 * vault in the field has this sealed under its own key, and a different value
 * here would read as "wrong key" on every existing install.
 */
const KEY_CHECK_PLAINTEXT = "kerstel/key-check/v1/aaaaaaaaaa";

/**
 * Reads `vault_meta` WITHOUT the data key.
 *
 * The ordering problem this solves: `vault_meta` says whether it is safe to go
 * and fetch a key, so it cannot be behind the key. openVault() needs a key to
 * hand out secrets, but the metadata is not secret and the table is plain
 * SQLite, so a separate read-only handle answers the question before any
 * keychain call happens.
 *
 * Returns an empty map for a vault that does not exist yet, and for an older vault
 * that predates the table. Both mean "nothing recorded", which the caller
 * handles by recording the current state rather than by refusing.
 */
export function readVaultMeta(file: string): Record<string, string> {
  if (!existsSync(file)) return {};

  let db: Database | null = null;
  try {
    // readonly so this can never create the file, migrate it, or take a write
    // lock on a vault another process is using.
    db = new Database(file, { readonly: true });
    const rows = db
      .query<{ key: string; value: string }, []>("SELECT key, value FROM vault_meta")
      .all();
    const out: Record<string, string> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  } catch {
    // No such table (an older vault), or an unreadable file. Either way there is
    // nothing recorded; the caller must not treat that as a mismatch.
    return {};
  } finally {
    db?.close();
  }
}

/**
 * Every `scope/KEY` the vault holds, read WITHOUT the data key.
 *
 * Scope and key names are stored in the clear (only values are encrypted), so
 * `init --dry-run` can tell which references a vault lacks without opening the
 * vault, touching the credential store, or writing anything. Empty for a vault
 * that does not exist yet.
 */
export function readStoredReferences(file: string): Set<string> {
  if (!existsSync(file)) return new Set();

  let db: Database | null = null;
  try {
    db = new Database(file, { readonly: true });
    const rows = db.query<{ scope: string; key: string }, []>("SELECT scope, key FROM secrets").all();
    return new Set(rows.map((row) => `${row.scope}/${row.key}`));
  } catch {
    return new Set();
  } finally {
    db?.close();
  }
}

/** Seals the key-check constant for storage in `vault_meta`. */
export function sealKeyCheck(dataKey: Buffer): string {
  const { ciphertext, nonce } = encrypt(KEY_CHECK_PLAINTEXT, dataKey);
  return `${nonce.toString("base64")}.${ciphertext.toString("base64")}`;
}

/**
 * True when `stored` was sealed with `dataKey`.
 *
 * A malformed or truncated value answers false: it is not evidence the key is
 * right, and the safe reading of "cannot verify" is "do not proceed".
 */
export function verifyKeyCheck(stored: string, dataKey: Buffer): boolean {
  const [nonce, ciphertext] = stored.split(".");
  if (!nonce || !ciphertext) return false;
  try {
    const plaintext = decrypt(
      { nonce: Buffer.from(nonce, "base64"), ciphertext: Buffer.from(ciphertext, "base64") },
      dataKey,
    );
    return plaintext === KEY_CHECK_PLAINTEXT;
  } catch {
    // GCM auth failure -- the expected shape of "wrong key".
    return false;
  }
}

/**
 * The error raised when the session's credential store is not the one holding
 * the vault's key. Carries no key material, only backend names.
 */
export function backendMismatchError(recorded: string, selected: string): Error {
  const where =
    recorded === "macos"
      ? "the macOS Keychain, which is not reachable in this session (locked keychain / no GUI)"
      : recorded === "windows"
        ? "the Windows Credential Manager, which is not reachable in this session"
        : recorded === "linux"
          ? "the Secret Service, which is not reachable in this session (no D-Bus session bus)"
          : `the "${recorded}" credential store, which is not reachable in this session`;

  return new Error(
    `Kerstel's vault key was created in ${where}. This session would otherwise use ` +
      `the "${selected}" backend instead, which holds a different key: every secret ` +
      "already in the vault would fail to decrypt, and anything stored now would be " +
      "unreadable from your normal session. Unlock it or run from a GUI session. " +
      "Kerstel will not create a second key.",
  );
}
