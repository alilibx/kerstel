/**
 * The wire protocol shared by `kerstel-server` and the `ks sync` client.
 * Sync spec §9.2. The client imports this module, so it holds no server state.
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";

export const PROTOCOL_PREFIX = "/v1";

/** Vault, device, pairing and record IDs: 16 random bytes, base64url, no padding. */
export const ID_BYTES = 16;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

export const LIMITS = {
  /** One sealed record, decoded. */
  recordBytes: 64 * 1024,
  recordsPerVault: 10_000,
  /** Every record of a vault together, decoded. */
  vaultBytes: 8 * 1024 * 1024,
  /** One request body. A key rotation re-uploads the whole vault, so this sits above vaultBytes. */
  bodyBytes: 12 * 1024 * 1024,
  devicesPerVault: 32,
  openPairingsPerVault: 3,
  /** A sealed sync key or a sealed device name, decoded. */
  sealedBytes: 1024,
  /** The new device's pairing post, decoded. */
  pairingBytes: 8 * 1024,
  /** Records per pull page. */
  pageSize: 500,
  maxPageSize: 1000,
} as const;

export const TIMING = {
  /** A signed request's timestamp may be this far from the server's clock. */
  clockSkewMs: 5 * 60_000,
  pairingTtlMs: 10 * 60_000,
  /** Tombstones older than this are dropped; a device further behind does a full pull. */
  tombstoneTtlMs: 90 * 24 * 60 * 60_000,
} as const;

export const HEADERS = {
  device: "kerstel-device",
  timestamp: "kerstel-timestamp",
  signature: "kerstel-signature",
  enrollToken: "kerstel-enroll-token",
} as const;

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "exists"
  | "epoch_mismatch"
  | "full_pull_required"
  | "last_device"
  | "pairing_used"
  | "vault_full"
  | "too_large"
  | "rate_limited"
  | "internal";

export interface ErrorBody {
  error: ErrorCode;
  message: string;
}

export function newId(): string {
  return randomBytes(ID_BYTES).toString("base64url");
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

/** Decoded length of a base64url string, or -1 when it is not one. */
export function base64urlBytes(value: unknown): number {
  if (typeof value !== "string" || !BASE64URL_RE.test(value) || value.length % 4 === 1) return -1;
  return Math.floor((value.length * 3) / 4);
}

/** A raw 32-byte public key (Ed25519 or X25519), base64url. */
export function isPublicKey(value: unknown): value is string {
  return base64urlBytes(value) === 32;
}

/**
 * The exact bytes a device signs. The body is hashed, so a large push signs
 * 32 bytes, and the path includes the query string, so a pull's `since`
 * cannot be changed in transit.
 */
export function signingString(method: string, pathAndQuery: string, timestamp: string, body: Uint8Array): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `kerstel-request-v1\n${method.toUpperCase()}\n${pathAndQuery}\n${timestamp}\n${bodyHash}`;
}

export function ed25519PublicKey(raw: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw }, format: "jwk" });
}

export interface SigningKey {
  /** Raw 32-byte public key, base64url: what the server stores. */
  publicKey: string;
  privateKey: KeyObject;
}

export function generateSigningKey(): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  return { publicKey: jwk.x!, privateKey };
}

/** The three headers that authenticate a request as `deviceId`. */
export function signRequest(
  key: KeyObject,
  deviceId: string,
  method: string,
  pathAndQuery: string,
  body: Uint8Array,
  now: number = Date.now(),
): Record<string, string> {
  const timestamp = String(now);
  const signature = sign(null, Buffer.from(signingString(method, pathAndQuery, timestamp, body)), key);
  return {
    [HEADERS.device]: deviceId,
    [HEADERS.timestamp]: timestamp,
    [HEADERS.signature]: signature.toString("base64url"),
  };
}

export function verifySignature(publicKey: string, message: string, signature: string): boolean {
  if (base64urlBytes(signature) !== 64) return false;
  try {
    return verify(null, Buffer.from(message), ed25519PublicKey(publicKey), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

// ---- Request and response bodies -------------------------------------------

export interface DeviceInput {
  id: string;
  /** Ed25519, raw, base64url. */
  signPub: string;
  /** X25519, raw, base64url. */
  encPub: string;
  /** The device name sealed with the sync key. The server cannot read it. */
  sealedName: string;
}

export interface CreateVaultBody {
  vaultId: string;
  device: DeviceInput;
  /** The first sync key, sealed to `device.encPub`. Epoch 1. */
  sealedKey: string;
}

export interface RecordOut {
  id: string;
  rev: number;
  /** The sealed payload, or null for a deletion. */
  blob: string | null;
}

export interface PullResponse {
  epoch: number;
  head: number;
  records: RecordOut[];
  more: boolean;
}

export interface PushBody {
  epoch: number;
  records: { id: string; baseRev: number; blob: string | null }[];
}

export interface PushResponse {
  head: number;
  accepted: { id: string; rev: number }[];
  /** The server's copy of each record whose baseRev was stale. */
  conflicts: RecordOut[];
}

export interface AddDeviceBody {
  device: DeviceInput;
  epoch: number;
  /** The current sync key, sealed to `device.encPub`. */
  sealedKey: string;
  /** The pairing slot this device answered, which is marked accepted. */
  pairingId?: string;
}

export interface DeviceOut {
  id: string;
  signPub: string;
  encPub: string;
  sealedName: string;
  addedAt: number;
  addedBy: string | null;
  lastSeen: number | null;
}

export interface RotateBody {
  epoch: number;
  removeDevices: string[];
  /** The new sync key, sealed to every device that stays, keyed by device ID. */
  sealedKeys: Record<string, string>;
  /** Every live record, re-encrypted under the new key with its new ID. */
  records: { id: string; blob: string }[];
}

export interface PairingSlotOut {
  payload: string | null;
  expiresAt: number;
}

export type PairingStateOut = { state: "waiting" } | { state: "accepted"; vaultId: string };
