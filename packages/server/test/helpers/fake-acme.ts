/**
 * A test ACME CA: the subset of RFC 8555 that `obtainCertificate` uses, served
 * in-process. It verifies every JWS for real (ES256 signature, nonce, url,
 * jwk or kid), fetches each http-01 key authorization from the challenge
 * listener itself, as Let's Encrypt does (`Host: <domain>`), and issues a
 * certificate for the CSR's key under its own CA once the CSR names exactly the
 * order's domain and its key is not the account's.
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { issueCertificate, toPem } from "../../src/x509";

const ERROR = "urn:ietf:params:acme:error:";
const CA_NAME = "Kerstel test CA";

/** An EC public key as a JWK: the members RFC 7638 hashes. */
type Jwk = { crv?: string; kty?: string; x?: string; y?: string };

type Endpoint = "newAccount" | "newOrder" | "authorization" | "challenge" | "finalize" | "order" | "certificate";

interface Account {
  url: string;
  jwk: Jwk;
  thumbprint: string;
  contact?: string[];
}

interface Authorization {
  id: string;
  account: string;
  domain: string;
  token: string;
  status: "pending" | "valid" | "invalid";
  error?: { type: string; detail: string };
  validation: Promise<void> | null;
  pollsSinceChallenge: number;
}

interface Order {
  id: string;
  account: string;
  domain: string;
  authorization: Authorization;
  certificate: string | null;
  finalized: boolean;
}

export interface FakeAcme {
  /** The directory URL to hand `obtainCertificate`. */
  directory: string;
  /** The CA certificate that signs every issued certificate. */
  caPem: string;
  url(path: string): string;
  accounts: Account[];
  /** Verified requests per endpoint. */
  counts: Record<Endpoint, number>;
  /** JWS POSTs that passed every check, and those refused for a bad signature, nonce, url or key. */
  verified: number;
  rejected: number;
  /** Key authorizations fetched from the challenge listener and found correct. */
  validated: number;
  /** Fail every later validation with this problem type, or validate for real again with null. */
  failValidation(type: string | null): void;
  /** Answer the next request to `endpoint` with badNonce. */
  badNonceOnce(endpoint: Endpoint): void;
  stop(): void;
}

class Problem extends Error {
  constructor(
    readonly type: string,
    readonly detail: string,
    readonly status = 400,
  ) {
    super(detail);
  }
}

