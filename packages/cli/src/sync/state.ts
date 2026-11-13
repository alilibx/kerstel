import { formatPin, isHttps, parsePin } from "../../../server/src/pin";
import { cliName } from "../ui/cli-name";
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
  /** The server's first address, as 0.3 reads it. */
  server: "sync_server",
  /** Every address of the server, in the order they are tried, one per line. No row: `server` alone, as 0.3 wrote it. */
  servers: "sync_servers",
  /** The address that answered the last successful sync. */
  lastAddress: "sync_last_address",
  /** The server's key pin (#112), as `formatPin` writes it. No row: the server is not pinned. */
  pin: "sync_pin",
  deviceId: "sync_device_id",
  epoch: "sync_epoch",
  syncKey: "sync_key",
  signKey: "sync_sign_key",
  encKey: "sync_enc_key",
  head: "sync_head",
  lastOk: "sync_last_ok",
  lastError: "sync_last_error",
  /** When a sync last finished, either way: `run` and `exec` also count when one started (the `sync-spawned` file), since a child that crashes never writes this. */
  lastTry: "sync_last_try",
  /** Set with a new key until the full pull that follows it finishes. */
  fullPull: "sync_full_pull",
  /** When the pull timer last started a sync, in ms. */
  lastTimer: "sync_last_timer",
  /** Set once this device has been told it can't schedule pulls. */
  timerNoted: "sync_timer_noted",
} as const;

export interface SyncConfig {
  /** The server's addresses, at least one, in the order they are tried: its `.local` name and its LAN IP, say. */
  servers: string[];
  /** The SHA-256 of the server's public key, when this device pins it (#112). */
  pin: Buffer | null;
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

/**
 * This vault's sync settings are incomplete or cannot be read. Every sync
 * command says to run `sync off`, which turns sync off on this one alone.
 */
export class SyncSettingsError extends Error {
  constructor(problem: string) {
    super(`This vault's sync settings are ${problem}. Run ${cliName()} sync off, then set sync up again.`);
    this.name = "SyncSettingsError";
  }
}

/**
 * The sync settings, or null when sync is off. Settings that are missing or
 * can't be read throw a SyncSettingsError; an error reading the vault itself
 * is thrown as it is.
 */
export function loadSync(vault: Vault, dataKey: Buffer): SyncConfig | null {
  const get = (k: string) => vault.getMeta(k);
  const vaultId = get(SYNC_META.vaultId);
  if (vaultId === null) return null;
  const need = (k: string): string => {
    const v = get(k);
    if (v === null) throw new SyncSettingsError(`incomplete (${k} is missing)`);
    return v;
  };
  /** The sealed setting `k`, opened and read with `read`. */
  const open = <T>(k: string, read: (text: string) => T): T => {
    const text = need(k);
    try {
      return read(unsealed(text, dataKey));
    } catch {
      throw new SyncSettingsError(`damaged (${k} cannot be read)`);
    }
  };
  const pinText = get(SYNC_META.pin);
  const pin = pinText === null ? null : parsePin(pinText);
  // Never read as unpinned: that would drop the pin's protection without a word.
  if (pinText !== null && pin === null) throw new SyncSettingsError(`damaged (${SYNC_META.pin} is not a pin)`);
  const server = need(SYNC_META.server);
  if (pin && !isHttps(server)) throw new SyncSettingsError(`damaged (${SYNC_META.pin} is set for an http:// server)`);
  const servers = readServers(server, get(SYNC_META.servers));
  if (pin && !servers.every(isHttps)) throw new SyncSettingsError(`damaged (${SYNC_META.pin} is set for an http:// server)`);
  return {
    servers,
    pin,
    vaultId,
    deviceId: need(SYNC_META.deviceId),
    epoch: Number(need(SYNC_META.epoch)),
    syncKey: open(SYNC_META.syncKey, (text) => Buffer.from(text, "base64")),
    keys: {
      sign: open(SYNC_META.signKey, importPrivateKey),
      enc: open(SYNC_META.encKey, importPrivateKey),
    },
    head: Number(get(SYNC_META.head) ?? "0"),
  };
}

/**
 * The addresses in `sync_servers`, or `[server]` for a vault without the row.
 * A row that does not start with `server` was left by an older Kerstel, which
 * knows only `sync_server`: its `sync off` keeps the row and its `setup`
 * writes `sync_server` alone. It names another server, so it is not used.
 */
function readServers(server: string, row: string | null): string[] {
  if (row === null) return [server];
  const servers = row.split("\n");
  if (servers.some((url) => url === "")) throw new SyncSettingsError(`damaged (${SYNC_META.servers} is empty)`);
  if (!servers.every(isSafeServerUrl)) {
    throw new SyncSettingsError(`damaged (${SYNC_META.servers} names a server Kerstel will not send your vault to)`);
  }
  return servers[0] === server ? servers : [server];
}

/**
 * The address to name for this device's server: the one that answered last,
 * while it is still one of `servers`, or the first.
 */
export function shownAddress(servers: string[], last: string | null): string {
  return last !== null && servers.includes(last) ? last : servers[0]!;
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
  // The first address stays in `sync_server`, so an older Kerstel still reads this vault.
  vault.setMeta(SYNC_META.server, config.servers[0]!);
  vault.setMeta(SYNC_META.servers, config.servers.join("\n"));
  if (config.pin) vault.setMeta(SYNC_META.pin, formatPin(config.pin));
  else vault.deleteMeta(SYNC_META.pin);
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

/** Records how a sync ended. `address` is the one that answered a sync that succeeded, when the client knows it. */
export function recordResult(vault: Vault, error: string | null, address: string | null = null): void {
  vault.setMeta(SYNC_META.lastTry, String(Date.now()));
  if (error === null) {
    vault.setMeta(SYNC_META.lastOk, String(Date.now()));
    if (address !== null) vault.setMeta(SYNC_META.lastAddress, address);
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
