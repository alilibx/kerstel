import { createHash } from "node:crypto";
import { PAIRING_SECRET_BYTES, parsePairingCode } from "./crypto";

/**
 * The one-value pairing string `ks1-…`: server URLs, an optional certificate pin and the
 * pairing secret, base64url with a 4-byte checksum. It is a secret while the pairing is open.
 */
export interface JoinValue {
  urls: string[];
  /** SHA-256 of the server certificate's public key (SPKI), 32 bytes. */
  pin: Buffer | null;
  secret: Buffer;
}

export const JOIN_PREFIX = "ks1-";

const PIN_BYTES = 32;
const CHECKSUM_BYTES = 4;
const MAX_URLS = 4;
const FLAG_PIN = 0x01;
const CONTROL = /[\u0000-\u001f\u007f]/;

function checksum(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest().subarray(0, CHECKSUM_BYTES);
}

export function encodeJoinValue(v: JoinValue): string {
  if (v.urls.length < 1 || v.urls.length > MAX_URLS) {
    throw new Error(`a join value carries 1 to ${MAX_URLS} server URLs`);
  }
  if (v.urls.some((u) => u.length === 0 || CONTROL.test(u))) {
    throw new Error("a server URL must be non-empty and have no control character");
  }
  if (v.secret.length !== PAIRING_SECRET_BYTES) {
    throw new Error(`the pairing secret must be ${PAIRING_SECRET_BYTES} bytes`);
  }
  if (v.pin !== null && v.pin.length !== PIN_BYTES) {
    throw new Error(`the pin must be ${PIN_BYTES} bytes`);
  }
  const head = Buffer.concat([
    Buffer.from([v.pin ? FLAG_PIN : 0]),
    v.secret,
    v.pin ?? Buffer.alloc(0),
    Buffer.from(v.urls.join("\n"), "utf8"),
  ]);
  return JOIN_PREFIX + Buffer.concat([head, checksum(head)]).toString("base64url");
}

export function parseJoinValue(text: string): JoinValue | "malformed" | "newer" {
  const trimmed = text.trim();
  const m = /^ks(\d+)-/i.exec(trimmed);
  if (!m) return "malformed";
  const version = Number(m[1]);
  if (version > 1) return "newer";
  if (version !== 1) return "malformed";
  const body = trimmed.slice(m[0].length);
  const bytes = Buffer.from(body, "base64url");
  // Node's decoder skips characters it doesn't know; re-encoding catches them.
  if (bytes.toString("base64url") !== body) return "malformed";
  if (bytes.length < 1 + PAIRING_SECRET_BYTES + 1 + CHECKSUM_BYTES) return "malformed";
  const head = bytes.subarray(0, bytes.length - CHECKSUM_BYTES);
  if (!checksum(head).equals(bytes.subarray(head.length))) return "malformed";
  const flags = head[0] as number;
  if ((flags & ~FLAG_PIN) !== 0) return "malformed";
  let at = 1;
  const secret = Buffer.from(head.subarray(at, at + PAIRING_SECRET_BYTES));
  at += PAIRING_SECRET_BYTES;
  let pin: Buffer | null = null;
  if (flags & FLAG_PIN) {
    pin = Buffer.from(head.subarray(at, at + PIN_BYTES));
    at += PIN_BYTES;
  }
  if (head.length <= at) return "malformed";
  const urls = head.subarray(at).toString("utf8").split("\n");
  if (urls.length > MAX_URLS || urls.some((u) => u.length === 0 || CONTROL.test(u))) return "malformed";
  return { urls, pin, secret };
}

export type JoinInput =
  | JoinValue
  | { error: "malformed" | "newer" | "empty" | "bad-code" }
  | { error: "bad-url"; url: string };

const COMMAND_WORDS = new Set(["ks", "kerstel", "sync", "join"]);

/**
 * `words` are the arguments after `join`, or a pasted line split on whitespace. A value the
 * terminal wrapped is glued back together; `<url> <code>` is the older two-word form.
 */
export function parseJoinInput(words: string[]): JoinInput {
  const rest = words.filter((w) => w.length > 0);
  while (rest.length > 0 && COMMAND_WORDS.has((rest[0] as string).toLowerCase())) rest.shift();
  if (rest.length === 0) return { error: "empty" };
  const joined = rest.join("");
  if (rest.length === 1 || /^ks\d/i.test(joined)) {
    const parsed = parseJoinValue(joined);
    return typeof parsed === "string" ? { error: parsed } : parsed;
  }
  if (rest.length === 2) {
    const [url, code] = rest as [string, string];
    // Anything that looks like the older `<url> <code>` form gets that form's own messages.
    if (/^ks/i.test(code) || /^http/i.test(url)) {
      if (!URL.canParse(url)) return { error: "bad-url", url };
      const secret = parsePairingCode(code);
      if (!secret) return { error: "bad-code" };
      return { urls: [url], pin: null, secret };
    }
  }
  return { error: "malformed" };
}
