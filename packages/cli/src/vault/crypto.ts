import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedValue {
  /** AES-256-GCM output with the 16-byte auth tag appended. */
  ciphertext: Buffer;
  /** Random 96-bit nonce, unique per encryption. */
  nonce: Buffer;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Kerstel data key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

export function generateDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function encrypt(plaintext: string, key: Buffer): EncryptedValue {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

export function decrypt(value: EncryptedValue, key: Buffer): string {
  assertKey(key);
  if (value.nonce.length !== NONCE_BYTES) throw new Error("Invalid nonce length");
  if (value.ciphertext.length < TAG_BYTES) throw new Error("Ciphertext too short");

  const split = value.ciphertext.length - TAG_BYTES;
  const body = value.ciphertext.subarray(0, split);
  const tag = value.ciphertext.subarray(split);

  const decipher = createDecipheriv(ALGORITHM, key, value.nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
