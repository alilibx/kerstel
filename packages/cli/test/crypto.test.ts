import { expect, test } from "bun:test";
import { decrypt, encrypt, generateDataKey } from "../src/vault/crypto";

test("generateDataKey returns 32 unique random bytes", () => {
  const a = generateDataKey();
  const b = generateDataKey();
  expect(a.length).toBe(32);
  expect(a.equals(b)).toBe(false);
});

test("encrypt then decrypt round-trips the plaintext", () => {
  const key = generateDataKey();
  const secret = "sk-proj-abc123!@#$ 🔑 multi\nline";
  const enc = encrypt(secret, key);
  expect(decrypt(enc, key)).toBe(secret);
});

test("ciphertext never contains the plaintext", () => {
  const key = generateDataKey();
  const enc = encrypt("SUPERSECRETVALUE", key);
  expect(enc.ciphertext.toString("utf8")).not.toContain("SUPERSECRETVALUE");
  expect(enc.ciphertext.toString("hex")).not.toContain(
    Buffer.from("SUPERSECRETVALUE").toString("hex"),
  );
});

test("each encryption uses a fresh 12-byte nonce", () => {
  const key = generateDataKey();
  const a = encrypt("same", key);
  const b = encrypt("same", key);
  expect(a.nonce.length).toBe(12);
  expect(a.nonce.equals(b.nonce)).toBe(false);
  expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
});

test("decrypting with the wrong key throws", () => {
  const enc = encrypt("secret", generateDataKey());
  expect(() => decrypt(enc, generateDataKey())).toThrow();
});

test("a tampered ciphertext fails the auth tag check", () => {
  const key = generateDataKey();
  const enc = encrypt("secret", key);
  enc.ciphertext[0] = enc.ciphertext[0]! ^ 0xff;
  expect(() => decrypt(enc, key)).toThrow();
});

test("a tampered nonce fails the auth tag check", () => {
  const key = generateDataKey();
  const enc = encrypt("secret", key);
  enc.nonce[0] = enc.nonce[0]! ^ 0xff;
  expect(() => decrypt(enc, key)).toThrow();
});

test("encrypt rejects a key of the wrong length", () => {
  expect(() => encrypt("x", Buffer.alloc(16))).toThrow(/32 bytes/);
});
