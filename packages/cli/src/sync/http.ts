import { X509Certificate, type KeyObject } from "node:crypto";
import { isHttps, pinOfCertificate } from "../../../server/src/pin";
import {
  HEADERS,
  PROTOCOL_PREFIX,
  signRequest,
  type AddDeviceBody,
  type CreateVaultBody,
  type DeviceOut,
  type PairingSlotOut,
  type PairingStateOut,
  type ErrorBody,
  type PullResponse,
  type PushBody,
  type PushResponse,
  type RotateBody,
} from "../../../server/src/protocol";
import { cliName } from "../ui/cli-name";

/**
 * A signed client for `kerstel-server`. Sync spec §9.2. Every request to a
 * vault is signed with this device's Ed25519 key over the method, the path
 * with its query, the time and the body's hash. `fetch` is injectable, so the
 * tests run against the server in-process.
 */

/** What a pinned client passes besides the request: Bun's `tls` options. */
export interface FetchInit {
  tls?: Record<string, unknown>;
}

/**
 * The fetch a client sends with. A pinned client calls it with `init.tls`,
 * which a wrapper must pass on to Bun's `fetch`, or the pin is not checked.
 */
export type Fetch = (request: Request, init?: FetchInit) => Promise<Response>;

/** How long one request may take. A server that never answers must not hold the sync lock, or a background sync, forever. */
export const REQUEST_TIMEOUT_MS = 60_000;

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    /** The server's error code, `unreachable` when no answer came, or `pin_mismatch` when a pinned server's key is not the pinned one. */
    readonly code: string,
    message: string,
    /** The code `fetch` failed with when no answer came, such as a TLS one (`DEPTH_ZERO_SELF_SIGNED_CERT`). */
    readonly tlsCode?: string,
  ) {
    super(message);
    this.name = "SyncHttpError";
  }
}

export interface ClientOptions {
  server: string;
  vaultId: string;
  deviceId: string;
  sign: KeyObject;
  fetch?: Fetch;
  now?: () => number;
  /** The server's key pin (#112). With one, every request trusts that key and nothing else. */
  pin?: Buffer | null;
}

export const PIN_NEEDS_HTTPS = "A pinned server must use an https:// URL.";

export const PIN_MISMATCH = (server: string): string =>
  `${server} presented a key this device does not trust, so nothing was sent. If the server lost its data and started again, run ${cliName()} sync off, then set sync up again. Otherwise, something between you and the server is answering in its place.`;

/** Thrown from `checkServerIdentity`: the server's certificate chains to the held one but carries another key. */
class PinMismatch extends Error {
  constructor() {
    super("pin mismatch");
    this.name = "PinMismatch";
  }
}

const isPinMismatch = (error: unknown): boolean =>
  error instanceof PinMismatch || (error instanceof Error && error.cause instanceof PinMismatch);

/** What `fetch` takes besides the request: Bun's `tls` options, for a pinned server. */
export type PinnedFetchBase = (request: Request, init: { tls: Record<string, unknown> }) => Promise<Response>;

const bunFetch: PinnedFetchBase = (request, init) => fetch(request, init as RequestInit);

/** The certificate's JSON is a few hundred bytes; anything this large is not it. */
const CERTIFICATE_BODY_LIMIT = 16 * 1024;

/**
 * Codes Bun gives when the server's certificate does not verify against the
 * held one: the server reissued it since this process fetched it, or another
 * key answered.
 */
const TLS_VERIFY_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const isTlsVerifyError = (error: unknown): boolean =>
  !isPinMismatch(error) && TLS_VERIFY_CODES.has(String((error as { code?: unknown } | null)?.code));

/** The certificate a pinned client holds for its server. */
interface HeldCertificate {
  der: Buffer;
  /** The certificate as PEM when it signed itself, for `ca`; null when a CA issued it. */
  ca: string | null;
}

/**
 * Signed by its own key, as `kerstel-server --tls self` makes it. BoringSSL
 * anchors only on such a certificate, so a CA-issued one is never used as `ca`.
 */
function isSelfSigned(cert: X509Certificate): boolean {
  try {
    return cert.subject === cert.issuer && cert.verify(cert.publicKey);
  } catch {
    return false;
  }
}

/** Reads at most `limit` bytes of a body, or null when it is longer. */
async function readCapped(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A fetch that trusts `server`'s pinned key and nothing else (easy-sync spec
 * §6). It fetches the server's certificate once and checks its key against the
 * pin. A self-signed certificate (`--tls self`) is then every request's only
 * `ca`. A CA-issued one for the pinned key (a server that moved to `--domain`
 * with the same key) is checked against the normal roots instead. Either way,
 * `checkServerIdentity` checks the key again on every connection, and throws
 * when it is not the pinned one, which fails the request. The hostname is not
 * checked: the key is what is pinned. The certificate request is an ordinary
 * fetch, so HTTPS_PROXY and NO_PROXY apply to it as to every other request; it
 * carries no secret, and no redirect is followed.
 */
