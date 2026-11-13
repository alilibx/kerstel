/**
 * A certificate from an ACME CA (RFC 8555), for `kerstel-server --domain`.
 * Only what one DNS name over HTTP-01 needs: an ES256 account, one order, its
 * http-01 challenges, finalize and download. The server takes no dependency
 * for this, so the client lives here.
 */
import { createHash, createPublicKey, sign, type KeyObject } from "node:crypto";
import { certificateRequest } from "./x509";

export interface AcmeDeps {
  fetch: (request: Request) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
}

/** An RFC 7807 problem document, as far as the advice needs one. */
export type AcmeProblem = { type?: string; detail?: string };

export class AcmeError extends Error {
  constructor(
    message: string,
    readonly problem: AcmeProblem | null,
  ) {
    super(message);
    this.name = "AcmeError";
  }
}

const ERROR = "urn:ietf:params:acme:error:";
const POLL_MS = 2_000;
const POLL_LIMIT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
}

interface Order {
  status: string;
  authorizations: string[];
  finalize: string;
  certificate?: string;
  error?: AcmeProblem;
}

interface Challenge {
  type: string;
  url: string;
  token: string;
  error?: AcmeProblem;
}

interface Authorization {
  status: string;
  challenges: Challenge[];
}

const base64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

/**
 * Gets a certificate for `domain`, signed for `certKey`, and returns its PEM
 * chain. While the CA validates, `challenges` maps each token to its key
 * authorization, for the HTTP-01 listener to serve; the entry is removed afterwards.
 */
