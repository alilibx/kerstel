/**
 * The server's own HTTPS certificate (`--tls self`): a P-256 key kept beside
 * the database, and a self-signed certificate for it. Devices pin the key, so a
 * certificate reissued for new names keeps working, and a new key only comes
 * with a new database file.
 */
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { pinOfCertificate, pinOfSpki } from "./pin";
import { certificateNames, selfSignedCertificate, toPem } from "./x509";

/** The files kept beside the database. The two keys are written `0600`. */
export function tlsFiles(db: string): { key: string; cert: string; account: string } {
  return { key: `${db}.tls-key.pem`, cert: `${db}.tls-cert.pem`, account: `${db}.acme-account.pem` };
}

/** Labels of letters, digits and inner hyphens, optionally under a leading `*.`. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DNS_NAME = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*$`);

/**
 * `text` as a certificate names it, or null when a certificate cannot name it:
 * an IP address without a zone ID (IPv6 in its RFC 5952 form, as
 * `certificateNames` reads it back), or an ASCII DNS name in lower case,
 * optionally starting with `*.`.
 */
export function certificateName(text: string): string | null {
  const family = isIP(text);
  if (family === 4) return text;
  if (family === 6) return text.includes("%") ? null : new URL(`http://[${text}]`).hostname.slice(1, -1);
  const name = text.toLowerCase();
  if (name.length > 253 || !DNS_NAME.test(name)) return null;
  // An all-digit last label is a malformed IPv4 address (192.168.1.256, 127.1), not a name.
  return /^\d+$/.test(name.slice(name.lastIndexOf(".") + 1)) ? null : name;
}

function sameNames(a: string[], b: string[]): boolean {
  const canonical = (names: string[]) => new Set(names.map((n) => certificateName(n) ?? n));
  const left = canonical(a);
  const right = canonical(b);
  return left.size === right.size && [...left].every((n) => right.has(n));
}

function readKey(path: string): string {
  const pem = readFileSync(path, "utf8");
  if (!pem.trim()) {
    throw new Error(`${path} is empty. If no device has pinned this server yet, delete it and start again.`);
  }
  return pem;
}

/**
 * The key in `path`, created when there is none. The new key is written and
 * synced to a temporary file first, then linked into place: the link fails
 * when a key exists, so an existing key is never replaced, and no reader ever
 * sees a partly written one.
 */
function loadOrCreateKey(path: string): string {
  try {
    return readKey(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, pem);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, path);
    } catch (error) {
      // Another process put its key in place first: use that one.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return readKey(path);
      throw error;
    }
    syncDirectory(dirname(path));
    return pem;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Makes a new directory entry durable. Not every platform can open a directory, so this is best effort. */
function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // The key is synced; only its name could be lost in a crash, and then a new one is made.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readCertificate(path: string): Buffer | null {
  try {
    return new X509Certificate(readFileSync(path)).raw;
  } catch {
    return null; // missing, or not a certificate: issue a new one
  }
}

/**
 * The key and certificate for `--tls self`, with the key's pin. It creates the
 * key when missing, and issues a certificate when there is none, when it names
 * anything but `names`, or when it is for another key.
 */
export function loadSelfSigned(
  db: string,
  names: string[],
): { keyPem: string; certPem: string; certDer: Buffer; pin: Buffer } {
  const files = tlsFiles(db);
  const keyPem = loadOrCreateKey(files.key);
  let key;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw new Error(`${files.key} does not hold a private key.`);
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error(`${files.key} must hold an ECDSA P-256 key.`);
  }
  const pin = pinOfSpki(createPublicKey(key).export({ type: "spki", format: "der" }));

  const existing = readCertificate(files.cert);
  if (existing && pinOfCertificate(existing).equals(pin) && sameNames(certificateNames(existing), names)) {
    return { keyPem, certPem: toPem(existing, "CERTIFICATE"), certDer: existing, pin };
  }
  const certDer = selfSignedCertificate({ key, names });
  const certPem = toPem(certDer, "CERTIFICATE");
  writeFileSync(files.cert, certPem);
  return { keyPem, certPem, certDer, pin };
}