export function pinnedFetch(server: string, pin: Buffer, base: PinnedFetchBase = bunFetch): Fetch {
  // The pin is checked by TLS; over plain http there is nothing to check it against.
  if (!isHttps(server)) throw new SyncHttpError(0, "bad_request", PIN_NEEDS_HTTPS);
  let held: Promise<HeldCertificate> | null = null;
  const mismatch = () => new SyncHttpError(0, "pin_mismatch", PIN_MISMATCH(server));

  async function fetchCertificate(): Promise<HeldCertificate> {
    const unreachable = (why: string) => new SyncHttpError(0, "unreachable", `Could not reach ${server}: ${why}`);
    let response: Response;
    try {
      response = await base(
        new Request(`${server}${PROTOCOL_PREFIX}/certificate`, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
        // Unverified on purpose: the pin, not a certificate authority, decides.
        { tls: { rejectUnauthorized: false } },
      );
    } catch (error) {
      throw unreachable((error as Error).message);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw unreachable("it answered the certificate request with a redirect, which Kerstel does not follow for sync. Use the server's final URL.");
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw unreachable(`it answered ${response.status} instead of sending its certificate.`);
    }
    try {
      const text = await readCapped(response, CERTIFICATE_BODY_LIMIT);
      const parsed = text === null ? null : (JSON.parse(text) as { certificate?: unknown } | null);
      if (typeof parsed?.certificate !== "string") throw new Error("no certificate");
      const der = Buffer.from(parsed.certificate, "base64");
      if (!pinOfCertificate(der).equals(pin)) throw mismatch();
      const cert = new X509Certificate(der);
      return { der, ca: isSelfSigned(cert) ? cert.toString() : null };
    } catch (error) {
      if (error instanceof SyncHttpError) throw error;
      throw unreachable("it sent a certificate Kerstel could not read.");
    }
  }

  /** The held certificate, fetched on first use. A failed fetch is tried again next time. */
  function certificate(): Promise<HeldCertificate> {
    if (!held) {
      held = fetchCertificate();
      held.catch(() => {
        held = null;
      });
    }
    return held;
  }

  // Runs after the certificate verified, against `ca` or the normal roots.
  // Thrown, it fails the request, and `send` reports it as pin_mismatch.
  const checkServerIdentity = (_host: string, cert: { raw: Buffer }) => {
    if (!pinOfCertificate(cert.raw).equals(pin)) throw new PinMismatch();
  };
  const send = (request: Request, cert: HeldCertificate): Promise<Response> =>
    base(request, { tls: cert.ca === null ? { checkServerIdentity } : { ca: cert.ca, checkServerIdentity } });

  return async (request) => {
    const cert = await certificate();
    try {
      // A body can be read once; the retry below sends the original.
      return await send(request.clone() as Request, cert);
    } catch (error) {
      if (!isTlsVerifyError(error)) throw error;
      // The server may have reissued its certificate with the same key since
      // this process fetched it, or moved between its own and a CA's. Fetch
      // it once more and retry once.
      let fresh: HeldCertificate;
      try {
        fresh = await fetchCertificate();
      } catch (refetch) {
        if (refetch instanceof SyncHttpError && refetch.code === "pin_mismatch") throw refetch;
        throw error;
      }
      // The server says its certificate is the one held, yet its TLS layer
      // presents one that does not verify: something in between copied the
      // certificate but cannot show its key.
      if (fresh.der.equals(cert.der)) throw mismatch();
      held = Promise.resolve(fresh);
      try {
        return await send(request, fresh);
      } catch (retryError) {
        if (isTlsVerifyError(retryError)) throw mismatch();
        throw retryError;
      }
    }
  };
}

const plainFetch: Fetch = (request) => fetch(request);

/** The fetch a client sends with: pinned when there is a pin, `base` (Bun's fetch by default) otherwise. */
function clientFetch(server: string, base: Fetch | undefined, pin: Buffer | null | undefined): Fetch {
  if (pin) return pinnedFetch(server, pin, base);
  return base ?? plainFetch;
}

/** One request, without following redirects; a non-2xx answer becomes a SyncHttpError. */
async function send<T>(doFetch: Fetch, server: string, method: string, path: string, raw: Uint8Array | null, headers: Record<string, string>): Promise<T> {
  let response: Response;
  try {
    // Never followed: a redirect would carry the enroll token and the
    // signed request to wherever it points, plain http included.
    response = await doFetch(
      new Request(`${server}${PROTOCOL_PREFIX}${path}`, {
        method,
        headers: raw === null ? headers : { ...headers, "content-type": "application/json" },
        body: raw ?? undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    );
  } catch (error) {
    // Already worded: the pinned fetch's certificate request, or its pin check.
    if (error instanceof SyncHttpError) throw error;
    // Never retried: nothing goes out to a key this device does not trust.
    if (isPinMismatch(error)) throw new SyncHttpError(0, "pin_mismatch", PIN_MISMATCH(server));
    const code = (error as { code?: unknown } | null)?.code;
    throw new SyncHttpError(0, "unreachable", `Could not reach ${server}: ${(error as Error).message}`, typeof code === "string" ? code : undefined);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new SyncHttpError(
      response.status,
      "redirect",
      `${server} answered with a redirect, which Kerstel does not follow for sync. Use the server's final URL.`,
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new SyncHttpError(0, "unreachable", `Could not read ${server}'s answer: ${(error as Error).message}`);
  }
  if (!response.ok) {
    let parsed: Partial<ErrorBody> = {};
    try {
      parsed = JSON.parse(text) as ErrorBody;
    } catch {
      // Not the server's JSON: a proxy's page, say. Its status is all there is.
    }
    throw new SyncHttpError(response.status, parsed.error ?? "http", parsed.message ?? `The server answered ${response.status}.`);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

const encode = (body: unknown): Uint8Array | null => (body === undefined ? null : new TextEncoder().encode(JSON.stringify(body)));

export function syncClient(options: ClientOptions) {
  const doFetch = clientFetch(options.server, options.fetch, options.pin);
  const clock = options.now ?? Date.now;
  // Never the same millisecond twice: Ed25519 signatures are deterministic, so
  // two identical requests stamped alike would carry the same signature, and
  // the server refuses the second as a replay.
  let last = 0;
  const now = (): number => (last = Math.max(clock(), last + 1));

  function call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const raw = encode(body);
    const headers = {
      ...signRequest(options.sign, options.deviceId, method, `${PROTOCOL_PREFIX}${path}`, raw ?? new Uint8Array(), now()),
      ...extra,
    };
    return send<T>(doFetch, options.server, method, path, raw, headers);
  }

  const vault = `/vaults/${options.vaultId}`;
  return {
    createVault(body: CreateVaultBody, enrollToken: string | null) {
      return call<{ epoch: number; head: number }>("POST", "/vaults", body, enrollToken ? { [HEADERS.enrollToken]: enrollToken } : {});
    },
    pull(since: number, full: boolean) {
      return call<PullResponse>("GET", `${vault}/records?since=${since}${full ? "&full=1" : ""}`);
    },
    push(body: PushBody) {
      return call<PushResponse>("POST", `${vault}/records`, body);
    },
    keys() {
      return call<{ epoch: number; sealedKey: string }>("GET", `${vault}/keys`);
    },
    devices() {
      return call<{ devices: DeviceOut[] }>("GET", `${vault}/devices`);
    },
    removeSelf() {
      return call<void>("DELETE", `${vault}/devices/${options.deviceId}`);
    },
    deleteVault() {
      return call<void>("DELETE", vault);
    },
    addDevice(body: AddDeviceBody) {
      return call<DeviceOut>("POST", `${vault}/devices`, body);
    },
    rotate(body: RotateBody) {
      return call<{ epoch: number; head: number }>("POST", `${vault}/epochs`, body);
    },
    openPairing(pairingId: string) {
      return call<{ expiresAt: number }>("POST", `${vault}/pairings`, { pairingId });
    },
    readPairing(pairingId: string) {
      return call<PairingSlotOut>("GET", `${vault}/pairings/${pairingId}`);
    },
    closePairing(pairingId: string) {
      return call<void>("DELETE", `${vault}/pairings/${pairingId}`);
    },
  };
}

export type SyncClient = ReturnType<typeof syncClient>;

/**
 * The new device's half of pairing, before it has a key the server knows:
 * unsigned. The answer is sealed with the pairing secret instead.
 */
export function pairingClient(server: string, fetchImpl?: Fetch, pin?: Buffer | null) {
  const doFetch = clientFetch(server, fetchImpl, pin);
  return {
    answer(pairingId: string, payload: string) {
      return send<void>(doFetch, server, "PUT", `/pairings/${pairingId}`, encode({ payload }), {});
    },
    state(pairingId: string) {
      return send<PairingStateOut>(doFetch, server, "GET", `/pairings/${pairingId}`, null, {});
    },
  };
}
