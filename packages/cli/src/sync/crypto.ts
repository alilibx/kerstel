import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

/**
 * Sync's cryptography, `node:crypto` only. Sync spec §5 and §6. The server
 * sees none of the keys here and none of the plaintext they protect.
 */

const AES = "aes-256-gcm";
const NONCE = 12;
const TAG = 16;
/** Payloads are padded to a multiple of this, so a value's length hides within its bucket. */
export const PAD = 256;

function concat(...parts: (string | Buffer | number)[]): Buffer {
  return Buffer.concat(
    parts.map((p) => (typeof p === "number" ? Buffer.from(String(p)) : typeof p === "string" ? Buffer.from(p) : p)),
  );
}

/** AES-256-GCM: nonce ‖ ciphertext ‖ tag. */
function seal(key: Buffer, plaintext: Buffer, ad: Buffer): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv(AES, key, nonce);
  cipher.setAAD(ad);
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function open(key: Buffer, sealed: Buffer, ad: Buffer): Buffer {
  if (sealed.length < NONCE + TAG) throw new Error("Sealed data is too short.");
  const decipher = createDecipheriv(AES, key, sealed.subarray(0, NONCE));
  decipher.setAAD(ad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([decipher.update(sealed.subarray(NONCE, sealed.length - TAG)), decipher.final()]);
}

// ---- Device keys -------------------------------------------------------------

export interface DeviceKeys {
  /** Ed25519: signs every request and signs new devices in. */
  sign: KeyObject;
  /** X25519: receives the sync key, sealed to it. */
  enc: KeyObject;
}

export function generateDeviceKeys(): DeviceKeys {
  return { sign: generateKeyPairSync("ed25519").privateKey, enc: generateKeyPairSync("x25519").privateKey };
}

/** A raw 32-byte public key, base64url: what the server stores. */
export function publicKeyOf(key: KeyObject): string {
  return createPublicKey(key).export({ format: "jwk" }).x!;
}

/** A private key as PKCS#8 DER, base64url, for `vault_meta`, where it is stored sealed with the data key. */
export function exportPrivateKey(key: KeyObject): string {
  return key.export({ format: "der", type: "pkcs8" }).toString("base64url");
}

export function importPrivateKey(der: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(der, "base64url"), format: "der", type: "pkcs8" });
}

function x25519Public(raw: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw }, format: "jwk" });
}

/** A short fingerprint of a device's signing key, shown when pairing: `4F2A 91C0 7B3E`. */
export function fingerprint(signPub: string): string {
  const hex = createHmac("sha256", "kerstel fingerprint v1").update(Buffer.from(signPub, "base64url")).digest("hex");
  return hex.slice(0, 12).toUpperCase().replace(/(.{4})(?=.)/g, "$1 ");
}

// ---- Sealing the sync key to a device (§5.2) --------------------------------------

export interface KeyContext {
  vaultId: string;
  deviceId: string;
  epoch: number;
}

const keyAd = (c: KeyContext) => concat("kerstel sync-key v1\0", c.vaultId, "\0", c.deviceId, "\0", c.epoch);

/**
 * The sync key sealed to a device's X25519 public key: an ephemeral X25519
 * key, the shared secret through HKDF-SHA256 (salt: the vault ID), then
 * AES-256-GCM over the key with the vault, device and epoch as associated
 * data. Output: ephemeral public key ‖ nonce ‖ ciphertext ‖ tag, base64url.
 */
export function sealSyncKey(syncKey: Buffer, recipientEncPub: string, context: KeyContext): string {
  const ephemeral = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: x25519Public(recipientEncPub) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(context.vaultId), "kerstel sync-key v1", 32));
  const ephemeralPub = Buffer.from(publicKeyOf(ephemeral.privateKey), "base64url");
  return Buffer.concat([ephemeralPub, seal(key, syncKey, keyAd(context))]).toString("base64url");
}

export function openSyncKey(sealed: string, encKey: KeyObject, context: KeyContext): Buffer {
  const bytes = Buffer.from(sealed, "base64url");
  const ephemeralPub = bytes.subarray(0, 32).toString("base64url");
  const shared = diffieHellman({ privateKey: encKey, publicKey: x25519Public(ephemeralPub) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(context.vaultId), "kerstel sync-key v1", 32));
  return open(key, bytes.subarray(32), keyAd(context));
}

export function generateSyncKey(): Buffer {
  return randomBytes(32);
}

// ---- Record IDs (§6.1) ------------------------------------------------------

/** HMAC-SHA256(idKey, scope ‖ 0x00 ‖ key), 16 bytes, base64url; idKey from the sync key by HKDF. */
export function recordId(syncKey: Buffer, scope: string, key: string): string {
  const idKey = Buffer.from(hkdfSync("sha256", syncKey, Buffer.alloc(0), "kerstel record-id v1", 32));
  return createHmac("sha256", idKey).update(concat(scope, Buffer.from([0]), key)).digest().subarray(0, 16).toString("base64url");
}

// ---- Payloads (§6.2) ----------------------------------------------------------

export interface Payload {
  v: 1;
  scope: string;
  key: string;
  value: string | null;
  deleted: boolean;
  updatedAt: number;
  device: string;
}

export interface RecordContext {
  vaultId: string;
  recordId: string;
  epoch: number;
}

const recordAd = (c: RecordContext) => concat("kerstel record v1\0", c.vaultId, "\0", c.recordId, "\0", c.epoch);

/**
 * The payload as JSON, padded with spaces to a multiple of 256 bytes, sealed
 * under the sync key with the vault, record and epoch as associated data, so
 * a blob moved to another record or epoch fails to open.
 */
export function sealPayload(syncKey: Buffer, payload: Payload, context: RecordContext): string {
  const json = Buffer.from(JSON.stringify(payload));
  // Trailing spaces: JSON.parse ignores them, and they say nothing.
  const padded = Buffer.concat([json, Buffer.alloc((PAD - (json.length % PAD)) % PAD, " ")]);
  return seal(syncKey, padded, recordAd(context)).toString("base64url");
}

export function openPayload(syncKey: Buffer, blob: string, context: RecordContext): Payload {
  const parsed = JSON.parse(open(syncKey, Buffer.from(blob, "base64url"), recordAd(context)).toString("utf8")) as Payload;
  if (parsed?.v !== 1 || typeof parsed.scope !== "string" || typeof parsed.key !== "string") {
    throw new Error("A sync record has a payload this version of Kerstel does not read.");
  }
  return parsed;
}

// ---- Device names --------------------------------------------------------------

export interface DeviceName {
  name: string;
  platform: string;
}

const nameAd = (vaultId: string, deviceId: string) => concat("kerstel device-name v1\0", vaultId, "\0", deviceId);

/** A device's name and platform, sealed with the sync key: the server never sees them. */
export function sealName(syncKey: Buffer, vaultId: string, deviceId: string, name: DeviceName): string {
  return seal(syncKey, Buffer.from(JSON.stringify(name)), nameAd(vaultId, deviceId)).toString("base64url");
}

export function openName(syncKey: Buffer, vaultId: string, deviceId: string, sealed: string): DeviceName | null {
  try {
    const parsed = JSON.parse(open(syncKey, Buffer.from(sealed, "base64url"), nameAd(vaultId, deviceId)).toString("utf8"));
    return typeof parsed?.name === "string" ? { name: parsed.name, platform: String(parsed.platform ?? "") } : null;
  } catch {
    return null;
  }
}

/** Constant-time equality for HMACs and other secrets. */
export function same(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
