import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, type KeyObject } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "../../server/src/protocol";
import { generateDeviceKeys, generateSyncKey, publicKeyOf, sealSyncKey } from "../src/sync/crypto";
import { PIN_MISMATCH, PIN_NEEDS_HTTPS, SyncHttpError, pairingClient, pinnedFetch, syncClient, type Fetch } from "../src/sync/http";
import { serverKey, startTlsServer, type TlsServer } from "./helpers/tls-server";
import { pinOfCertificate } from "../../server/src/pin";
import { issueCertificate, selfSignedCertificate, toPem } from "../../server/src/x509";
import { createPublicKey } from "node:crypto";

/** #112: a pinned client trusts the server's own key and nothing else. */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function start(...args: Parameters<typeof startTlsServer>): TlsServer {
  const server = startTlsServer(...args);
  cleanups.push(() => server.stop());
  return server;
}

/** A new device and a vault for it: what `sync setup` creates. */
function newDevice(server: string | string[], extra: { pin?: Buffer | null; fetch?: Fetch } = {}) {
  const vaultId = newId();
  const deviceId = newId();
  const keys = generateDeviceKeys();
  const servers = typeof server === "string" ? [server] : server;
  const client = syncClient({ servers, vaultId, deviceId, sign: keys.sign, ...extra });
  const createVault = () =>
    client.createVault(
      {
        vaultId,
        device: {
          id: deviceId,
          signPub: publicKeyOf(keys.sign),
          encPub: publicKeyOf(keys.enc),
          sealedName: randomBytes(40).toString("base64url"),
        },
        sealedKey: sealSyncKey(generateSyncKey(), publicKeyOf(keys.enc), { vaultId, deviceId, epoch: 1 }),
      },
      null,
    );
  return { client, deviceId, createVault };
}

interface Recorded {
  url: string;
  tls: Record<string, unknown> | undefined;
}

/**
 * Bun's own fetch, recording what each call asked for. It fits both a client's
 * `fetch` option (which a pin wraps, through `base`) and `pinnedFetch`'s `base`.
 */
function recordingBase(): { base: Fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const base: Fetch = (request, init) => {
    calls.push({ url: request.url, tls: init?.tls });
    return fetch(request, init as RequestInit);
  };
  return { base, calls };
}

const spkiOf = (key: KeyObject) => createPublicKey(key).export({ type: "spki", format: "der" });

/** A certificate authority for tests, standing in for Let's Encrypt: `kerstel-server --domain`. */
function testAuthority() {
  const key = serverKey();
  const certDer = issueCertificate({ subjectSpki: spkiOf(key), issuerKey: key, issuerName: "Test CA", subjectName: "Test CA", names: [], ca: true });
  return {
    pem: toPem(certDer, "CERTIFICATE"),
    /** A leaf for `subject`'s key, as the CA issues it for a domain. */
    issue: (subject: KeyObject, names: string[]) =>
      issueCertificate({ subjectSpki: spkiOf(subject), issuerKey: key, issuerName: "Test CA", subjectName: "leaf", names }),
  };
}

/**
 * `recordingBase`, on a machine that trusts `authority`: a request sent
 * without `ca` (the normal roots) trusts the test CA too. It records what the
 * client asked for, before the CA is added.
 */
function trustingBase(authority: { pem: string }): { base: Fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const base: Fetch = (request, init) => {
    calls.push({ url: request.url, tls: init?.tls });
    const tls = init?.tls;
    const roots = tls && tls.ca === undefined && tls.rejectUnauthorized !== false ? { ...tls, ca: authority.pem } : tls;
    return fetch(request, { ...init, tls: roots } as RequestInit);
  };
  return { base, calls };
}

async function failure(work: Promise<unknown>): Promise<SyncHttpError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(SyncHttpError);
    return error as SyncHttpError;
  }
  throw new Error("expected the call to fail");
}

