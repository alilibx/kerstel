import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { AcmeError, acmeAdvice, obtainCertificate, type AcmeDeps } from "../src/acme";
import { startFakeAcme, type FakeAcme } from "./helpers/fake-acme";

const DOMAIN = "sync.test";

const freshKey = (): KeyObject => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
const spkiOf = (key: KeyObject): Buffer => createPublicKey(key).export({ type: "spki", format: "der" });

/** The HTTP-01 listener: answers each token from `challenges`, as `kerstel-server` will. */
function challengeListener(challenges: Map<string, string>) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const token = /^\/\.well-known\/acme-challenge\/([^/]+)$/.exec(new URL(request.url).pathname)?.[1];
      const answer = token && challenges.get(token);
      return answer ? new Response(answer) : new Response("not found", { status: 404 });
    },
  });
}

let challenges: Map<string, string>;
let listener: ReturnType<typeof challengeListener>;
let ca: FakeAcme;
let sleeps: number[];
const deps: Partial<AcmeDeps> = {
  sleep: async (ms) => {
    sleeps.push(ms);
  },
};

beforeEach(() => {
  challenges = new Map();
  listener = challengeListener(challenges);
  ca = startFakeAcme({ challengePort: listener.port! });
  sleeps = [];
});
afterEach(() => {
  ca.stop();
  listener.stop(true);
});

const run = (o: { certKey?: KeyObject; accountKey?: KeyObject; email?: string | null; fetch?: AcmeDeps["fetch"] } = {}) =>
  obtainCertificate({
    directory: ca.directory,
    domain: DOMAIN,
    email: o.email === undefined ? "ops@sync.test" : o.email,
    accountKey: o.accountKey ?? freshKey(),
    certKey: o.certKey ?? freshKey(),
    challenges,
    deps: { ...deps, ...(o.fetch ? { fetch: o.fetch } : {}) },
  });

const certificatesIn = (pem: string): X509Certificate[] =>
  (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((p) => new X509Certificate(p));

describe("obtainCertificate", () => {
  test("obtains a certificate", async () => {
    const certKey = freshKey();
    const pem = await run({ certKey });
    const [leaf, issuer] = certificatesIn(pem);
    expect(leaf!.subjectAltName).toBe(`DNS:${DOMAIN}`);
    expect(leaf!.publicKey.export({ type: "spki", format: "der" }).equals(spkiOf(certKey))).toBe(true);
    expect(leaf!.checkIssued(issuer!)).toBe(true);
    expect(leaf!.verify(issuer!.publicKey)).toBe(true);
    expect(challenges.size).toBe(0);
    expect(ca.validated).toBe(1); // the CA fetched the key authorization from the listener
    expect(ca.accounts[0]!.contact).toEqual([`mailto:ops@sync.test`]);
    // The authorization was polled every 2 s; the order, still processing after finalize, after its Retry-After of 3 s.
    expect(sleeps).toEqual([2000, 3000]);
  });

  test("an account without an email has no contact", async () => {
    await run({ email: null });
    expect(ca.accounts[0]!.contact).toBeUndefined();
  });

  test("every request is signed", async () => {
    // A JWS whose signature is one bit off is refused.
    const accountKey = freshKey();
    const nonce = (await fetch(ca.url("/new-nonce"), { method: "HEAD" })).headers.get("replay-nonce")!;
    const { kty, crv, x, y } = createPublicKey(accountKey).export({ format: "jwk" });
    const header = Buffer.from(JSON.stringify({ alg: "ES256", nonce, url: ca.url("/new-account"), jwk: { crv, kty, x, y } })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ termsOfServiceAgreed: true })).toString("base64url");
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: accountKey, dsaEncoding: "ieee-p1363" });
    signature[10]! ^= 1;
    const forged = await fetch(ca.url("/new-account"), {
      method: "POST",
      headers: { "content-type": "application/jose+json" },
      body: JSON.stringify({ protected: header, payload, signature: signature.toString("base64url") }),
    });
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as { type: string }).type).toBe("urn:ietf:params:acme:error:malformed");
    expect(ca.accounts.length).toBe(0);

    // The client's run then succeeds, so the fake CA verified every POST it sent.
    const posts: number[] = [];
    const pem = await run({
      accountKey,
      fetch: async (request) => {
        const response = await fetch(request);
        if (request.method === "POST") posts.push(response.status);
        return response;
      },
    });
    expect(certificatesIn(pem).length).toBe(2);
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((status) => status < 300)).toBe(true);
    expect(ca.verified).toBe(posts.length);
    expect(ca.rejected).toBe(1);
    expect(ca.counts.newAccount).toBe(1);
  });

  test("a badNonce is retried once", async () => {
    ca.badNonceOnce("newOrder");
    const statuses: number[] = [];
    const pem = await run({
      fetch: async (request) => {
        const response = await fetch(request);
        if (new URL(request.url).pathname === "/new-order") statuses.push(response.status);
        return response;
      },
    });
    expect(certificatesIn(pem).length).toBe(2);
    expect(statuses).toEqual([400, 201]);
  });

  test("a failed order says which port or record to fix", async () => {
    ca.failValidation("urn:ietf:params:acme:error:connection");
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AcmeError);
    expect((error as AcmeError).problem?.type).toBe("urn:ietf:params:acme:error:connection");
    expect(acmeAdvice(error as AcmeError, DOMAIN, 80)).toBe(
      `Let's Encrypt could not fetch http://${DOMAIN}/.well-known/acme-challenge/ from this host. Check that port 80 is open to the internet and reaches kerstel-server.`,
    );
    expect(challenges.size).toBe(0);

    ca.failValidation("urn:ietf:params:acme:error:dns");
    const dns = await run().catch((e: unknown) => e);
    expect(dns).toBeInstanceOf(AcmeError);
    expect(acmeAdvice(dns as AcmeError, DOMAIN, 80)).toBe(`${DOMAIN} does not resolve. Point an A or AAAA record at this host.`);
  });

  test("a challenge the listener cannot answer fails validation", async () => {
    listener.stop(true);
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AcmeError);
    expect((error as AcmeError).problem?.type).toBe("urn:ietf:params:acme:error:connection");
  });
});

describe("acmeAdvice", () => {
  const advice = (type: string | undefined, detail = "the detail") =>
    acmeAdvice(new AcmeError("message", type === undefined ? null : { type, detail }), DOMAIN, 8080);

  test("names the port for a connection or unauthorized problem", () => {
    expect(advice("urn:ietf:params:acme:error:unauthorized")).toContain("port 8080");
  });

  test("says the CA is rate limiting", () => {
    expect(advice("urn:ietf:params:acme:error:rateLimited")).toBe(
      "The CA is rate limiting this domain. kerstel-server tries again in an hour.",
    );
  });

  test("falls back to the problem's detail, then the message", () => {
    expect(advice("urn:ietf:params:acme:error:serverInternal")).toBe("the detail");
    expect(advice(undefined)).toBe("message");
  });
});