/** `validityMs`: how long each issued certificate lasts from when it is issued (default: no expiry). */
export function startFakeAcme(o: { challengePort: number; validityMs?: number }): FakeAcme {
  const caKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const caSpki = createPublicKey(caKey).export({ type: "spki", format: "der" });
  const caPem = toPem(
    issueCertificate({ subjectSpki: caSpki, issuerKey: caKey, issuerName: CA_NAME, subjectName: CA_NAME, names: [], ca: true }),
    "CERTIFICATE",
  );
  const nonces = new Set<string>();
  const authorizations = new Map<string, Authorization>();
  const orders = new Map<string, Order>();
  let failType: string | null = null;
  let badNonceFor: Endpoint | null = null;
  let base = "";

  const fake: FakeAcme = {
    directory: "",
    caPem,
    url: (path) => `${base}${path}`,
    accounts: [],
    counts: { newAccount: 0, newOrder: 0, authorization: 0, challenge: 0, finalize: 0, order: 0, certificate: 0 },
    verified: 0,
    rejected: 0,
    validated: 0,
    failValidation: (type) => {
      failType = type;
    },
    badNonceOnce: (endpoint) => {
      badNonceFor = endpoint;
    },
    stop: () => server.stop(true),
  };

  const newId = () => randomBytes(9).toString("base64url");
  const nonce = () => {
    const n = randomBytes(16).toString("base64url");
    nonces.add(n);
    return n;
  };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { "replay-nonce": nonce(), ...headers } });

  /** `validating` reports the challenge as still processing, whatever the result so far. */
  const authorizationJson = (a: Authorization, validating = a.status === "pending" && a.validation !== null) => ({
    status: validating ? "pending" : a.status,
    identifier: { type: "dns", value: a.domain },
    challenges: [
      {
        type: "http-01",
        url: fake.url(`/chall/${a.id}`),
        token: a.token,
        status: validating ? "processing" : a.status,
        ...(a.error && !validating ? { error: a.error } : {}),
      },
    ],
  });

  const orderStatus = (order: Order) => {
    if (order.certificate) return "valid";
    if (order.finalized) return "processing";
    if (order.authorization.status === "invalid") return "invalid";
    return order.authorization.status === "valid" ? "ready" : "pending";
  };
  const orderJson = (order: Order) => ({
    status: orderStatus(order),
    identifiers: [{ type: "dns", value: order.domain }],
    authorizations: [fake.url(`/authz/${order.authorization.id}`)],
    finalize: fake.url(`/finalize/${order.id}`),
    ...(order.certificate ? { certificate: fake.url(`/cert/${order.id}`) } : {}),
  });

  async function validate(a: Authorization, account: Account): Promise<void> {
    if (failType) {
      a.status = "invalid";
      a.error = { type: failType, detail: "The fake CA was told to fail validation." };
      return;
    }
    let body: string;
    try {
      const response = await fetch(`http://127.0.0.1:${o.challengePort}/.well-known/acme-challenge/${a.token}`, {
        headers: { host: a.domain },
      });
      body = response.ok ? await response.text() : "";
    } catch {
      a.status = "invalid";
      a.error = { type: `${ERROR}connection`, detail: "The fake CA could not connect to the challenge listener." };
      return;
    }
    if (body.trim() === `${a.token}.${account.thumbprint}`) {
      a.status = "valid";
      fake.validated++;
    } else {
      a.status = "invalid";
      a.error = { type: `${ERROR}unauthorized`, detail: "The key authorization did not match." };
    }
  }

  /** A refused JWS, counted in `rejected`. */
  const refuse = (type: string, detail: string, status?: number) => {
    fake.rejected++;
    return new Problem(type, detail, status);
  };

  /** The JWS checks of RFC 8555 §6.2-6.4. Returns the payload (null for POST-as-GET) and the signing account. */
  async function verifyJws(request: Request, endpoint: Endpoint): Promise<{ payload: any; account: Account | null; jwk: Jwk }> {
    if (request.headers.get("content-type") !== "application/jose+json") {
      throw refuse(`${ERROR}malformed`, "The content type must be application/jose+json.", 415);
    }
    const jws = (await request.json()) as { protected: string; payload: string; signature: string };
    const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString("utf8"));
    if (header.alg !== "ES256") throw refuse(`${ERROR}badSignatureAlgorithm`, "Only ES256 is supported.");
    if (badNonceFor === endpoint) {
      badNonceFor = null;
      nonces.delete(header.nonce);
      throw new Problem(`${ERROR}badNonce`, "The fake CA was told to refuse this nonce.");
    }
    if (!nonces.delete(header.nonce)) throw refuse(`${ERROR}badNonce`, "The nonce is unknown or used.");
    if (header.url !== request.url) throw refuse(`${ERROR}unauthorized`, "The url header does not match the request.", 401);
    let account: Account | null = null;
    let jwk: Jwk;
    if (endpoint === "newAccount") {
      if (!header.jwk || header.kid) throw refuse(`${ERROR}malformed`, "newAccount is signed with a jwk.");
      if ("d" in header.jwk) throw refuse(`${ERROR}malformed`, "The jwk carries a private key.");
      jwk = header.jwk;
    } else {
      if (!header.kid || header.jwk) throw refuse(`${ERROR}malformed`, "This request is signed with a kid.");
      account = fake.accounts.find((a) => a.url === header.kid) ?? null;
      if (!account) throw refuse(`${ERROR}accountDoesNotExist`, "No account has that kid.");
      jwk = account.jwk;
    }
    const signature = Buffer.from(jws.signature, "base64url");
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const signed = Buffer.from(`${jws.protected}.${jws.payload}`);
    if (signature.length !== 64 || !verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, signature)) {
      throw refuse(`${ERROR}malformed`, "The JWS signature does not verify.");
    }
    const payload = jws.payload === "" ? null : JSON.parse(Buffer.from(jws.payload, "base64url").toString("utf8"));
    return { payload, account, jwk };
  }

  function owned<T extends { account: string }>(map: Map<string, T>, id: string, account: Account | null): T {
    const resource = map.get(id);
    if (!resource || resource.account !== account?.url) throw new Problem(`${ERROR}malformed`, "No such resource.", 404);
    return resource;
  }

  function postAsGet(payload: unknown): void {
    if (payload !== null) throw new Problem(`${ERROR}malformed`, "This is a POST-as-GET: the payload must be empty.");
  }

  async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/dir") {
      return Response.json({ newNonce: fake.url("/new-nonce"), newAccount: fake.url("/new-account"), newOrder: fake.url("/new-order") });
    }
    if (path === "/new-nonce") return new Response(null, { status: 200, headers: { "replay-nonce": nonce(), "cache-control": "no-store" } });
    if (request.method !== "POST") return new Response("not found", { status: 404 });

    const [, route, id = ""] = path.split("/");
    const endpoint = (
      { "new-account": "newAccount", "new-order": "newOrder", authz: "authorization", chall: "challenge", finalize: "finalize", order: "order", cert: "certificate" } as const
    )[route as string];
    if (!endpoint) return new Response("not found", { status: 404 });

    const verified = await verifyJws(request, endpoint);
    fake.verified++;
    fake.counts[endpoint]++;
    const { payload, account, jwk } = verified;

    switch (endpoint) {
      case "newAccount": {
        if (payload?.termsOfServiceAgreed !== true) throw new Problem(`${ERROR}userActionRequired`, "The terms of service must be agreed.", 403);
        const { crv, kty, x, y } = jwk;
        const thumbprint = createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url");
        const existing = fake.accounts.find((a) => a.thumbprint === thumbprint);
        if (existing) return json({ status: "valid" }, 200, { location: existing.url });
        const created: Account = { url: fake.url(`/acct/${newId()}`), jwk: { crv, kty, x, y }, thumbprint, contact: payload.contact };
        fake.accounts.push(created);
        return json({ status: "valid", contact: created.contact }, 201, { location: created.url });
      }
      case "newOrder": {
        const identifiers = payload?.identifiers as { type: string; value: string }[] | undefined;
        if (identifiers?.length !== 1 || identifiers[0]!.type !== "dns") throw new Problem(`${ERROR}rejectedIdentifier`, "One DNS name, please.");
        const authorization: Authorization = {
          id: newId(),
          account: account!.url,
          domain: identifiers[0]!.value,
          token: randomBytes(32).toString("base64url"),
          status: "pending",
          validation: null,
          pollsSinceChallenge: 0,
        };
        authorizations.set(authorization.id, authorization);
        const order: Order = { id: newId(), account: account!.url, domain: authorization.domain, authorization, certificate: null, finalized: false };
        orders.set(order.id, order);
        return json(orderJson(order), 201, { location: fake.url(`/order/${order.id}`) });
      }
      case "authorization": {
        postAsGet(payload);
        const a = owned(authorizations, id, account);
        // The first poll after the challenge says pending, so the client polls again; later ones wait for the result.
        if (a.validation && a.pollsSinceChallenge++ === 0) return json(authorizationJson(a, true));
        if (a.validation) await a.validation;
        return json(authorizationJson(a));
      }
      case "challenge": {
        if (payload === null || Object.keys(payload).length !== 0) throw new Problem(`${ERROR}malformed`, "A challenge response is {}.");
        const a = owned(authorizations, id, account);
        if (a.status === "pending" && !a.validation) a.validation = validate(a, account!);
        return json(authorizationJson(a).challenges[0]);
      }
      case "finalize": {
        const order = owned(orders, id, account);
        if (orderStatus(order) !== "ready") throw new Problem(`${ERROR}orderNotReady`, "The order is not ready.", 403);
        const csr = readCsr(Buffer.from(payload?.csr ?? "", "base64url"));
        if (csr.names.length !== 1 || csr.names[0] !== order.domain) {
          throw new Problem(`${ERROR}badCSR`, `The CSR names ${csr.names.join(", ") || "nothing"}, not ${order.domain}.`);
        }
        if (csr.spki.equals(createPublicKey({ key: jwk, format: "jwk" }).export({ type: "spki", format: "der" }))) {
          throw new Problem(`${ERROR}badCSR`, "The CSR's key is the account key.");
        }
        const leaf = issueCertificate({
          subjectSpki: csr.spki,
          issuerKey: caKey,
          issuerName: CA_NAME,
          subjectName: order.domain,
          names: [order.domain],
          ...(o.validityMs === undefined ? {} : { notAfter: Date.now() + o.validityMs }),
        });
        order.finalized = true;
        const response = json(orderJson(order), 200, { location: fake.url(`/order/${order.id}`), "retry-after": "3" });
        order.certificate = toPem(leaf, "CERTIFICATE") + caPem; // ready from the next poll
        return response;
      }
      case "order":
        postAsGet(payload);
        return json(orderJson(owned(orders, id, account)));
      case "certificate": {
        postAsGet(payload);
        // RFC 8555 lets the Accept header default; the fake insists on it, so the test sees the client send it.
        if (request.headers.get("accept") !== "application/pem-certificate-chain") {
          throw new Problem(`${ERROR}malformed`, "Accept must be application/pem-certificate-chain.", 406);
        }
        const order = owned(orders, id, account);
        return new Response(order.certificate, { headers: { "content-type": "application/pem-certificate-chain", "replay-nonce": nonce() } });
      }
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        return await handle(request);
      } catch (error) {
        const problem = error instanceof Problem ? error : new Problem(`${ERROR}serverInternal`, String(error), 500);
        return Response.json(
          { type: problem.type, detail: problem.detail },
          { status: problem.status, headers: { "content-type": "application/problem+json", "replay-nonce": nonce() } },
        );
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  fake.directory = fake.url("/dir");
  return fake;
}

