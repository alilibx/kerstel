/**
 * A pin names a server's key: the SHA-256 of its certificate's DER
 * SubjectPublicKeyInfo. A certificate reissued with the same key keeps the pin.
 *
 * The CLI imports this file too, so it imports only `node:crypto`.
 */
import { X509Certificate, createHash } from "node:crypto";

const PREFIX = "sha256/";
const PIN_BYTES = 32;

export function pinOfSpki(spkiDer: Buffer): Buffer {
  return createHash("sha256").update(spkiDer).digest();
}

export function pinOfCertificate(certDer: Buffer): Buffer {
  return pinOfSpki(new X509Certificate(certDer).publicKey.export({ type: "spki", format: "der" }));
}

/** `sha256/` and 43 characters of unpadded base64url. */
export function formatPin(pin: Buffer): string {
  if (pin.length !== PIN_BYTES) throw new Error(`a pin is ${PIN_BYTES} bytes, not ${pin.length}`);
  return PREFIX + pin.toString("base64url");
}

/** The pin's bytes, or null for anything but the exact form `formatPin` writes (after trimming). */
export function parsePin(text: string): Buffer | null {
  const match = /^sha256\/([A-Za-z0-9_-]{43})$/.exec(text.trim());
  if (!match) return null;
  const pin = Buffer.from(match[1]!, "base64url");
  // 43 characters hold 258 bits. Refuse stray low bits, so each pin has one spelling.
  if (pin.length !== PIN_BYTES || pin.toString("base64url") !== match[1]) return null;
  return pin;
}