export async function obtainCertificate(o: {
  directory: string;
  domain: string;
  email: string | null;
  accountKey: KeyObject;
  certKey: KeyObject;
  challenges: Map<string, string>;
  deps?: Partial<AcmeDeps>;
}): Promise<string> {
  const deps: AcmeDeps = {
    // A stalled CA fails the request rather than holding the order forever.
    fetch: (request) => fetch(request, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    sleep: (ms) => Bun.sleep(ms),
    ...o.deps,
  };
  const { kty, crv, x, y } = createPublicKey(o.accountKey).export({ format: "jwk" });
  if (kty !== "EC" || crv !== "P-256") throw new Error("the ACME account key must be ECDSA P-256");
  // RFC 7638: the required members, in lexicographic order, with no spaces.
  const jwk = { crv, kty, x, y };
  const thumbprint = base64url(createHash("sha256").update(JSON.stringify(jwk)).digest());

  let nonce: string | null = null;
  let kid: string | null = null;

  async function send(request: Request, what: string): Promise<Response> {
    let response: Response;
    try {
      response = await deps.fetch(request);
    } catch (error) {
      throw new AcmeError(`Could not reach the ACME CA for ${what}: ${(error as Error).message}`, null);
    }
    nonce = response.headers.get("replay-nonce") ?? nonce;
    return response;
  }

  async function refused(response: Response, what: string): Promise<AcmeError> {
    let problem: AcmeProblem | null = null;
    if (response.headers.get("content-type")?.startsWith("application/problem+json")) {
      problem = (await response.json().catch(() => null)) as AcmeProblem | null;
    } else {
      await response.body?.cancel();
    }
    return new AcmeError(`The ACME CA refused ${what}: ${problem?.detail ?? `HTTP ${response.status}`}`, problem);
  }

  const directory = await send(new Request(o.directory), "its directory");
  if (!directory.ok) throw await refused(directory, "its directory");
  const urls = (await directory.json()) as Directory;

  /** A JWS POST; `payload` null is a POST-as-GET. A badNonce is retried once, with the nonce it returned. */
  async function post(url: string, payload: unknown, what: string, accept?: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      if (nonce === null) {
        const head = await send(new Request(urls.newNonce, { method: "HEAD" }), "a nonce");
        if (!head.ok || nonce === null) throw new AcmeError("The ACME CA gave no nonce.", null);
      }
      const header = { alg: "ES256", nonce, url, ...(kid ? { kid } : { jwk }) };
      nonce = null;
      const protectedHeader = base64url(JSON.stringify(header));
      const body = payload === null ? "" : base64url(JSON.stringify(payload));
      const signature = sign("sha256", Buffer.from(`${protectedHeader}.${body}`), {
        key: o.accountKey,
        dsaEncoding: "ieee-p1363",
      });
      const headers: Record<string, string> = { "content-type": "application/jose+json" };
      if (accept) headers.accept = accept;
      const response = await send(
        new Request(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ protected: protectedHeader, payload: body, signature: base64url(signature) }),
        }),
        what,
      );
      if (response.ok) return response;
      const error = await refused(response, what);
      if (attempt > 0 || error.problem?.type !== `${ERROR}badNonce`) throw error;
    }
  }

  /** POST-as-GET `url` until its status leaves `waiting`, every 2 s or as Retry-After says, for up to 2 minutes. */
  async function poll<T extends { status: string }>(url: string, first: Response, waiting: string[], what: string): Promise<T> {
    let response = first;
    let resource = (await response.json()) as T;
    for (let waited = 0; waiting.includes(resource.status); ) {
      const delay = Math.min(Math.max(POLL_MS, retryAfter(response)), POLL_LIMIT_MS - waited);
      if (delay <= 0) throw new AcmeError(`The ACME CA did not finish ${what} within 2 minutes.`, null);
      await deps.sleep(delay);
      waited += delay;
      response = await post(url, null, what);
      resource = (await response.json()) as T;
    }
    return resource;
  }

  const account = await post(
    urls.newAccount,
    { termsOfServiceAgreed: true, ...(o.email ? { contact: [`mailto:${o.email}`] } : {}) },
    "the account",
  );
  await account.body?.cancel();
  kid = account.headers.get("location");
  if (!kid) throw new AcmeError("The ACME CA gave the account no URL.", null);

  const created = await post(urls.newOrder, { identifiers: [{ type: "dns", value: o.domain }] }, "the order");
  const orderUrl = created.headers.get("location");
  if (!orderUrl) throw new AcmeError("The ACME CA gave the order no URL.", null);
  const order = (await created.json()) as Order;

  for (const authorizationUrl of order.authorizations) {
    const authorization = (await (await post(authorizationUrl, null, "the authorization")).json()) as Authorization;
    if (authorization.status === "valid") continue;
    const challenge = authorization.challenges.find((c) => c.type === "http-01");
    if (!challenge) throw new AcmeError(`The ACME CA offered no http-01 challenge for ${o.domain}.`, null);
    o.challenges.set(challenge.token, `${challenge.token}.${thumbprint}`);
    try {
      await (await post(challenge.url, {}, "the challenge")).body?.cancel();
      const done = await poll<Authorization>(
        authorizationUrl,
        await post(authorizationUrl, null, "the authorization"),
        ["pending", "processing"],
        `validating ${o.domain}`,
      );
      if (done.status !== "valid") {
        const problem = done.challenges.find((c) => c.type === "http-01")?.error ?? null;
        throw new AcmeError(`The ACME CA could not validate ${o.domain}: ${problem?.detail ?? done.status}`, problem);
      }
    } finally {
      o.challenges.delete(challenge.token);
    }
  }

  const csr = base64url(certificateRequest({ key: o.certKey, domain: o.domain }));
  const finished = await poll<Order>(
    orderUrl,
    await post(order.finalize, { csr }, "the certificate request"),
    ["ready", "processing"],
    "the certificate",
  );
  if (finished.status !== "valid" || !finished.certificate) {
    const problem = finished.error ?? null;
    throw new AcmeError(`The ACME CA did not issue the certificate: ${problem?.detail ?? finished.status}`, problem);
  }
  const certificate = await post(finished.certificate, null, "the certificate", "application/pem-certificate-chain");
  return await certificate.text();
}

/** Milliseconds a response's Retry-After asks for, or 0. */
function retryAfter(response: Response): number {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(ms, 0) : 0;
}

/** One line of what to fix after a failed order. */
export function acmeAdvice(error: AcmeError, domain: string, httpPort: number): string {
  const type = error.problem?.type ?? "";
  if (type.endsWith(":connection") || type.endsWith(":unauthorized")) {
    return `The ACME CA could not fetch http://${domain}/.well-known/acme-challenge/ from this host. Check that port ${httpPort} is open to the internet and reaches kerstel-server.`;
  }
  if (type.endsWith(":dns")) return `${domain} does not resolve. Point an A or AAAA record at this host.`;
  if (type.endsWith(":rateLimited")) return "The ACME CA is rate limiting this domain. kerstel-server tries again in an hour.";
  return error.problem?.detail ?? error.message;
}
