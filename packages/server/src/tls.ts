/**
 * The server's HTTPS certificate. With `--tls self`, a P-256 key kept beside
 * the database and a self-signed certificate for it: devices pin the key, so a
 * certificate reissued for new names keeps working, and a new key only comes
 * with a new database file. With `--domain`, a certificate from an ACME CA for
 * the same key, renewed before it expires.
 */
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { AcmeError, acmeAdvice, obtainCertificate, type AcmeDeps } from "./acme";
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

/** Codes a filesystem without hard links gives (exFAT, some NAS mounts). */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"]);

/**
 * Writes and syncs `text` to a new file at `path`, mode `0600` unless `mode`
 * says otherwise. Throws EEXIST when `path` exists. A failed write removes the
 * file, so no half key is left.
 */
function writeNewFile(path: string, text: string, mode = 0o600): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
  closeSync(fd);
}

/**
 * Creates `path` holding `text`, mode `0600`, unless it exists. Returns false,
 * having written nothing, when it exists. The text is written and synced to a
 * temporary file first, then linked into place: the link fails when the file
 * exists, so an existing file is never replaced, and no reader ever sees a
 * partly written one. On a filesystem without hard links, the file is written
 * in place instead, still never over an existing one. `link` is for tests.
 */
export function createFileOnce(path: string, text: string, link: (from: string, to: string) => void = linkSync): boolean {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const existed = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";
  try {
    writeNewFile(temp, text);
    try {
      link(temp, path);
    } catch (error) {
      // Another process put its file in place first.
      if (existed(error)) return false;
      if (!NO_HARD_LINKS.has(String((error as NodeJS.ErrnoException).code))) throw error;
      try {
        writeNewFile(path, text);
      } catch (inPlace) {
        if (existed(inPlace)) return false;
        throw inPlace;
      }
    }
    syncDirectory(dirname(path));
    return true;
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * The key in `path`, created with `createFileOnce` when there is none. When
 * another process creates one first, that key is used. `link` is for tests.
 */
export function loadOrCreateKey(path: string, link: (from: string, to: string) => void = linkSync): string {
  try {
    return readKey(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return createFileOnce(path, pem, link) ? pem : readKey(path);
}

/** Makes a new directory entry durable. Not every platform can open a directory, so this is best effort. */
function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // The file is synced; only its name could be lost in a crash, and then a new one is made.
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

/** The `--tls self` key in `pem`, read from `path`, with its pin. Throws unless it is an ECDSA P-256 private key. */
function selfSignedKey(path: string, pem: string): { key: KeyObject; pin: Buffer } {
  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error(`${path} does not hold a private key.`);
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error(`${path} must hold an ECDSA P-256 key.`);
  }
  return { key, pin: pinOfSpki(createPublicKey(key).export({ type: "spki", format: "der" })) };
}

/** The pin of the `--tls self` key beside `db`, or null when there is no key yet. It never creates one. */
export function readSelfSignedPin(db: string): Buffer | null {
  const path = tlsFiles(db).key;
  let pem: string;
  try {
    pem = readKey(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return selfSignedKey(path, pem).pin;
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
  const { key, pin } = selfSignedKey(files.key, keyPem);

  const existing = readCertificate(files.cert);
  if (existing && pinOfCertificate(existing).equals(pin) && sameNames(certificateNames(existing), names)) {
    return { keyPem, certPem: toPem(existing, "CERTIFICATE"), certDer: existing, pin };
  }
  const certDer = selfSignedCertificate({ key, names });
  const certPem = toPem(certDer, "CERTIFICATE");
  writeFileSync(files.cert, certPem);
  return { keyPem, certPem, certDer, pin };
}

// --- A certificate from an ACME CA (`--domain`) -----------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Renew when fewer than this many milliseconds remain, or a third of the certificate's lifetime if that is less. */
const RENEW_BEFORE_MS = 30 * DAY_MS;
/** After a failed order, ask again no sooner than this. */
const RETRY_MS = HOUR_MS;
/** How often to check whether the certificate needs renewing. */
const CHECK_MS = 12 * HOUR_MS;

/** A certificate chain to serve, its key, and the leaf certificate's DER. */
export interface AcmeCertificate {
  certPem: string;
  keyPem: string;
  certDer: Buffer;
}

type Held = AcmeCertificate & { notBefore: number; notAfter: number };

/** Whether `held` should be renewed at `now`: under 30 days left, or under a third of its lifetime for a short-lived one. */
function needsRenewal(held: Held, now: number): boolean {
  const renewBefore = Math.min(RENEW_BEFORE_MS, (held.notAfter - held.notBefore) / 3);
  return held.notAfter - now < renewBefore;
}

export type AcmeManagerDeps = AcmeDeps & { now: () => number; log: (line: string) => void };

/**
 * `certPem` as this manager can use it: a chain whose leaf is for `keyPem`'s
 * key, names `domain`, and was issued by a CA rather than signed by itself
 * (`--tls self` keeps its certificate in the same file). Throws otherwise.
 */
function acmeCertificate(certPem: string, keyPem: string, domain: string): Held {
  const leaf = new X509Certificate(certPem);
  const leafSpki = leaf.publicKey.export({ type: "spki", format: "der" });
  if (!leafSpki.equals(createPublicKey(keyPem).export({ type: "spki", format: "der" }))) {
    throw new Error("The certificate is for another key.");
  }
  if (!certificateNames(leaf.raw).includes(domain)) throw new Error(`The certificate does not name ${domain}.`);
  if (leaf.verify(leaf.publicKey)) throw new Error("The certificate is self-signed.");
  const notBefore = Date.parse(leaf.validFrom);
  const notAfter = Date.parse(leaf.validTo);
  if (!Number.isFinite(notAfter)) throw new Error(`The certificate's expiry, ${leaf.validTo}, does not parse.`);
  if (!Number.isFinite(notBefore)) throw new Error(`The certificate's start, ${leaf.validFrom}, does not parse.`);
  return { certPem, keyPem, certDer: leaf.raw, notBefore, notAfter };
}

/** Writes `text` to `path` through a synced temporary file, so a reader sees the old file or the new one. */
function replaceFile(path: string, text: string): void {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeNewFile(temp, text, 0o644);
    renameSync(temp, path);
    syncDirectory(dirname(path));
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * The certificate for `--domain`. It keeps the ACME account key and the
 * certificate key beside the database (`0600`) and reuses both, and gets a new
 * certificate when there is none or fewer than 30 days remain (a third of its
 * lifetime, for a certificate that lasts less than 90 days). After a failed
 * order it asks the CA again no sooner than an hour later.
 */
export class AcmeManager {
  /** Token to key authorization, for the HTTP-01 listener while the CA validates. */
  readonly challenges = new Map<string, string>();
  private held: Held | null = null;
  private failedAt: number | null = null;
  private running: Promise<"issued" | "renewed" | "current" | "failed"> | null = null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** Only what the caller gave, so `obtainCertificate` keeps its own defaults for the rest. */
  private readonly acmeDeps: Partial<AcmeDeps>;

  constructor(
    private readonly o: {
      db: string;
      domain: string;
      directory: string;
      email: string | null;
      /** The port the challenge listener answers on, for the advice after a failure (default 80). */
      httpPort?: number;
      deps?: Partial<AcmeManagerDeps>;
    },
  ) {
    const { now, log, fetch, sleep } = o.deps ?? {};
    this.now = now ?? (() => Date.now());
    this.log = log ?? ((line) => console.log(line));
    this.acmeDeps = { ...(fetch ? { fetch } : {}), ...(sleep ? { sleep } : {}) };
    const files = tlsFiles(o.db);
    try {
      this.held = acmeCertificate(readFileSync(files.cert, "utf8"), readFileSync(files.key, "utf8"), o.domain);
    } catch {
      this.held = null; // none yet, or not one for this domain and key: get one
    }
  }

  current(): AcmeCertificate | null {
    if (!this.held) return null;
    const { certPem, keyPem, certDer } = this.held;
    return { certPem, keyPem, certDer };
  }

  /** Gets or renews the certificate when it needs to. Never throws: a failure is logged and reported as "failed". */
  ensure(): Promise<"issued" | "renewed" | "current" | "failed"> {
    this.running ??= this.attempt().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async attempt(): Promise<"issued" | "renewed" | "current" | "failed"> {
    const now = this.now();
    const previous = this.held;
    if (previous && !needsRenewal(previous, now)) return "current";
    if (this.failedAt !== null && now - this.failedAt < RETRY_MS) return "failed";
    try {
      const files = tlsFiles(this.o.db);
      const accountKey = createPrivateKey(loadOrCreateKey(files.account));
      const keyPem = loadOrCreateKey(files.key);
      const chain = await obtainCertificate({
        directory: this.o.directory,
        domain: this.o.domain,
        email: this.o.email,
        accountKey,
        certKey: createPrivateKey(keyPem),
        challenges: this.challenges,
        deps: this.acmeDeps,
      });
      const held = acmeCertificate(chain, keyPem, this.o.domain);
      replaceFile(files.cert, chain);
      this.held = held;
      this.failedAt = null;
      this.log(`Got a certificate for ${this.o.domain}, valid until ${new Date(held.notAfter).toISOString().slice(0, 10)}.`);
      return previous ? "renewed" : "issued";
    } catch (error) {
      this.failedAt = this.now();
      this.log(
        error instanceof AcmeError
          ? acmeAdvice(error, this.o.domain, this.o.httpPort ?? 80)
          : error instanceof Error
            ? error.message
            : String(error),
      );
      return "failed";
    }
  }
}

/**
 * The HTTP-01 listener: `/.well-known/acme-challenge/<token>` answers the
 * token's key authorization, and anything else is a 404. It goes by the path
 * alone, since the CA's request carries `Host: <domain>`.
 */
export function serveChallenges(o: {
  challenges: Pick<Map<string, string>, "get">;
  hostname: string;
  port: number;
}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: o.hostname,
    port: o.port,
    fetch(request) {
      const token = /^\/\.well-known\/acme-challenge\/([^/]+)$/.exec(new URL(request.url).pathname)?.[1];
      const answer = token === undefined ? undefined : o.challenges.get(token);
      return answer === undefined ? new Response("not found\n", { status: 404 }) : new Response(answer);
    },
  });
}

/** How many times, and how far apart, `bindAgain` tries to listen. */
const BIND_ATTEMPTS = 10;
const BIND_DELAY_MS = 1_000;

/**
 * Listens again after a renewal stopped the old listener, which may hold its
 * address for a moment: `bind` is tried up to 10 times, a second apart, and
 * the first failure is logged once. Throws the last error if every try fails.
 */
export async function bindAgain<T>(
  bind: () => T,
  o: { log: (line: string) => void; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let attempt = 1; ; attempt++) {
    try {
      return bind();
    } catch (error) {
      if (attempt >= BIND_ATTEMPTS) throw error;
      if (attempt === 1) {
        o.log(
          `Could not listen again with the new certificate (${(error as Error).message}). Trying again every second, up to ${BIND_ATTEMPTS} times.`,
        );
      }
      await sleep(BIND_DELAY_MS);
    }
  }
}

/**
 * Keeps `--domain` served: `serve` gets the certificate the manager already
 * has at once, then a new one whenever the manager issues or renews one, and
 * restarts the HTTPS listener with it. The manager checks again every 12 hours,
 * or an hour after a failure.
 */
export function keepCertificate(o: {
  manager: Pick<AcmeManager, "current" | "ensure">;
  serve: (certificate: AcmeCertificate) => void;
  log: (line: string) => void;
  /** Runs `run` after `ms`, and returns what cancels it. */
  schedule?: (run: () => void, ms: number) => () => void;
}): { stop(): void } {
  const schedule =
    o.schedule ??
    ((run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  let serving = false;
  let stopped = false;
  let cancel: (() => void) | null = null;

  const held = o.manager.current();
  if (held) {
    o.serve(held);
    serving = true;
  }
  const check = async () => {
    const result = await o.manager.ensure();
    if (stopped) return;
    const certificate = o.manager.current();
    if (certificate && (!serving || result === "renewed")) {
      o.serve(certificate);
      serving = true;
    }
    if (!certificate) o.log("No certificate yet. Trying again in an hour.");
    cancel = schedule(() => void check(), result === "failed" ? RETRY_MS : CHECK_MS);
  };
  void check();
  return {
    stop() {
      stopped = true;
      cancel?.();
    },
  };
}
