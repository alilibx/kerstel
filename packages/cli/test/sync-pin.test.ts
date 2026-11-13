import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { newId } from "../../server/src/protocol";
import { generateDeviceKeys, generateSyncKey, publicKeyOf, sealSyncKey } from "../src/sync/crypto";
import { PIN_MISMATCH, SyncHttpError, pairingClient, pinnedFetch, syncClient, type Fetch, type PinnedFetchBase } from "../src/sync/http";
import { serverKey, startTlsServer, type TlsServer } from "./helpers/tls-server";
import { pinOfCertificate } from "../../server/src/pin";
import { issueCertificate, selfSignedCertificate } from "../../server/src/x509";
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
function newDevice(server: string, extra: { pin?: Buffer | null; fetch?: Fetch } = {}) {
  const vaultId = newId();
  const deviceId = newId();
  const keys = generateDeviceKeys();
  const client = syncClient({ server, vaultId, deviceId, sign: keys.sign, ...extra });
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
type Recording = (request: Request, init?: Parameters<PinnedFetchBase>[1]) => Promise<Response>;

function recordingBase(): { base: Recording; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const base: Recording = (request, init) => {
    calls.push({ url: request.url, tls: init?.tls });
    return fetch(request, init as RequestInit);
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
    expect(calls[0]!.url).toBe(`${server.url}/v1/certificate`);
    for (const call of calls.slice(1)) expect(call.tls?.ca).toBeDefined();
    expect(server.paths).not.toContain("/v1/vaults");
  });

  test("a server that advertises the pinned certificate but holds another key gets nothing", async () => {
    // Someone in the middle can copy the real certificate, but not its key.
    const real = startTlsServer();
    const pinned = { cert: real.certDer, pin: real.pin };
    real.stop();
    const server = start({ advertise: () => pinned.cert });
    const { base, calls } = recordingBase();
    const device = newDevice(server.url, { pin: pinned.pin, fetch: base });
    const error = await failure(device.createVault());
    expect(error.code).not.toBe("redirect");
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.filter((c) => c.url.endsWith("/v1/certificate")).every((c) => c.tls?.rejectUnauthorized === false)).toBe(true);
    for (const call of calls.filter((c) => !c.url.endsWith("/v1/certificate"))) expect(call.tls?.ca).toBeDefined();
    expect(server.paths).not.toContain("/v1/vaults");
  });

  test("the pairing client checks the pin too", async () => {
    const server = start();
    const { base, calls } = recordingBase();
    const other = pinOfCertificate(selfSignedCertificate({ key: serverKey(), names: ["localhost"] }));
    expect((await failure(pairingClient(server.url, base, other).state(newId()))).code).toBe("pin_mismatch");
    expect(calls).toHaveLength(1);
    // With the right pin it reaches the server: an unknown pairing is the server's own 404.
    expect((await failure(pairingClient(server.url, base, server.pin).state(newId()))).status).toBe(404);
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
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);

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
    const recording = ((request: Request, init?: unknown) => {
      inits.push(init);
      return server.app.fetch(request, "127.0.0.1");
    }) as Fetch;
    const device = newDevice(server.url, { fetch: recording });
    await device.createVault();
    await device.client.devices();
    expect(inits).toHaveLength(2);
    expect(inits.every((init) => init === undefined)).toBe(true);
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
