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

/**
 * A device's name and platform, and the public keys it was added with. The
 * keys are sealed in with the name: only a device holding the sync key can
 * seal one, so a server that swaps a device's listed key for its own breaks
 * the match, and a key rotation refuses to seal the new key to it.
 */
export interface DeviceName {
  name: string;
  platform: string;
  signPub: string;
  encPub: string;
}

const nameAd = (vaultId: string, deviceId: string) => concat("kerstel device-name v1\0", vaultId, "\0", deviceId);

/** Sealed with the sync key: the server never sees the name, and cannot make one. */
export function sealName(syncKey: Buffer, vaultId: string, deviceId: string, name: DeviceName): string {
  return seal(syncKey, Buffer.from(JSON.stringify(name)), nameAd(vaultId, deviceId)).toString("base64url");
}

export function openName(syncKey: Buffer, vaultId: string, deviceId: string, sealed: string): DeviceName | null {
  try {
    const parsed = JSON.parse(open(syncKey, Buffer.from(sealed, "base64url"), nameAd(vaultId, deviceId)).toString("utf8"));
    const fields = [parsed?.name, parsed?.platform, parsed?.signPub, parsed?.encPub];
    return fields.every((f) => typeof f === "string")
      ? { name: parsed.name, platform: parsed.platform, signPub: parsed.signPub, encPub: parsed.encPub }
      : null;
  } catch {
    return null;
  }
}

/**
 * A device as the server lists it, checked: its name, only when the name
 * opens under the sync key and the keys sealed in it are the keys listed.
 */
export function verifiedName(
  syncKey: Buffer,
  vaultId: string,
  device: { id: string; signPub: string; encPub: string; sealedName: string },
): DeviceName | null {
  const name = openName(syncKey, vaultId, device.id, device.sealedName);
  return name && name.signPub === device.signPub && name.encPub === device.encPub ? name : null;
}

/** Constant-time equality for HMACs and other secrets. */
export function same(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Pairing (§7.1) ----------------------------------------------------------

/** 120 bits: long enough that the server, which sees the pairing post, cannot guess it offline. */
export const PAIRING_SECRET_BYTES = 15;
/** Crockford's base32: no I, L, O or U, so a code read aloud or retyped survives. */
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newPairingSecret(): Buffer {
  return randomBytes(PAIRING_SECRET_BYTES);
}

/** `KS-7Q2M-XR4P-9DKT-BW3H-6YFN-CJ8A`: the secret, 24 base32 characters in groups of four. */
export function pairingCode(secret: Buffer): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of secret) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return `KS-${out.match(/.{4}/g)!.join("-")}`;
}

/**
 * The secret in a pairing code, or null when it is not one. Case, dashes and
 * spaces don't matter, and the letters people misread as digits (O, I, L) count as them.
 */
export function parsePairingCode(code: string): Buffer | null {
  const body = code
    .trim()
    .toUpperCase()
    .replace(/^KS-?/, "")
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (body.length !== (PAIRING_SECRET_BYTES * 8) / 5) return null;
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const char of body) {
    const v = BASE32.indexOf(char);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >> (bits - 8)) & 255);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

const derive = (secret: Buffer, info: string, bytes: number) => Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), info, bytes));

/**
 * The pairing slot's ID, derived from the secret, so the code carries both in
 * 24 characters. The server sees the ID; one-way derivation keeps it from
 * telling the server anything about the secret.
 */
export function pairingIdOf(secret: Buffer): string {
  return derive(secret, "kerstel pairing-id v1", 16).toString("base64url");
}

/** What the new device posts to the pairing slot: its public keys and the name it goes by. */
export interface PairingAnswer {
  v: 1;
  deviceId: string;
  signPub: string;
  encPub: string;
  name: string;
  platform: string;
}

const pairingAd = (pairingId: string) => concat("kerstel pairing v1\0", pairingId);

/**
 * The answer, sealed with a key derived from the pairing secret and padded
 * like a record. Only a device holding the code can write one the other
 * device opens, and the server cannot read the name.
 */
export function sealPairingAnswer(secret: Buffer, answer: PairingAnswer): string {
  const json = Buffer.from(JSON.stringify(answer));
  const padded = Buffer.concat([json, Buffer.alloc((PAD - (json.length % PAD)) % PAD, " ")]);
  return seal(derive(secret, "kerstel pairing v1", 32), padded, pairingAd(pairingIdOf(secret))).toString("base64url");
}

/** The answer, or null when it was not sealed with this code's secret. */
export function openPairingAnswer(secret: Buffer, sealed: string): PairingAnswer | null {
  try {
    const parsed = JSON.parse(
      open(derive(secret, "kerstel pairing v1", 32), Buffer.from(sealed, "base64url"), pairingAd(pairingIdOf(secret))).toString("utf8"),
    ) as PairingAnswer;
    const fields = [parsed?.deviceId, parsed?.signPub, parsed?.encPub, parsed?.name, parsed?.platform];
    return parsed?.v === 1 && fields.every((f) => typeof f === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Spec §7.1: HMAC(pairing secret, "kerstel pairing-confirm v1" ‖ vault ‖
 * new device ‖ epoch ‖ sealed key). The device that confirms the pairing
 * makes it; the new device checks it before trusting the key, so a key the
 * server sealed itself is refused.
 */
export function pairingConfirmation(secret: Buffer, c: { vaultId: string; deviceId: string; epoch: number; sealedKey: string }): string {
  return createHmac("sha256", secret)
    .update(concat("kerstel pairing-confirm v1\0", c.vaultId, "\0", c.deviceId, "\0", c.epoch, "\0", c.sealedKey))
    .digest()
    .toString("base64url");
}
