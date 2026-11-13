# Built-in HTTPS for kerstel-server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `kerstel-server` serves HTTPS itself, with a certificate it makes and devices pin (`--tls self`) or one from Let's Encrypt (`--domain`), and every Kerstel device checks a pinned server's key on every request (#112).

**Architecture:** The server gains a hand-built DER encoder for one self-signed certificate and one CSR (`x509.ts`), a small ACME client (`acme.ts`), and listener wiring in `index.ts`. The pin is the SHA-256 of the certificate's public key (SPKI), shared by server and client in `pin.ts`. The client never trusts a pinned server's certificate authority: it fetches the server's certificate once per process from `GET /v1/certificate`, checks its key against the pin, then sends every request with that one certificate as its only `ca`, and checks the pin again in `checkServerIdentity`. Tailscale needs no server code; its docs land here and its automation lands with the wizard (#106).

**Tech Stack:** TypeScript on Bun 1.4.2, `bun:test`, `node:crypto` (`generateKeyPairSync`, `sign`, `X509Certificate`), `Bun.serve` with `tls`, Bun `fetch` with `tls: { ca, checkServerIdentity }`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-13-easy-sync-design.md` §6 and §12, and §4's `ks sync setup <url> --pin`. It updates sync spec `docs/superpowers/specs/2026-11-08-sync-between-devices-design.md` §7.1 (the `https://` rule) and §9.1 (TLS).

