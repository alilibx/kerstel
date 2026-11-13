/**
 * Hand-built DER for the server's own certificate and for the certificate
 * request it sends an ACME CA. Keys are ECDSA P-256, signed with SHA-256.
 * The server takes no dependency for this, so the encoder lives here.
 */
import { createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

const DEFAULT_NAME = "kerstel-server";
const DAY_MS = 86_400_000;
/** RFC 5280 §4.1.2.5: a certificate with no well-defined expiry. */
const NO_EXPIRY = Date.UTC(9999, 11, 31, 23, 59, 59);

const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  subjectAltName: "2.5.29.17",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  extensionRequest: "1.2.840.113549.1.9.14",
};

// --- DER writer -------------------------------------------------------------

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  let length: number[];
  if (body.length < 0x80) {
    length = [body.length];
  } else {
    const bytes: number[] = [];
    for (let n = body.length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
    length = [0x80 | bytes.length, ...bytes];
  }
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const octetString = (bytes: Buffer) => tlv(0x04, bytes);
const bitString = (bytes: Buffer, unusedBits = 0) => tlv(0x03, Buffer.from([unusedBits]), bytes);
const utf8String = (text: string) => tlv(0x0c, Buffer.from(text, "utf8"));
const explicit = (n: number, inner: Buffer) => tlv(0xa0 | n, inner);
const TRUE = Buffer.from([0x01, 0x01, 0xff]);

/** An unsigned big-endian integer, in DER's minimal two's-complement form. */
function integer(bytes: Buffer): Buffer {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const trimmed = bytes.subarray(i);
  return tlv(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function oid(text: string): Buffer {
  const [a, b, ...rest] = text.split(".").map(Number);
  const out = [a! * 40 + b!];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let n = arc >>> 7; n > 0; n >>>= 7) groups.unshift(0x80 | (n & 0x7f));
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime through 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5). */
function time(ms: number): Buffer {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  const year = d.getUTCFullYear();
  const pad = (n: number) => String(n).padStart(2, "0");
  const rest = [d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    .map(pad)
    .join("");
  if (year >= 1950 && year < 2050) return tlv(0x17, Buffer.from(`${pad(year % 100)}${rest}Z`));
  return tlv(0x18, Buffer.from(`${String(year).padStart(4, "0")}${rest}Z`));
}

// --- X.509 pieces -----------------------------------------------------------

const ecdsaWithSha256 = () => sequence(oid(OID.ecdsaWithSha256));
const name = (cn: string) => sequence(set(sequence(oid(OID.commonName), utf8String(cn))));

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical ? sequence(oid(id), TRUE, octetString(value)) : sequence(oid(id), octetString(value));
}

function subjectAltName(names: string[]): Buffer {
  const entries = names.map((n) => (isIP(n) ? tlv(0x87, ipBytes(n)) : tlv(0x82, Buffer.from(n, "ascii"))));
  return extension(OID.subjectAltName, false, sequence(...entries));
}

function signed(toBeSigned: Buffer, key: KeyObject): Buffer {
  if (key.asymmetricKeyType !== "ec") throw new Error("certificates are signed with an ECDSA P-256 key");
  return sequence(toBeSigned, ecdsaWithSha256(), bitString(sign("sha256", toBeSigned, key)));
}

const spkiOf = (key: KeyObject): Buffer => createPublicKey(key).export({ type: "spki", format: "der" });

/** A DER certificate for `subjectSpki`, signed by `issuerKey`, valid from a day before `now` with no expiry. */
export function issueCertificate(o: {
  subjectSpki: Buffer;
  issuerKey: KeyObject;
  issuerName?: string;
  subjectName?: string;
  names: string[];
  ca?: boolean;
  now?: number;
}): Buffer {
  const now = o.now ?? Date.now();
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40; // positive, and a full 16 bytes
  const extensions = [extension(OID.basicConstraints, true, o.ca ? sequence(TRUE) : sequence())];
  // keyUsage: keyCertSign (bit 5) for a CA, digitalSignature (bit 0) for an
  // issued leaf; DER drops the trailing zero bits. A self-signed leaf carries
  // none: OpenSSL and BoringSSL count a certificate as its own issuer only when
  // keyUsage is absent or allows keyCertSign, which RFC 5280 reserves for CAs,
  // so a client trusting it as its only `ca` would fail with
  // UNABLE_TO_VERIFY_LEAF_SIGNATURE.
  if (o.ca) {
    extensions.push(extension(OID.keyUsage, true, bitString(Buffer.from([0x04]), 2)));
  } else if (!spkiOf(o.issuerKey).equals(o.subjectSpki)) {
    extensions.push(extension(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)));
  }
  if (!o.ca) extensions.push(extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))));
  if (o.names.length > 0) extensions.push(subjectAltName(o.names));
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    ecdsaWithSha256(),
    name(o.issuerName ?? DEFAULT_NAME),
    sequence(time(now - DAY_MS), time(NO_EXPIRY)),
    name(o.subjectName ?? DEFAULT_NAME),
    o.subjectSpki,
    explicit(3, sequence(...extensions)),
  );
  return signed(tbs, o.issuerKey);
}

