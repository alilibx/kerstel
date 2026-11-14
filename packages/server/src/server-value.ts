/**
 * The server value `ks-server1-…`: what sets up a device for a server. It
 * holds the server's URLs, its certificate pin when it has one, and the enroll
 * token, as unpadded base64url with a 4-byte checksum. It is a secret, since
 * it carries the token.
 *
 * The CLI imports this file too, so it imports only `node:crypto` and `./pin`.
 */
import { createHash } from "node:crypto";
import { PIN_BYTES } from "./pin";

export interface ServerValue {
  urls: string[];
  /** SHA-256 of the server certificate's public key (SPKI), 32 bytes. */
  pin: Buffer | null;
  token: string;
}

export const SERVER_VALUE_PREFIX = "ks-server1-";

const CHECKSUM_BYTES = 4;
const MAX_URLS = 4;
const MAX_TOKEN_BYTES = 255;
const FLAG_PIN = 0x01;
const CONTROL = /[\u0000-\u001f\u007f]/;

function checksum(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest().subarray(0, CHECKSUM_BYTES);
}

/** `bytes` as UTF-8, or null when they are not valid UTF-8. */
function utf8(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

/**
 * The record: a flag byte (bit 0: a pin follows), the pin, the token's length
 * in one byte and the token, the URLs joined with `\n`, then the checksum.
 * Throws on input it cannot carry. No message names the token.
 */
export function encodeServerValue(v: ServerValue): string {
  if (v.urls.length < 1 || v.urls.length > MAX_URLS) {
    throw new Error(`a server value carries 1 to ${MAX_URLS} server URLs`);
  }
  if (v.urls.some((u) => u.length === 0 || CONTROL.test(u))) {
    throw new Error("a server URL must be non-empty and have no control character");
  }
  if (v.pin !== null && v.pin.length !== PIN_BYTES) {
    throw new Error(`the pin must be ${PIN_BYTES} bytes`);
  }
  const token = Buffer.from(v.token, "utf8");
  if (token.length < 1 || token.length > MAX_TOKEN_BYTES) {
    throw new Error(`the enroll token must be 1 to ${MAX_TOKEN_BYTES} bytes`);
  }
  const head = Buffer.concat([
    Buffer.from([v.pin ? FLAG_PIN : 0]),
    v.pin ?? Buffer.alloc(0),
    Buffer.from([token.length]),
    token,
    Buffer.from(v.urls.join("\n"), "utf8"),
  ]);
  return SERVER_VALUE_PREFIX + Buffer.concat([head, checksum(head)]).toString("base64url");
}

/** The value in `text` (after trimming), "newer" for a later format, or "malformed". */
export function parseServerValue(text: string): ServerValue | "malformed" | "newer" {
  const trimmed = text.trim();
  const m = /^ks-server(\d+)-/i.exec(trimmed);
  if (!m) return "malformed";
  const version = Number(m[1]);
  if (version > 1) return "newer";
  if (version !== 1) return "malformed";
  const body = trimmed.slice(m[0].length);
  const bytes = Buffer.from(body, "base64url");
  // Node's decoder skips characters it doesn't know; re-encoding catches them.
  if (bytes.toString("base64url") !== body) return "malformed";
  if (bytes.length < 1 + 1 + 1 + 1 + CHECKSUM_BYTES) return "malformed";
  const head = bytes.subarray(0, bytes.length - CHECKSUM_BYTES);
  if (!checksum(head).equals(bytes.subarray(head.length))) return "malformed";
  const flags = head[0] as number;
  if ((flags & ~FLAG_PIN) !== 0) return "malformed";
  let at = 1;
  let pin: Buffer | null = null;
  if (flags & FLAG_PIN) {
    if (head.length < at + PIN_BYTES) return "malformed";
    pin = Buffer.from(head.subarray(at, at + PIN_BYTES));
    at += PIN_BYTES;
  }
  const tokenLength = head[at];
  if (tokenLength === undefined || tokenLength === 0) return "malformed";
  at += 1;
  if (head.length < at + tokenLength) return "malformed";
  const token = utf8(head.subarray(at, at + tokenLength));
  at += tokenLength;
  if (token === null || head.length <= at) return "malformed";
  const joined = utf8(head.subarray(at));
  if (joined === null) return "malformed";
  const urls = joined.split("\n");
  if (urls.length > MAX_URLS || urls.some((u) => u.length === 0 || CONTROL.test(u))) return "malformed";
  return { urls, pin, token };
}