**Branch:** `feat/server-tls`, stacked on `feat/join-value` (PR #117): it replaces #108's "refuse a pinned value" branch in `join`.

## Global Constraints

- The pin is the SHA-256 of the certificate's DER SubjectPublicKeyInfo. Its text form is `sha256/` followed by 43 characters of unpadded base64url.
- A pin mismatch fails the request with a clear message and is never retried without the pin. No redirect is followed, including on the certificate request.
- The client keeps `redirect: "manual"` on every request. The certificate request carries no secret and no signature.
- A pinned client passes `tls: { ca: <the server's own certificate>, checkServerIdentity }` and nothing else: Bun 1.4.2's `ca` replaces the default roots, and its `checkServerIdentity` fails a request when it throws (always throw; never rely on a returned `Error`).
- An unpinned client (Let's Encrypt, Tailscale, a reverse proxy) passes no `tls` option, so the normal certificate authority and hostname checks apply.
- The certificate request honours `HTTPS_PROXY` and `NO_PROXY` because it is an ordinary Bun `fetch`, like every other sync request (sync spec §8.1).
- The server's key lives beside its database, mode `0600`, and is never logged. It survives restarts. A new key only comes with a new database file.
- The CLI binary gains no dependency and no certificate generation. The server gains no dependency either: the certificate and the CSR are hand-built DER.
- ACME uses HTTP-01 on port 80. Tests use a local ACME server, never Let's Encrypt.
- `--listen` and `--trust-proxy` keep working unchanged for a server behind a reverse proxy.
- Tests never print a secret or a private key, and clean up every temporary home, database, key and listener.
- Copy uses `cliName()` for the command name. Every user-visible change gets a `CHANGELOG.md` line, and the website and README match the source (AGENTS.md).
- Never mention a hosted or paid sync server anywhere.

## Decisions for the maintainer

- **`GET /v1/certificate`.** An unauthenticated route that returns the server's certificate as `{ "certificate": "<base64 DER>" }`, or 404 `not_found` without TLS. It is public data and changes nothing a device sends or the server sees. It lets the client fetch the certificate with Bun's own `fetch`, so the proxy settings apply exactly as for every other request. The spec's alternative, a raw `node:tls` connection, would need its own `CONNECT` and `NO_PROXY` handling.
- **The certificate is not stored on the device.** Each process fetches it once per server and keeps it in memory: one extra request per sync. A certificate reissued with the same key keeps working with no state to go stale.
- **Self-signed certificate.** ECDSA P-256, signed with SHA-256, valid from one day ago until `99991231235959Z` (RFC 5280's "no expiry"). Names: `localhost`, `127.0.0.1`, the `--listen` host when it is a specific address, and every `--tls-name`. When the names change, the server reissues it with the same key, so the pin holds.
- **Files.** `<db>.tls-key.pem` (`0600`), `<db>.tls-cert.pem`, and for ACME `<db>.acme-account.pem` (`0600`).
- **ACME.** Hand-rolled (RFC 8555, about 250 lines): ES256 JWS, HTTP-01, `termsOfServiceAgreed: true`. Running with `--domain` is agreeing to the CA's terms, and `--help` says so. It renews when fewer than 30 days remain, checking every 12 hours, and restarts the HTTPS listener with the new certificate, since `Bun.serve`'s `reload` keeps the old one. A failed order is logged with what to fix and retried after an hour, never sooner.
- **Default listen with `--domain`:** `0.0.0.0:443`, and the challenge listener `0.0.0.0:80` (`--acme-http`).
- **Tailscale** is documented here (`--listen 127.0.0.1:8787` plus `tailscale serve`). The wizard runs it in #106.

## Review Focus

1. **The server's key changed** (its data was deleted and it started again). Every request fails with the pin message, nothing is retried without the pin, and `ks sync off` still turns sync off here, saying it couldn't reach the server to leave. Tests: Task 3, `a different key fails and is never retried without the pin`; Task 4, `sync off works when the pin no longer matches`.
2. **The server reissued its certificate with the same key** (new `--tls-name`). Devices keep syncing. Tests: Task 2, `new names reissue with the same key`; Task 3, `a reissued certificate with the same key still connects`.
3. **A pinned server answers with a redirect,** on the certificate request or a sync request. It is never followed. Test: Task 3, `no redirect is followed`.
4. **Let's Encrypt can't reach port 80, or the domain doesn't point at the host.** The server keeps running, logs what is missing, and retries no more than hourly. Test: Task 6, `a failed order says which port or record to fix`.
5. **A pin typed or pasted wrong** (`--pin` with a typo, the wrong prefix, or standard base64 with `+/=`). It is refused before any request, naming the expected form. Tests: Task 1, `parsePin refuses anything else`; Task 4, `setup refuses a bad pin before any request`.

---

### Task 1: Certificates and pins

**Files:**
- Create: `packages/server/src/pin.ts`, `packages/server/src/x509.ts`
- Test: `packages/server/test/x509.test.ts`

**Interfaces:**
- Produces, in `pin.ts` (imported by both server and CLI, so it imports only `node:crypto`):
  - `pinOfSpki(spkiDer: Buffer): Buffer` (32 bytes) and `pinOfCertificate(certDer: Buffer): Buffer`, which uses `new X509Certificate(der).publicKey.export({ type: "spki", format: "der" })`.
  - `formatPin(pin: Buffer): string` (`sha256/<base64url>`) and `parsePin(text: string): Buffer | null`.
- Produces, in `x509.ts`:
  - `issueCertificate(o: { subjectSpki: Buffer; issuerKey: KeyObject; issuerName?: string; subjectName?: string; names: string[]; ca?: boolean; now?: number }): Buffer`. DER, signed by `issuerKey`. Names default to `kerstel-server`. `ca: true` sets `basicConstraints` CA:true and `keyUsage` keyCertSign, for the test CA in Task 5.
  - `selfSignedCertificate(o: { key: KeyObject; names: string[]; now?: number }): Buffer`. `issueCertificate` with the key's own SPKI and the key as issuer. DER. Subject and issuer CN `kerstel-server`, a random positive 16-byte serial, SAN with an `iPAddress` entry for each IPv4 or IPv6 literal and a `dNSName` for the rest, `basicConstraints` CA:false and `extKeyUsage` serverAuth. A self-signed leaf has no `keyUsage`: BoringSSL trusts a self-signed certificate as its own anchor only when `keyUsage` is absent or allows keyCertSign. A CA-issued leaf has `keyUsage` digitalSignature.
  - `certificateRequest(o: { key: KeyObject; domain: string }): Buffer`. PKCS#10 DER with CN and one `dNSName` SAN.
  - `certificateNames(certDer: Buffer): string[]`, the SAN entries, for deciding whether to reissue.
  - `toPem(der: Buffer, label: "CERTIFICATE" | "CERTIFICATE REQUEST"): string`.

- [ ] **Step 1: Write the failing tests** in `x509.test.ts`:
  - `a self-signed certificate parses and verifies`: with a fresh P-256 key and names `["localhost", "127.0.0.1", "::1", "homebox.local"]`, `new X509Certificate(der)` succeeds, `verify(publicKey)` is true, `subjectAltName` contains `DNS:localhost`, `IP Address:127.0.0.1`, `DNS:homebox.local`, and `validTo` is in 9999.
  - `Bun serves it`: `Bun.serve({ tls: { cert: toPem(der, "CERTIFICATE"), key: <pem> } })`, then `fetch` with `tls: { ca: <pem> }` to `https://127.0.0.1:<port>/` returns 200.
  - `the pin is the key's, not the certificate's`: two certificates from one key with different names have equal `pinOfCertificate`; one from another key differs. `pinOfCertificate(der)` equals `pinOfSpki(key's spki)`.
  - `parsePin round-trips and refuses anything else`: `parsePin(formatPin(p))` equals `p`; `parsePin` returns null for the 43 characters without `sha256/`, `sha1/…`, a 42-character body, standard base64 with `+`, `/` or `=`, and surrounding junk. It trims whitespace.
  - `a CSR parses`: `openssl req -verify -noout -inform DER` on the CSR exits 0 and prints `verify OK` (skip when `Bun.which("openssl")` is null). `certificateNames` returns the names given to `selfSignedCertificate`.
- [ ] **Step 2: Run** `bun test packages/server/test/x509.test.ts`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement** both modules: a minimal DER writer (lengths, INTEGER, BIT STRING, OCTET STRING, OID, UTF8String, UTCTime or GeneralizedTime, SEQUENCE, SET, context tags), and signatures with `crypto.sign("sha256", tbs, key)` (DER ECDSA, OID `ecdsa-with-SHA256`).
- [ ] **Step 4: Run** the same command and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(server): build a self-signed certificate and its pin`.

### Task 2: `kerstel-server --tls self`

**Files:**
- Create: `packages/server/src/tls.ts`
- Modify: `packages/server/src/index.ts` (`HELP`, `ServerConfig`, `parseArgs`, `main`), `packages/server/src/app.ts` (the certificate route), `packages/server/src/protocol.ts` (route list, if it holds one)
- Test: `packages/server/test/server.test.ts`, `packages/server/test/tls.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `ServerConfig` gains `tls: { mode: "off" } | { mode: "self"; names: string[] } | { mode: "acme"; domain: string; directory: string; email: string | null; httpHostname: string; httpPort: number }`.
  - `tlsFiles(db: string): { key: string; cert: string; account: string }`, giving `<db>.tls-key.pem`, `<db>.tls-cert.pem`, `<db>.acme-account.pem`.
  - `loadSelfSigned(db: string, names: string[]): { keyPem: string; certPem: string; certDer: Buffer; pin: Buffer }`. It creates the key (P-256, written `0600` with `wx`, so it never replaces one) when missing, and writes a certificate when none exists or its names differ from `names`.
  - `createApp` options gain `certificate?: () => Buffer | null`. `GET /v1/certificate` returns 200 `{ certificate: <base64 DER> }` when it gives a certificate, else 404 `not_found`. The route label is `GET certificate`.

Behaviour to implement:
- Flags, each with an environment twin: `--tls self` (`KERSTEL_SERVER_TLS=self`), `--tls-name <name>` repeatable (`KERSTEL_SERVER_TLS_NAMES`, comma-separated), `--domain <name>` (`KERSTEL_SERVER_DOMAIN`), `--acme-directory <url>` (`KERSTEL_SERVER_ACME_DIRECTORY`, default `https://acme-v02.api.letsencrypt.org/directory`), `--acme-email <address>` (`KERSTEL_SERVER_ACME_EMAIL`), `--acme-http <host:port>` (`KERSTEL_SERVER_ACME_HTTP`, default `0.0.0.0:80`). `--tls self` with `--domain` is an error. `--tls-name` without `--tls self` is an error. `--tls` takes only `self`. With `--domain` and no `--listen` or `KERSTEL_SERVER_LISTEN`, listen defaults to `0.0.0.0:443`.
- Names for `--tls self`: `localhost`, `127.0.0.1`, the listen host unless it is `0.0.0.0`, `::` or already listed, then each `--tls-name`.
- With `--tls self`, `main` serves `Bun.serve({ tls: { cert, key } })` and logs `listening on https://…` and then `Certificate pin: sha256/…`. Plain mode is unchanged.
- `HELP` lists the new options and replaces "Serve it behind a reverse proxy that terminates TLS." with: `Without --tls or --domain it speaks plain HTTP, for a reverse proxy that terminates TLS. With --domain you agree to the ACME CA's terms of service.`

- [ ] **Step 1: Write the failing tests:**
  - In `server.test.ts`: `parseArgs` cases for each flag and env twin, the 443 default with `--domain`, and the three errors.
  - In `tls.test.ts`, in a temp directory: `creates a key once, mode 0600` (a second `loadSelfSigned` gives the same pin and the key file's mode is `0o600`); `new names reissue with the same key` (the second call with an extra name has a new certificate with that name and the same pin); `an existing key is never replaced` (a key file written before the first call is the one used).
  - In `server.test.ts`: `GET /v1/certificate` returns the certificate when `certificate` gives one, and 404 `not_found` without it.
- [ ] **Step 2: Run** `bun test packages/server`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the behaviour above.
- [ ] **Step 4: Run** `bun test packages/server` and `bun run typecheck`, then start it by hand: `bun packages/server/src/index.ts --db $TMPDIR/s.db --tls self --listen 127.0.0.1:18787`, and `curl -sk https://127.0.0.1:18787/v1/health` prints the health JSON. Stop it and delete the files.
- [ ] **Step 5: Commit** with the message `feat(server): serve HTTPS with a certificate devices pin`.

### Task 3: The client checks the pin

**Files:**
- Modify: `packages/cli/src/sync/http.ts`
- Test: `packages/cli/test/sync-pin.test.ts`

**Interfaces:**
- Consumes: `pinOfCertificate`, `formatPin` from `server/src/pin.ts`; `selfSignedCertificate`, `toPem` from `server/src/x509.ts` (tests only).
- Produces:
  - `ClientOptions.pin?: Buffer | null`, and `pairingClient(server: string, fetchImpl?: Fetch, pin?: Buffer | null)`.
  - `SyncHttpError` code `pin_mismatch`.
  - `pinnedFetch(server: string, pin: Buffer, base?: PinnedFetchBase): Fetch`, where `type PinnedFetchBase = (request: Request, init: { tls: Record<string, unknown> }) => Promise<Response>` defaults to Bun's `fetch(request, init)`.

Behaviour to implement:
- `pinnedFetch` keeps the certificate in a closure. Before the first request, it fetches `<server>/v1/certificate` with `redirect: "manual"`, `tls: { rejectUnauthorized: false }` and the request timeout. A redirect, a non-200 status, a body that isn't the expected JSON or over 16 KiB, or a certificate that doesn't parse is `SyncHttpError(0, "unreachable", …)`. A certificate whose `pinOfCertificate` differs from the pin is `SyncHttpError(0, "pin_mismatch", PIN_MISMATCH(server))`.
- Every request then goes out with `tls: { ca: <pem>, checkServerIdentity: (_host, cert) => { if (!pinOfCertificate(cert.raw).equals(pin)) throw new Error("pin mismatch") } }`. The hostname check is skipped on purpose: the key is what is pinned.
- When a request fails with a TLS verification error (the server reissued its certificate since this process fetched it), `pinnedFetch` fetches the certificate once more. If its pin still matches and it differs from the one held, it retries the request once with it; otherwise the request fails as `pin_mismatch` or with the original error.
- `send` maps an error thrown by `checkServerIdentity` to `pin_mismatch` and never retries a `pin_mismatch`.
- `syncClient` and `pairingClient` wrap their fetch in `pinnedFetch` when given a pin. An injected test `fetch` is wrapped too, through the `base` parameter.
- `PIN_MISMATCH(server)` is `` `${server} presented a key this device does not trust, so nothing was sent. If the server lost its data and started again, run ${cliName()} sync off, then set sync up again. Otherwise, something between you and the server is answering in its place.` ``

- [ ] **Step 1: Write the failing tests** in `sync-pin.test.ts`. Each starts a real `Bun.serve` with TLS in front of `createApp` (an in-memory database), using a certificate from Task 1, and stops it afterwards:
  - `a matching pin connects`: `syncClient({ …, pin })` creates a vault (`createVault`) and `devices()` lists it.
  - `a different key fails and is never retried without the pin`: with a recording `base`, the pin of another key gives `pin_mismatch` on the first call, and every recorded request after the certificate request carried `tls.ca` (none went out without it).
  - `a reissued certificate with the same key still connects`: after a successful call, restart the listener on the same port with a certificate from the same key and new names; the next call succeeds, and the certificate was fetched twice.
  - `no redirect is followed`: a server that answers `/v1/certificate` with 302 to the real certificate gives `unreachable` and the redirect target is never requested; a sync route that answers 302 gives code `redirect`.
  - `the certificate request goes through HTTPS_PROXY`: with `HTTPS_PROXY` set to a local recording proxy (a `Bun.serve` that records `CONNECT` and refuses it), the pinned client's first call fails and the proxy saw `CONNECT 127.0.0.1:<port>`. Restore the variable afterwards.
  - `an unpinned client sends no tls options`: with a recording `base` substituted for the default fetch, a client without a pin never passes `tls`.
- [ ] **Step 2: Run** `bun test packages/cli/test/sync-pin.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the behaviour above.
- [ ] **Step 4: Run** the file, `bun test packages/cli/test/sync.test.ts` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(sync): check a pinned server's key on every request`.

### Task 4: Pins in setup, pairing, status and off

**Files:**
- Modify: `packages/cli/src/sync/state.ts` (`SYNC_META.pin`, `SyncConfig.pin`, `loadSync`, `writeSync`)
- Modify: `packages/cli/src/commands/sync.ts` (`USAGE`, `setup`, `clientFor`, `addDevice`, `join`, `status`, `off`, `explain`)
- Modify: `packages/cli/src/commands/uninstall.ts` only if it builds a client without `clientFor`
- Test: `packages/cli/test/sync.test.ts`

**Interfaces:**
- Consumes: Task 3's `ClientOptions.pin`, `pairingClient(…, pin)`, `pin_mismatch`; `parsePin`, `formatPin`; #108's `encodeJoinValue` and `JoinValue.pin`.
- Produces: `SyncConfig.pin: Buffer | null`, stored as `SYNC_META.pin = "sync_pin"` in `formatPin` form. A config without the row loads with `pin: null`.

Behaviour to implement:
- **`setup <url> --pin <pin>`.** `USAGE` line: `` `  ${cliName()} sync setup <url> [--pin <pin>] [--yes]` ``. A bad pin fails before any request with `` That is not a certificate pin. It looks like sha256/ followed by 43 letters, digits, - and _, as kerstel-server prints when it starts. `` and returns 2. A pin with an `http://` URL fails with `A pinned server must use an https:// URL.` and returns 2. With a pin, the summary gains `  Certificate  pinned (sha256/…)`.
- **`clientFor`** passes `config.pin`.
- **`addDevice`** writes `pin: sync.config.pin` into the join value.
- **`join`** drops #108's "pins its certificate" refusal. It passes the value's pin to `pairingClient` and `syncClient` and saves it in the config. The old `<url> <code>` form has no pin.
- **`status`** prints `Certificate   pinned (sha256/…)` after `Server` when there is a pin.
- **`off`.** When leaving fails with `pin_mismatch`, it turns sync off here anyway (`forgetSync`, timer removed) and says: `` The server no longer has the key this device pinned, so this device could not remove itself from the vault there. Sync is off here; your secrets stay here. To sync again, run ${cliName()} sync setup and pair your other devices again. `` It returns 0. `--delete-vault` behaves the same way.
- **`explain`** returns the error's own message for `pin_mismatch`.

- [ ] **Step 1: Write the failing tests** in `sync.test.ts`. They run against the TLS listener helper from Task 3's test file (move it to `packages/cli/test/helpers/tls-server.ts` so both files share it):
  - `setup with a pin syncs and saves the pin`: `["setup", url, "--pin", formatPin(pin), "--yes"]` returns 0, `loadSync(...).pin` equals the pin, and `status` shows `pinned (sha256/`.
  - `setup refuses a bad pin before any request`: each of `nope`, the pin without `sha256/`, and a valid pin with an `http://127.0.0.1` URL returns 2 with no request recorded.
  - `pairing carries the pin`: `add-device` on a pinned device prints a value whose `parseJoinValue(...).pin` equals the pin, and `join` with it returns 0 with the pin saved.
  - `sync off works when the pin no longer matches`: on a pinned device, restart the listener with another key; `sync off` returns 0, prints `could not remove itself`, sync is off, and the timer's `remove()` was called.
  - `a pin mismatch in a sync says what to do`: `ks sync` on that device returns 1 and prints `presented a key this device does not trust`.
- [ ] **Step 2: Run** `bun test packages/cli/test/sync.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the behaviour above.
- [ ] **Step 4: Run** `bun test packages/cli`, then `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(sync): set up and pair with a pinned server`.

### Task 5: The ACME client

**Files:**
- Create: `packages/server/src/acme.ts`
- Create: `packages/server/test/helpers/fake-acme.ts`
- Test: `packages/server/test/acme.test.ts`

**Interfaces:**
- Consumes: Task 1's `certificateRequest`.
- Produces:
  - `interface AcmeDeps { fetch: (request: Request) => Promise<Response>; sleep: (ms: number) => Promise<void> }`
  - `class AcmeError extends Error { constructor(message: string, readonly problem: { type?: string; detail?: string } | null) }`
  - `obtainCertificate(o: { directory: string; domain: string; email: string | null; accountKey: KeyObject; certKey: KeyObject; challenges: Map<string, string>; deps?: Partial<AcmeDeps> }): Promise<string>`. Returns the PEM chain. It sets `challenges.get(token)` to the key authorization while the CA validates and deletes it afterwards.
  - `acmeAdvice(error: AcmeError, domain: string, httpPort: number): string`, one line of what to fix.

Behaviour to implement (RFC 8555):
- Directory, then `newNonce` (HEAD). Every POST is JWS with `alg: "ES256"`, a P-1363 signature (`crypto.sign("sha256", data, { key, dsaEncoding: "ieee-p1363" })`), `jwk` for `newAccount` and `kid` after. A `badNonce` error is retried once with the nonce it returned.
- `newAccount` with `termsOfServiceAgreed: true` and `contact: ["mailto:<email>"]` when given. `newOrder` for the one DNS identifier. For each authorization, the `http-01` challenge: key authorization `token + "." + base64url(SHA-256 of the account JWK's canonical JSON {crv,kty,x,y})`, then POST `{}` to the challenge and poll the authorization (POST-as-GET) every 2 s for up to 2 minutes. Then finalize with the CSR, poll the order until `valid`, and download the certificate.
- Any `invalid` status or problem document throws `AcmeError` with the problem.
- `acmeAdvice`: a problem type ending `:connection` or `:unauthorized` gives `` Let's Encrypt could not fetch http://<domain>/.well-known/acme-challenge/ from this host. Check that port <httpPort> is open to the internet and reaches kerstel-server. ``; one ending `:dns` gives `` <domain> does not resolve. Point an A or AAAA record at this host. ``; `:rateLimited` gives `` The CA is rate limiting this domain. kerstel-server tries again in an hour. ``; anything else gives the problem's `detail`.
- `fake-acme.ts` is a test CA: an in-process `Bun.serve` that implements exactly that subset, checks every JWS signature against the account key, fetches `http://127.0.0.1:<challengePort>/.well-known/acme-challenge/<token>` itself, and issues a certificate for the CSR's key with its own CA key (built with Task 1's code). It reads the SPKI out of the CSR with a minimal DER reader kept in the helper, and issues with `issueCertificate` under a CA certificate made with `ca: true`. It can be told to fail validation with a given problem type.

- [ ] **Step 1: Write the failing tests** in `acme.test.ts`, each with a fake CA and a challenge listener that serves `challenges`:
  - `obtains a certificate`: the returned PEM's first certificate has SAN `DNS:sync.test` and its public key equals the cert key's, and `challenges` is empty afterwards.
  - `every request is signed`: the fake CA rejects a bad signature, and the run succeeds, so every POST verified. Count newAccount once.
  - `a badNonce is retried once`: the fake CA answers the first `newOrder` with `badNonce`; the run succeeds.
  - `a failed order says which port or record to fix`: with the fake CA failing validation as `urn:ietf:params:acme:error:connection`, `obtainCertificate` throws `AcmeError` and `acmeAdvice` names `port 80`; as `:dns`, it names the A or AAAA record.
- [ ] **Step 2: Run** `bun test packages/server/test/acme.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `acme.ts` and `fake-acme.ts`.
- [ ] **Step 4: Run** the file and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(server): get a certificate over ACME`.

### Task 6: `kerstel-server --domain`

**Files:**
- Modify: `packages/server/src/tls.ts`, `packages/server/src/index.ts` (`main`)
- Modify: `.github/workflows/ci.yml` (an `acme` job)
- Test: `packages/server/test/tls.test.ts`, `packages/server/test/acme-pebble.test.ts`

**Interfaces:**
- Consumes: Task 5; Task 2's config and files.
- Produces: `class AcmeManager { constructor(o: { db: string; domain: string; directory: string; email: string | null; deps?: Partial<AcmeDeps & { now: () => number; log: (line: string) => void }> }); challenges: Map<string, string>; current(): { certPem: string; keyPem: string; certDer: Buffer } | null; ensure(): Promise<"issued" | "renewed" | "current" | "failed"> }`. It keeps the account key and certificate key in `tlsFiles(db)` (`0600`), reuses them, and renews when fewer than 30 days remain.

Behaviour to implement:
- `main` with `--domain`: start the challenge listener on `--acme-http` first (it answers `/.well-known/acme-challenge/<token>` from `challenges` and 404 for anything else), then `ensure()`. When a certificate exists, serve HTTPS with it. When `ensure()` fails and no certificate exists yet, log the `acmeAdvice` line and `No certificate yet. Trying again in an hour.`, and try again an hour later. Every 12 hours, `ensure()` again; on `"renewed"`, stop the HTTPS listener and start it again on the same address with the new certificate.
- The `acme` CI job runs on `ubuntu-latest`: it starts Pebble from a pinned image tag (check the tag exists with `docker manifest inspect` before writing it in) with `PEBBLE_VA_ALWAYS_VALID=1` on port 14000, and runs `bun test packages/server/test/acme-pebble.test.ts` with `KERSTEL_TEST_PEBBLE_DIRECTORY=https://localhost:14000/dir`. The Pebble test is `test.skipIf(!process.env.KERSTEL_TEST_PEBBLE_DIRECTORY)` and talks to Pebble's self-signed API through an injected `fetch` with `tls: { rejectUnauthorized: false }`, test only.

- [ ] **Step 1: Write the failing tests:**
  - In `tls.test.ts`, with the fake CA and a fake clock: `issues, then keeps a current certificate` (`ensure()` gives `"issued"`, then `"current"`; the key files are `0600`); `renews under 30 days` (advance the clock to 29 days before expiry; `"renewed"`, and the certificate key is reused); `a failed order is retried no sooner than an hour` (with the fake CA failing, `ensure()` gives `"failed"` and logs the advice line; a second `ensure()` within the hour makes no request).
  - `acme-pebble.test.ts`: `Pebble issues a certificate` for `sync.test`.
- [ ] **Step 2: Run** `bun test packages/server`. Expected: the new tests FAIL (the Pebble test skips locally).
- [ ] **Step 3: Implement** `AcmeManager`, the `main` wiring and the CI job.
- [ ] **Step 4: Run** `bun test packages/server` and `bun run typecheck`. If Docker is available locally, run Pebble as the CI job does and run the Pebble test once. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(server): serve HTTPS with a Let's Encrypt certificate`.

### Task 7: Copy, specs, changelog and roadmap

**Files:**
- Modify: `packages/server/README.md` (options table, TLS modes, Tailscale, behind your own proxy)
- Modify: `apps/website/src/pages/docs/sync.md` ("Run a server" and "Turn it on")
- Modify: `apps/website/src/pages/docs/cli.md` (`sync setup`, `sync status`, `sync off` rows)
- Modify: `README.md` (the sync lines, if they mention a proxy or `setup`)
- Modify: `docs/superpowers/specs/2026-11-08-sync-between-devices-design.md` §7.1 and §9.1
- Modify: `CHANGELOG.md`, `ROADMAP.md` (tick #112)
- Regenerate: `docs/` with `bun run --cwd apps/website build`

- [ ] **Step 1: Rewrite "Run a server" in `sync.md`** around three ways to reach it: its own certificate, pinned (`--tls self`, `--tls-name`, the pin it prints, `ks sync setup https://<address>:8787 --pin sha256/…`); your domain with Let's Encrypt (`--domain`, ports 80 and 443, DNS); Tailscale (`kerstel-server --listen 127.0.0.1:8787`, then `tailscale serve --bg 8787`, HTTPS certificates enabled for the tailnet, every device on the tailnet). The Caddy example moves to a "Behind your own proxy" subsection. Show the Docker form of each with the ports it needs. Say the pin travels inside the join value, so other devices never type it.
- [ ] **Step 2: Update `packages/server/README.md`** to match, with every new flag and environment variable in the options table, and `GET /v1/certificate`.
- [ ] **Step 3: Update `cli.md` and `README.md`:** `sync setup <url> [--pin <pin>] [--yes]`, the `Certificate` status line, and `sync off` on a changed key. Check each line against Task 4's source.
- [ ] **Step 4: Update the sync spec.** §7.1: a pinned `https://` server meets the rule, the client checks the key on every request, and a mismatch is never retried without the pin. §9.1: replace "TLS is left to a reverse proxy" with the three modes, the files beside the database, and `GET /v1/certificate`.
- [ ] **Step 5: Add `CHANGELOG.md` lines** in the top unreleased section, under Added:
  - ``kerstel-server serves HTTPS itself. `--tls self` makes a certificate that your devices pin, so a server at home or on a VPS needs no domain and no proxy; it prints the pin when it starts. `--domain` gets and renews a Let's Encrypt certificate. A plain HTTP server behind your own proxy works as before. See [Sync](https://kerstel.dev/docs/sync).``
  - ``kerstel sync setup <url> --pin sha256/… syncs with a server that pins its certificate. The pin travels in the join value, so other devices pair as before, and every request checks the server's key. If the key changes, nothing is sent, and `kerstel sync off` still turns sync off on that device.``
- [ ] **Step 6: Tick the #112 line** in `ROADMAP.md`.
- [ ] **Step 7: Run** `bun run --cwd apps/website build`, then `bun run test` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 8: Commit** with the message `docs(sync): HTTPS without a proxy`.