/** The server's own certificate: `key` signs for itself. */
export function selfSignedCertificate(o: { key: KeyObject; names: string[]; now?: number }): Buffer {
  return issueCertificate({ subjectSpki: spkiOf(o.key), issuerKey: o.key, names: o.names, now: o.now });
}

/** A PKCS#10 request for `domain`, as its CN and its one dNSName. */
export function certificateRequest(o: { key: KeyObject; domain: string }): Buffer {
  const extensions = sequence(subjectAltName([o.domain]));
  const info = sequence(
    integer(Buffer.from([0])),
    name(o.domain),
    spkiOf(o.key),
    tlv(0xa0, sequence(oid(OID.extensionRequest), set(extensions))), // [0] IMPLICIT SET OF Attribute
  );
  return signed(info, o.key);
}

export function toPem(der: Buffer, label: "CERTIFICATE" | "CERTIFICATE REQUEST"): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// --- Reading names back -----------------------------------------------------

interface Node {
  tag: number;
  start: number;
  end: number;
}

function read(der: Buffer, at: number, limit: number): Node {
  if (at + 2 > limit) throw new Error("malformed certificate");
  const tag = der[at]!;
  let length = der[at + 1]!;
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || start + count > limit) throw new Error("malformed certificate");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + der[start + i]!;
    start += count;
  }
  if (start + length > limit) throw new Error("malformed certificate");
  return { tag, start, end: start + length };
}

function children(der: Buffer, parent: Node): Node[] {
  const out: Node[] = [];
  for (let at = parent.start; at < parent.end; at = out[out.length - 1]!.end) out.push(read(der, at, parent.end));
  return out;
}

/** The certificate's subjectAltName entries, in order: DNS names as written, IP addresses in their RFC 5952 form. */
export function certificateNames(certDer: Buffer): string[] {
  const certificate = read(certDer, 0, certDer.length);
  const tbs = children(certDer, certificate)[0];
  const extensions = tbs && children(certDer, tbs).find((n) => n.tag === 0xa3);
  if (!extensions) return [];
  const sanOid = oid(OID.subjectAltName).subarray(2);
  for (const ext of children(certDer, children(certDer, extensions)[0]!)) {
    const parts = children(certDer, ext);
    const id = parts[0]!;
    if (!certDer.subarray(id.start, id.end).equals(sanOid)) continue;
    const value = parts[parts.length - 1]!;
    return children(certDer, read(certDer, value.start, value.end)).flatMap((n) => {
      const bytes = certDer.subarray(n.start, n.end);
      if (n.tag === 0x82) return [bytes.toString("ascii")];
      if (n.tag === 0x87) return [ipText(bytes)];
      return [];
    });
  }
  return [];
}

// --- IP addresses -----------------------------------------------------------

function ipBytes(text: string): Buffer {
  if (isIP(text) === 4) return Buffer.from(text.split(".").map(Number));
  if (text.includes("%")) throw new Error(`a certificate cannot name a scoped address: ${text}`);
  let groups = text;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split(".").map(Number);
    groups = `${text.slice(0, v4.index)}${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
  }
  const [head, tail] = groups.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  const out = Buffer.alloc(16);
  words.forEach((w, i) => out.writeUInt16BE(parseInt(w, 16), i * 2));
  return out;
}

function ipText(bytes: Buffer): string {
  if (bytes.length === 4) return [...bytes].join(".");
  if (bytes.length !== 16) throw new Error("malformed certificate");
  const words = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2));
  // RFC 5952: the longest run of two or more zero words (the first, on a tie) becomes "::".
  let best = { at: -1, length: 1 };
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > best.length) best = { at: i, length: j - i };
    i = j === i ? i + 1 : j;
  }
  const hex = words.map((w) => w.toString(16));
  if (best.at < 0) return hex.join(":");
  return `${hex.slice(0, best.at).join(":")}::${hex.slice(best.at + best.length).join(":")}`;
}
