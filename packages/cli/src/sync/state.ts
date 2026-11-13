import { decrypt, encrypt } from "../vault/crypto";
import { SYNC_VAULT_META, type Vault } from "../vault/store";
import { exportPrivateKey, importPrivateKey, type DeviceKeys } from "./crypto";

/**
 * Where a device keeps its sync settings: `vault_meta`. Sync spec §5.1 and
 * §6.3. The sync key and the device's private keys are sealed with the data
 * key, as every value in the vault is; the rest is not secret.
 */

export const SYNC_META = {
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
  /** When a sync last finished, either way: background syncs wait five minutes after it. */
  lastTry: "sync_last_try",
  /** Set with a new key until the full pull that follows it finishes. */
  fullPull: "sync_full_pull",
  /** When the pull timer last started a sync, in ms. */
  lastTimer: "sync_last_timer",
  /** Set once this device has been told it can't schedule pulls. */
  timerNoted: "sync_timer_noted",
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
  const vaultId = get(SYNC_META.vaultId);
  if (vaultId === null) return null;
  const need = (k: string): string => {
    const v = get(k);
    if (v === null) throw new Error(`This vault's sync settings are incomplete (${k} is missing). Run ks sync off, then set sync up again.`);
    return v;
  };
  return {
    server: need(SYNC_META.server),
    vaultId,
    deviceId: need(SYNC_META.deviceId),
    epoch: Number(need(SYNC_META.epoch)),
    syncKey: Buffer.from(unsealed(need(SYNC_META.syncKey), dataKey), "base64"),
    keys: {
      sign: importPrivateKey(unsealed(need(SYNC_META.signKey), dataKey)),
      enc: importPrivateKey(unsealed(need(SYNC_META.encKey), dataKey)),
    },
    head: Number(get(SYNC_META.head) ?? "0"),
  };
}

/**
 * Writes every setting in one transaction, so an interrupted write never pairs
 * a new epoch with the old key. The vault ID turns sync, and change tracking, on.
 */
export function saveSync(vault: Vault, dataKey: Buffer, config: SyncConfig): void {
  vault.transaction(() => writeSync(vault, dataKey, config));
}

/** `saveSync` without its own transaction, for a caller that holds one. */
export function writeSync(vault: Vault, dataKey: Buffer, config: SyncConfig): void {
  vault.setMeta(SYNC_META.server, config.server);
  vault.setMeta(SYNC_META.deviceId, config.deviceId);
  vault.setMeta(SYNC_META.epoch, String(config.epoch));
  vault.setMeta(SYNC_META.syncKey, sealed(config.syncKey.toString("base64"), dataKey));
  vault.setMeta(SYNC_META.signKey, sealed(exportPrivateKey(config.keys.sign), dataKey));
  vault.setMeta(SYNC_META.encKey, sealed(exportPrivateKey(config.keys.enc), dataKey));
  vault.setMeta(SYNC_META.head, String(config.head));
  vault.setMeta(SYNC_META.vaultId, config.vaultId);
}

export function needsFullPull(vault: Vault): boolean {
  return vault.getMeta(SYNC_META.fullPull) !== null;
}

export function setFullPull(vault: Vault, on: boolean): void {
  if (on) vault.setMeta(SYNC_META.fullPull, "1");
  else vault.deleteMeta(SYNC_META.fullPull);
}

export function saveHead(vault: Vault, head: number): void {
  vault.setMeta(SYNC_META.head, String(head));
}

export function recordResult(vault: Vault, error: string | null): void {
  vault.setMeta(SYNC_META.lastTry, String(Date.now()));
  if (error === null) {
    vault.setMeta(SYNC_META.lastOk, String(Date.now()));
    vault.deleteMeta(SYNC_META.lastError);
  } else {
    vault.setMeta(SYNC_META.lastError, error);
  }
}

export function lastResult(vault: Vault): { lastOk: number | null; lastError: string | null } {
  const ok = vault.getMeta(SYNC_META.lastOk);
  return { lastOk: ok === null ? null : Number(ok), lastError: vault.getMeta(SYNC_META.lastError) };
}

/** Turns sync off here: every setting and every row of `sync_state`. Secrets stay. */
export function forgetSync(vault: Vault): void {
  vault.deleteMeta(SYNC_META.vaultId);
  for (const key of Object.values(SYNC_META)) vault.deleteMeta(key);
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
