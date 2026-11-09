import { decrypt, encrypt } from "../vault/crypto";
import { SYNC_VAULT_META, type Vault } from "../vault/store";
import { exportPrivateKey, importPrivateKey, type DeviceKeys } from "./crypto";

/**
 * Where a device keeps its sync settings: `vault_meta`. Sync spec §5.1 and
 * §6.3. The sync key and the device's private keys are sealed with the data
 * key, as every value in the vault is; the rest is not secret.
 */

const META = {
  vaultId: SYNC_VAULT_META,
  server: "sync_server",
  deviceId: "sync_device_id",
  epoch: "sync_epoch",
  syncKey: "sync_key",
  signKey: "sync_sign_key",
  encKey: "sync_enc_key",
  head: "sync_head",
  lastOk: "sync_last_ok",
  lastError: "sync_last_error",
} as const;

export interface SyncConfig {
  server: string;
  vaultId: string;
  deviceId: string;
  epoch: number;
  syncKey: Buffer;
  keys: DeviceKeys;
  /** The highest server revision this device has pulled. */
  head: number;
}

function sealed(value: string, dataKey: Buffer): string {
  const { ciphertext, nonce } = encrypt(value, dataKey);
  return `${nonce.toString("base64")}.${ciphertext.toString("base64")}`;
}

function unsealed(value: string, dataKey: Buffer): string {
  const [nonce, ciphertext] = value.split(".");
  return decrypt({ nonce: Buffer.from(nonce ?? "", "base64"), ciphertext: Buffer.from(ciphertext ?? "", "base64") }, dataKey);
}

export function loadSync(vault: Vault, dataKey: Buffer): SyncConfig | null {
  const get = (k: string) => vault.getMeta(k);
  const vaultId = get(META.vaultId);
  if (vaultId === null) return null;
  const need = (k: string): string => {
    const v = get(k);
    if (v === null) throw new Error(`This vault's sync settings are incomplete (${k} is missing). Run ks sync off, then set sync up again.`);
    return v;
  };
  return {
    server: need(META.server),
    vaultId,
    deviceId: need(META.deviceId),
    epoch: Number(need(META.epoch)),
    syncKey: Buffer.from(unsealed(need(META.syncKey), dataKey), "base64"),
    keys: {
      sign: importPrivateKey(unsealed(need(META.signKey), dataKey)),
      enc: importPrivateKey(unsealed(need(META.encKey), dataKey)),
    },
    head: Number(get(META.head) ?? "0"),
  };
}

/** Writes every setting. The vault ID goes last: it is what turns sync, and change tracking, on. */
export function saveSync(vault: Vault, dataKey: Buffer, config: SyncConfig): void {
  vault.setMeta(META.server, config.server);
  vault.setMeta(META.deviceId, config.deviceId);
  vault.setMeta(META.epoch, String(config.epoch));
  vault.setMeta(META.syncKey, sealed(config.syncKey.toString("base64"), dataKey));
  vault.setMeta(META.signKey, sealed(exportPrivateKey(config.keys.sign), dataKey));
  vault.setMeta(META.encKey, sealed(exportPrivateKey(config.keys.enc), dataKey));
  vault.setMeta(META.head, String(config.head));
  vault.setMeta(META.vaultId, config.vaultId);
}

export function saveHead(vault: Vault, head: number): void {
  vault.setMeta(META.head, String(head));
}

export function recordResult(vault: Vault, error: string | null): void {
  if (error === null) {
    vault.setMeta(META.lastOk, String(Date.now()));
    vault.deleteMeta(META.lastError);
  } else {
    vault.setMeta(META.lastError, error);
  }
}

export function lastResult(vault: Vault): { lastOk: number | null; lastError: string | null } {
  const ok = vault.getMeta(META.lastOk);
  return { lastOk: ok === null ? null : Number(ok), lastError: vault.getMeta(META.lastError) };
}

/** Turns sync off here: every setting and every row of `sync_state`. Secrets stay. */
export function forgetSync(vault: Vault): void {
  vault.deleteMeta(META.vaultId);
  for (const key of Object.values(META)) vault.deleteMeta(key);
  vault.sync.clear();
}

/** A server URL must be `https://`, or `http://` to this machine. Sync spec §7.1. */
export function isSafeServerUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
}

/** The URL without a trailing slash, so paths join cleanly. */
export function normaliseServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