describe("a pinned client", () => {
  test("a matching pin connects", async () => {
    const server = start();
    const device = newDevice(server.url, { pin: server.pin });
    await device.createVault();
    const { devices } = await device.client.devices();
    expect(devices.map((d) => d.id)).toEqual([device.deviceId]);
  });

  test("a different key fails and is never retried without the pin", async () => {
    const server = start();
    const { base, calls } = recordingBase();
    const device = newDevice(server.url, { pin: pinOfCertificate(selfSignedCertificate({ key: serverKey(), names: ["localhost"] })), fetch: base });
    const error = await failure(device.createVault());
    expect(error.code).toBe("pin_mismatch");
    expect(error.message).toBe(PIN_MISMATCH(server.url));
    // The certificate's key is refused before any request is sent.
    expect(calls.map((c) => c.url)).toEqual([`${server.url}/v1/certificate`]);
    expect(server.paths).toEqual(["/v1/certificate"]);
  });

  test("a server that serves the pinned certificate but presents another key is a key mismatch", async () => {
    // Someone in the middle can copy the real certificate, but not its key.
    const real = startTlsServer();
    const pinned = { cert: real.certDer, pin: real.pin };
    real.stop();
    const server = start({ advertise: () => pinned.cert });
    const { base, calls } = recordingBase();
    const device = newDevice(server.url, { pin: pinned.pin, fetch: base });
    const error = await failure(device.createVault());
    expect(error.code).toBe("pin_mismatch");
    expect(error.message).toBe(PIN_MISMATCH(server.url));
    // The certificate, the refused request, the certificate once more, and no retry.
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/certificate", "/v1/vaults", "/v1/certificate"]);
    expect(calls.filter((c) => c.url.endsWith("/v1/certificate")).every((c) => c.tls?.rejectUnauthorized === false)).toBe(true);
    for (const call of calls.filter((c) => !c.url.endsWith("/v1/certificate"))) expect(call.tls?.ca).toBeDefined();
    expect(server.paths).not.toContain("/v1/vaults");
  });

  test("a retry that still fails verification is a key mismatch", async () => {
    // The server says it reissued its certificate, with the pinned key, but
    // its TLS layer presents another key both times.
    const pinnedKey = serverKey();
    const advertised = [
      selfSignedCertificate({ key: pinnedKey, names: ["localhost"] }),
      selfSignedCertificate({ key: pinnedKey, names: ["localhost", "homebox.local"] }),
    ];
    let n = 0;
    const server = start({ advertise: () => advertised[Math.min(n++, 1)]! });
    const { base, calls } = recordingBase();
    const device = newDevice(server.url, { pin: pinOfCertificate(advertised[0]!), fetch: base });
    const error = await failure(device.createVault());
    expect(error.code).toBe("pin_mismatch");
    expect(error.message).toBe(PIN_MISMATCH(server.url));
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/certificate", "/v1/vaults", "/v1/certificate", "/v1/vaults"]);
    for (const call of calls.filter((c) => !c.url.endsWith("/v1/certificate"))) expect(call.tls?.ca).toBeDefined();
    expect(server.paths).not.toContain("/v1/vaults");
  });

  test("a certificate a CA issued for the pinned key connects, checked against the normal roots", async () => {
    // A server that moved from --tls self to --domain keeps its key, and so its pin.
    const authority = testAuthority();
    const server = start({ issue: authority.issue });
    const { base, calls } = trustingBase(authority);
    const device = newDevice(server.url, { pin: server.pin, fetch: base });
    await device.createVault();
    expect((await device.client.devices()).devices).toHaveLength(1);
    expect(calls.map((c) => new URL(c.url).pathname.split("/").pop())).toEqual(["certificate", "vaults", "devices"]);
    for (const call of calls.filter((c) => !c.url.endsWith("/v1/certificate"))) {
      // No `ca`: the normal roots decide, then the key is checked.
      expect(call.tls?.ca).toBeUndefined();
      expect(typeof call.tls?.checkServerIdentity).toBe("function");
    }
  });

  test("a CA-issued certificate for another key is a key mismatch", async () => {
    const authority = testAuthority();
    const pinnedKey = serverKey();
    const pin = pinOfCertificate(authority.issue(pinnedKey, ["localhost"]));

    // The server advertises a certificate for another key.
    const moved = start({ issue: authority.issue });
    const first = await failure(newDevice(moved.url, { pin, fetch: trustingBase(authority).base }).createVault());
    expect(first.code).toBe("pin_mismatch");
    expect(moved.paths).toEqual(["/v1/certificate"]);

    // Someone in the middle with a valid certificate of its own copies the pinned one.
    const copied = authority.issue(pinnedKey, ["localhost", "127.0.0.1"]);
    const server = start({ issue: authority.issue, advertise: () => copied });
    const { base, calls } = trustingBase(authority);
    const error = await failure(newDevice(server.url, { pin, fetch: base }).createVault());
    expect(error.code).toBe("pin_mismatch");
    expect(error.message).toBe(PIN_MISMATCH(server.url));
    // The key check threw: never retried.
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/certificate", "/v1/vaults"]);
    expect(calls[1]!.tls?.ca).toBeUndefined();
    expect(server.paths).toEqual(["/v1/certificate"]);
  });

  test("a server that moves from its own certificate to a CA's, with the same key, still connects", async () => {
    const authority = testAuthority();
    const server = start();
    const { base, calls } = trustingBase(authority);
    const device = newDevice(server.url, { pin: server.pin, fetch: base });
    await device.createVault();
    server.restart({ names: ["localhost", "127.0.0.1"], issue: authority.issue });
    expect((await device.client.devices()).devices).toHaveLength(1);
    // The held certificate failed, the new one was fetched, and the retry used the normal roots.
    const after = calls.slice(2);
    expect(after.map((c) => new URL(c.url).pathname.split("/").pop())).toEqual(["devices", "certificate", "devices"]);
    expect(after[0]!.tls?.ca).toBeDefined();
    expect(after[2]!.tls?.ca).toBeUndefined();
  });

  test("without ca, Bun checks the normal roots and then the pin", async () => {
    // A child process, so the test CA is among the normal roots
    // (NODE_EXTRA_CA_CERTS) and nothing in the request carries a `ca`.
    const authority = testAuthority();
    const dir = mkdtempSync(join(tmpdir(), "kerstel-pin-ca-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "ca.pem"), authority.pem);
    const pinnedKey = serverKey();
    const good = start({ key: pinnedKey, issue: authority.issue });
    const copied = authority.issue(pinnedKey, ["localhost"]);
    const middle = start({ issue: authority.issue, advertise: () => copied });

    const http = join(import.meta.dir, "../src/sync/http.ts");
    const script = `
      import { pinnedFetch } from ${JSON.stringify(http)};
      const [server, pin] = process.argv.slice(1);
      try {
        await pinnedFetch(server, Buffer.from(pin, "base64url"))(new Request(server + "/v1/health"));
        console.log("connected");
      } catch (error) {
        console.log(error.message === "pin mismatch" ? "pin_mismatch" : error.code ?? error.message);
      }`;
    const run = async (url: string) => {
      const child = Bun.spawn([process.execPath, "-e", script, url, good.pin.toString("base64url")], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: join(dir, "ca.pem") },
        stdout: "pipe",
        stderr: "pipe",
      });
      cleanups.push(() => child.kill());
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (out.trim() === "") throw new Error(`the client printed nothing; its stderr:\n${err}`);
      return out.trim();
    };
    expect(await run(good.url)).toBe("connected");
    expect(good.paths).toEqual(["/v1/certificate", "/v1/health"]);
    expect(await run(middle.url)).toBe("pin_mismatch");
    expect(middle.paths).toEqual(["/v1/certificate"]);
  });

  test("a pinned server must use https", () => {
    const pin = pinOfCertificate(selfSignedCertificate({ key: serverKey(), names: ["localhost"] }));
    for (const make of [
      () => pinnedFetch("http://127.0.0.1:8787", pin),
      () => newDevice("http://127.0.0.1:8787", { pin }),
      () => pairingClient(["http://127.0.0.1:8787"], undefined, pin),
      () => newDevice(["https://127.0.0.1:8787", "http://127.0.0.1:8787"], { pin }),
    ]) {
      let thrown: unknown;
      try {
        make();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SyncHttpError);
      expect((thrown as SyncHttpError).code).toBe("bad_request");
      expect((thrown as SyncHttpError).message).toBe(PIN_NEEDS_HTTPS);
    }
  });

  test("the pairing client checks the pin too", async () => {
    const server = start();
    const { base, calls } = recordingBase();
    const other = pinOfCertificate(selfSignedCertificate({ key: serverKey(), names: ["localhost"] }));
    expect((await failure(pairingClient([server.url], base, other).state(newId()))).code).toBe("pin_mismatch");
    expect(calls).toHaveLength(1);
    // With the right pin it reaches the server: an unknown pairing is the server's own 404.
    expect((await failure(pairingClient([server.url], base, server.pin).state(newId()))).status).toBe(404);
  });

  test("a pin mismatch never moves on", async () => {
    const pinned = start();
    // Another key answers at the first address: something in the server's place.
    const impostor = start();
    const { base, calls } = recordingBase();
    const device = newDevice([impostor.url, pinned.url], { pin: pinned.pin, fetch: base });
    const error = await failure(device.createVault());
    expect(error.code).toBe("pin_mismatch");
    expect(error.message).toBe(PIN_MISMATCH(impostor.url));
    expect(calls.map((c) => c.url)).toEqual([`${impostor.url}/v1/certificate`]);
    expect(pinned.paths).toEqual([]);
    expect(device.client.address()).toBe(impostor.url);
    // Nor on the next request: the address that answered is the one used.
    expect((await failure(device.client.devices())).code).toBe("pin_mismatch");
    expect(pinned.paths).toEqual([]);
  });

  test("a pinned address that can't be reached moves on to the next", async () => {
    const pinned = start();
    const down = "https://127.0.0.1:1";
    const { base, calls } = recordingBase();
    const device = newDevice([down, pinned.url], { pin: pinned.pin, fetch: base });
    expect(device.client.address()).toBeNull();
    await device.createVault();
    expect(device.client.address()).toBe(pinned.url);
    expect(calls[0]!.url).toBe(`${down}/v1/certificate`);
    expect(pinned.paths).toEqual(["/v1/certificate", "/v1/vaults"]);
  });

  test("a certificate the pinned key issued for another key is refused", async () => {
    // Only the key is trusted: a chain that verifies against the held
    // certificate still fails when the server's own key is not the pinned one.
    const authority = serverKey();
    const authorityCert = issueCertificate({ subjectSpki: createPublicKey(authority).export({ type: "spki", format: "der" }), issuerKey: authority, names: [], ca: true });
    const server = start({
      issue: (key, names) =>
        issueCertificate({ subjectSpki: createPublicKey(key).export({ type: "spki", format: "der" }), issuerKey: authority, subjectName: "leaf", names }),
      advertise: () => authorityCert,
    });
    const { base, calls } = recordingBase();
    const device = newDevice(server.url, { pin: pinOfCertificate(authorityCert), fetch: base });
    const error = await failure(device.createVault());
    expect(error.code).toBe("pin_mismatch");
    expect(error.message).toBe(PIN_MISMATCH(server.url));
    // Never retried: one certificate request, one refused request.
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/certificate", "/v1/vaults"]);
    expect(server.paths).toEqual(["/v1/certificate"]);
  });

  test("a reissued certificate with the same key still connects", async () => {
    const server = start();
    const { base, calls } = recordingBase();
    const device = newDevice(server.url, { pin: server.pin, fetch: base });
    await device.createVault();
    const before = server.certDer;
    server.restart({ names: ["localhost", "127.0.0.1", "homebox.local"] });
    expect(server.certDer.equals(before)).toBe(false);
    const { devices } = await device.client.devices();
    expect(devices).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith("/v1/certificate"))).toHaveLength(2);
  });

  test("no redirect is followed", async () => {
    const target = start();
    const redirecting = start({
      intercept: (request) =>
        new URL(request.url).pathname === "/v1/certificate"
          ? Response.redirect(`${target.url}/v1/certificate`, 302)
          : undefined,
    });
    const first = await failure(newDevice(redirecting.url, { pin: target.pin }).createVault());
    expect(first.code).toBe("unreachable");
    expect(target.paths).toEqual([]);

    const syncRedirect = start({
      intercept: (request) => (new URL(request.url).pathname === "/v1/vaults" ? Response.redirect(`${target.url}/v1/vaults`, 302) : undefined),
    });
    const second = await failure(newDevice(syncRedirect.url, { pin: syncRedirect.pin }).createVault());
    expect(second.code).toBe("redirect");
    expect(target.paths).toEqual([]);
  });

  test("the certificate request goes through HTTPS_PROXY", async () => {
    const server = start();
    const seen: string[] = [];
    const proxy = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          seen.push(data.toString("latin1").split("\r\n")[0]!);
          socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        },
      },
    });
    cleanups.push(() => proxy.stop(true));

    // The client runs in a child process. Bun 1.4.2 keeps using a proxy after
    // `delete process.env.HTTPS_PROXY`, so setting it here would send every
    // later test file in this process through a closed proxy.
    const env: Record<string, string | undefined> = { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
    delete env.NO_PROXY;
    delete env.no_proxy;
    const http = join(import.meta.dir, "../src/sync/http.ts");
    const script = `
      import { pinnedFetch } from ${JSON.stringify(http)};
      const [server, pin] = process.argv.slice(1);
      try {
        await pinnedFetch(server, Buffer.from(pin, "base64url"))(new Request(server + "/v1/health"));
        console.log("connected");
      } catch (error) {
        console.log(error.code);
      }`;
    const child = Bun.spawn([process.execPath, "-e", script, server.url, server.pin.toString("base64url")], { env, stdout: "pipe", stderr: "pipe" });
    cleanups.push(() => child.kill());
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

    if (out.trim() === "") throw new Error(`the client printed nothing; its stderr:\n${err}`);
    expect(out.trim()).toBe("unreachable");
    expect(seen[0]).toStartWith(`CONNECT 127.0.0.1:${server.port} `);
    expect(server.paths).toEqual([]);
  });
});

describe("an unpinned client", () => {
  test("sends no tls options", async () => {
    const server = start();
    const inits: unknown[] = [];
    // Stands in for the default fetch; a pinned client would call it with an init carrying `tls`.
    const recording: Fetch = (request, init) => {
      inits.push(init);
      return server.app.fetch(request, "127.0.0.1");
    };
    const device = newDevice(server.url, { fetch: recording });
    await device.createVault();
    await device.client.devices();
    expect(inits).toHaveLength(2);
    expect(inits.every((init) => init === undefined)).toBe(true);
  });

  test("keeps the code a self-signed certificate failed with", async () => {
    const server = start();
    const error = await failure(newDevice(server.url).createVault());
    expect(error.code).toBe("unreachable");
    expect(error.tlsCode).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
  });
});

describe("pinnedFetch", () => {
  test("fetches the certificate once per process", async () => {
    const server = start();
    const { base, calls } = recordingBase();
    const doFetch = pinnedFetch(server.url, server.pin, base);
    for (let i = 0; i < 3; i++) expect((await doFetch(new Request(`${server.url}/v1/health`))).status).toBe(200);
    expect(calls.filter((c) => c.url.endsWith("/v1/certificate"))).toHaveLength(1);
  });
});