// --- A minimal DER reader for the CSR ----------------------------------------

function tlv(der: Buffer, at: number): { tag: number; start: number; end: number; next: number } {
  const tag = der[at]!;
  let length = der[at + 1]!;
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + der[start + i]!;
    start += count;
  }
  if (start + length > der.length) throw new Problem(`${ERROR}badCSR`, "The CSR is truncated.");
  return { tag, start, end: start + length, next: start + length };
}

/** DER of id-ce-subjectAltName (2.5.29.17), as it appears inside its OBJECT IDENTIFIER. */
const SAN_OID = Buffer.from([0x55, 0x1d, 0x11]);

/** The TLVs directly inside `parent`. */
function children(der: Buffer, parent: { start: number; end: number }) {
  const out: ReturnType<typeof tlv>[] = [];
  for (let at = parent.start; at < parent.end; at = out[out.length - 1]!.next) out.push(tlv(der, at));
  return out;
}

/** The SPKI and subjectAltName dNSNames of a PKCS#10 request, after checking its self-signature. */
function readCsr(der: Buffer): { spki: Buffer; names: string[] } {
  if (der.length < 2) throw new Problem(`${ERROR}badCSR`, "The CSR is empty.");
  const request = tlv(der, 0);
  const info = tlv(der, request.start); // CertificationRequestInfo
  const algorithm = tlv(der, info.next);
  const signature = tlv(der, algorithm.next); // BIT STRING: an unused-bits byte, then the DER ECDSA signature
  const version = tlv(der, info.start);
  const subject = tlv(der, version.next);
  const spki = tlv(der, subject.next);
  const spkiDer = der.subarray(subject.next, spki.end);
  const key = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
  if (!verify("sha256", der.subarray(request.start, info.end), key, der.subarray(signature.start + 1, signature.end))) {
    throw new Problem(`${ERROR}badCSR`, "The CSR's signature does not verify.");
  }
  // [0] attributes: each a SEQUENCE { type, SET { value } }; extensionRequest's value is Extensions.
  const names: string[] = [];
  const attributes = spki.next < info.end ? tlv(der, spki.next) : null;
  for (const attribute of attributes ? children(der, attributes) : []) {
    const [, values] = children(der, attribute);
    for (const extensions of values ? children(der, values) : []) {
      for (const extension of children(der, extensions)) {
        const parts = children(der, extension);
        const id = parts[0]!;
        if (!der.subarray(id.start, id.end).equals(SAN_OID)) continue;
        const value = parts[parts.length - 1]!; // the OCTET STRING, after an optional critical flag
        for (const name of children(der, tlv(der, value.start))) {
          if (name.tag === 0x82) names.push(der.subarray(name.start, name.end).toString("ascii"));
        }
      }
    }
  }
  return { spki: Buffer.from(spkiDer), names };
}
