import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acmeAdvice, AcmeError } from "../src/acme";
import { pinnedFetch } from "../../cli/src/sync/http";
import { parsePin, pinOfCertificate } from "../src/pin";
import {
  AcmeManager,
  bindAgain,
  certificateName,
  keepCertificate,
  loadOrCreateKey,
  loadSelfSigned,
  serveChallenges,
  tlsFiles,
  type AcmeCertificate,
} from "../src/tls";
import { certificateNames } from "../src/x509";
import { startFakeAcme, type FakeAcme } from "./helpers/fake-acme";

let dir: string;
let db: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kerstel-server-tls-"));
  db = join(dir, "s.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NAMES = ["localhost", "127.0.0.1"];

describe("tlsFiles", () => {
  test("names each file beside the database", () => {
    expect(tlsFiles("/data/s.db")).toEqual({
      key: "/data/s.db.tls-key.pem",
      cert: "/data/s.db.tls-cert.pem",
      account: "/data/s.db.acme-account.pem",
    });
  });
});

describe("certificateName", () => {
  test("a malformed IPv4 address is not a DNS name", () => {
    for (const text of ["192.168.1.256", "127.1", "1.2.3.4.5", "010.0.0.1", "8080", "*.10"]) {
      expect(certificateName(text)).toBeNull();
    }
    expect(certificateName("192.168.1.20")).toBe("192.168.1.20");
    expect(certificateName("host1.example")).toBe("host1.example");
    expect(certificateName("10.example")).toBe("10.example");
    expect(certificateName("1.2.3.4.nip.io")).toBe("1.2.3.4.nip.io");
  });
});

describe("loadSelfSigned", () => {
  test("creates a key once, mode 0600", () => {
    const first = loadSelfSigned(db, NAMES);
    expect(statSync(tlsFiles(db).key).mode & 0o777).toBe(0o600);
    const second = loadSelfSigned(db, NAMES);
    expect(second.pin.equals(first.pin)).toBe(true);
    expect(second.certDer.equals(first.certDer)).toBe(true); // same names: no reissue
    expect(pinOfCertificate(first.certDer).equals(first.pin)).toBe(true);
    expect(first.certPem).toBe(readFileSync(tlsFiles(db).cert, "utf8"));
    expect(new X509Certificate(first.certPem).raw.equals(first.certDer)).toBe(true);
    // Compared without toBe, so a failure never prints a private key.
    expect(first.keyPem === readFileSync(tlsFiles(db).key, "utf8")).toBe(true);
  });

  test("new names reissue with the same key", () => {
    const first = loadSelfSigned(db, NAMES);
    const second = loadSelfSigned(db, [...NAMES, "homebox.local"]);
    expect(second.certDer.equals(first.certDer)).toBe(false);
    expect(certificateNames(second.certDer)).toContain("homebox.local");
    expect(second.pin.equals(first.pin)).toBe(true);
  });

  test("the same names in another order or spelling do not reissue", () => {
    const first = loadSelfSigned(db, [...NAMES, "::1", "2001:db8::1"]);
    const second = loadSelfSigned(db, ["2001:0db8:0:0:0:0:0:1", "0:0:0:0:0:0:0:1", "127.0.0.1", "localhost"]);
    expect(second.certDer.equals(first.certDer)).toBe(true);
  });

  test("an existing key is never replaced", () => {
    const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const keyPem = key.export({ type: "pkcs8", format: "pem" }) as string;
    writeFileSync(tlsFiles(db).key, keyPem, { mode: 0o600 });
    const loaded = loadSelfSigned(db, NAMES);
    expect(readFileSync(tlsFiles(db).key, "utf8") === keyPem).toBe(true);
    expect(loaded.keyPem === keyPem).toBe(true);
    const spki = createPublicKey(key).export({ type: "spki", format: "der" });
    expect(new X509Certificate(loaded.certDer).publicKey.export({ type: "spki", format: "der" }).equals(spki)).toBe(true);
  });

  test("an empty key file is an error that says so, and is left alone", () => {
    writeFileSync(tlsFiles(db).key, "", { mode: 0o600 });
    expect(() => loadSelfSigned(db, NAMES)).toThrow(
      `${tlsFiles(db).key} is empty. If no device has pinned this server yet, delete it and start again.`,
    );
    expect(statSync(tlsFiles(db).key).size).toBe(0);
  });

  test("leaves no temporary file behind", () => {
    loadSelfSigned(db, NAMES);
    expect(readdirSync(dir).sort()).toEqual(["s.db.tls-cert.pem", "s.db.tls-key.pem"]);
  });

  test("a certificate for another key, or one that does not parse, is reissued", () => {
    const first = loadSelfSigned(db, NAMES);
    rmSync(tlsFiles(db).key);
    const second = loadSelfSigned(db, NAMES);
    expect(second.pin.equals(first.pin)).toBe(false);
    expect(pinOfCertificate(second.certDer).equals(second.pin)).toBe(true);

    writeFileSync(tlsFiles(db).cert, "not a certificate");
    const third = loadSelfSigned(db, NAMES);
    expect(third.pin.equals(second.pin)).toBe(true);
    expect(pinOfCertificate(third.certDer).equals(third.pin)).toBe(true);
  });
});

describe("loadOrCreateKey on a filesystem without hard links", () => {
  /** A link that fails as exFAT or some NAS mounts do, after running `before`. */
  const noLinks = (code: string, before: () => void = () => {}) => () => {
    before();
    throw Object.assign(new Error(`${code}: operation not permitted, link`), { code });
  };

  test("writes the key in place, mode 0600, and leaves no temporary file", () => {
    for (const code of ["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"]) {
      const path = join(dir, `${code}.pem`);
      const pem = loadOrCreateKey(path, noLinks(code));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      // Compared without toBe, so a failure never prints a private key.
      expect(readFileSync(path, "utf8") === pem).toBe(true);
      expect(createPublicKey(pem).asymmetricKeyType).toBe("ec");
      expect(loadOrCreateKey(path, noLinks(code)) === pem).toBe(true);
    }
    expect(readdirSync(dir).sort()).toEqual(["ENOSYS.pem", "ENOTSUP.pem", "EPERM.pem", "EXDEV.pem"]);
  });

  test("uses a key another process wrote first", () => {
    const path = join(dir, "key.pem");
    const theirs = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const pem = loadOrCreateKey(path, noLinks("EPERM", () => writeFileSync(path, theirs, { mode: 0o600 })));
    expect(pem === theirs).toBe(true);
    expect(readFileSync(path, "utf8") === theirs).toBe(true);
    expect(readdirSync(dir)).toEqual(["key.pem"]);
  });

  test("any other link error is thrown", () => {
    const path = join(dir, "key.pem");
    expect(() => loadOrCreateKey(path, noLinks("EIO"))).toThrow("EIO");
    expect(readdirSync(dir)).toEqual([]);
  });
});

const DOMAIN = "sync.test";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const spki = (key: { export(o: { type: "spki"; format: "der" }): Buffer }) => key.export({ type: "spki", format: "der" });
const leafOf = (certificate: AcmeCertificate) => new X509Certificate(certificate.certDer);

describe("AcmeManager", () => {
  let ca: FakeAcme;
  let cleanup: (() => void)[];
  let manager: AcmeManager;
  let clock: number;
  let logs: string[];
  let requests: string[];

  /** A manager on `db` against the fake CA, with a fake clock, a log and a count of requests. */
  const newManager = () =>
    new AcmeManager({
      db,
      domain: DOMAIN,
      directory: ca.directory,
      email: null,
      httpPort: 80,
      deps: {
        now: () => clock,
        log: (line) => logs.push(line),
        sleep: async () => {},
        fetch: (request) => {
          requests.push(new URL(request.url).pathname);
          return fetch(request);
        },
      },
    });

  const start = (o: { validityMs?: number } = {}) => {
    // The listener reads whichever manager the test made last.
    const listener = serveChallenges({ challenges: { get: (token) => manager.challenges.get(token) }, hostname: "127.0.0.1", port: 0 });
    ca = startFakeAcme({ challengePort: listener.port!, ...o });
    cleanup.push(() => listener.stop(true), () => ca.stop());
    manager = newManager();
  };

  beforeEach(() => {
    clock = Date.now();
    logs = [];
    requests = [];
    cleanup = [];
  });
  afterEach(() => {
    for (const stop of cleanup) stop();
  });

  test("issues, then keeps a current certificate", async () => {
    start();
    expect(manager.current()).toBeNull();
    expect(await manager.ensure()).toBe("issued");
    const certificate = manager.current()!;
    expect(leafOf(certificate).subjectAltName).toBe(`DNS:${DOMAIN}`);
    expect(leafOf(certificate).verify(new X509Certificate(ca.caPem).publicKey)).toBe(true);
    expect(ca.validated).toBe(1); // the fake CA fetched the key authorization from the listener
    const files = tlsFiles(db);
    expect(statSync(files.key).mode & 0o777).toBe(0o600);
    expect(statSync(files.account).mode & 0o777).toBe(0o600);
    expect(readFileSync(files.cert, "utf8")).toBe(certificate.certPem);
    // Compared without toBe, so a failure never prints a private key.
    expect(certificate.keyPem === readFileSync(files.key, "utf8")).toBe(true);
    expect(spki(leafOf(certificate).publicKey).equals(spki(createPublicKey(certificate.keyPem)))).toBe(true);

    const sent = requests.length;
    expect(await manager.ensure()).toBe("current");
    expect(requests.length).toBe(sent);

    // A restart finds the certificate beside the database and asks for nothing.
    manager = newManager();
    expect(manager.current()!.certDer.equals(certificate.certDer)).toBe(true);
    expect(await manager.ensure()).toBe("current");
    expect(requests.length).toBe(sent);
    expect(ca.counts.newOrder).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["s.db.acme-account.pem", "s.db.tls-cert.pem", "s.db.tls-key.pem"]);
  });

  test("renews under 30 days", async () => {
    start({ validityMs: 90 * DAY });
    expect(await manager.ensure()).toBe("issued");
    const first = manager.current()!;
    const notAfter = Date.parse(leafOf(first).validTo);
    const keyPem = readFileSync(tlsFiles(db).key, "utf8");

    clock = notAfter - 31 * DAY;
    expect(await manager.ensure()).toBe("current");
    expect(ca.counts.newOrder).toBe(1);

    clock = notAfter - 29 * DAY;
    expect(await manager.ensure()).toBe("renewed");
    const second = manager.current()!;
    expect(second.certDer.equals(first.certDer)).toBe(false);
    expect(spki(leafOf(second).publicKey).equals(spki(leafOf(first).publicKey))).toBe(true); // the key is reused
    expect(readFileSync(tlsFiles(db).key, "utf8") === keyPem).toBe(true);
    expect(readFileSync(tlsFiles(db).cert, "utf8")).toBe(second.certPem);
    expect(ca.accounts.length).toBe(1); // and so is the account
  });

  test("renews a short-lived certificate when under a third of its lifetime remains", async () => {
    start({ validityMs: DAY });
    expect(await manager.ensure()).toBe("issued");
    const leaf = leafOf(manager.current()!);
    const notAfter = Date.parse(leaf.validTo);
    expect(notAfter - Date.parse(leaf.validFrom)).toBe(DAY);

    clock = notAfter - 20 * HOUR;
    expect(await manager.ensure()).toBe("current");
    expect(ca.counts.newOrder).toBe(1);

    clock = notAfter - 7 * HOUR;
    expect(await manager.ensure()).toBe("renewed");
    expect(ca.counts.newOrder).toBe(2);
  });

  test("a failed order is retried no sooner than an hour", async () => {
    start();
    ca.failValidation("urn:ietf:params:acme:error:connection");
    expect(await manager.ensure()).toBe("failed");
    expect(manager.current()).toBeNull();
    const advice = acmeAdvice(new AcmeError("", { type: "urn:ietf:params:acme:error:connection" }), DOMAIN, 80);
    expect(logs).toEqual([advice]);
    expect(existsSync(tlsFiles(db).cert)).toBe(false);

    const sent = requests.length;
    clock += HOUR - 1;
    expect(await manager.ensure()).toBe("failed");
    expect(requests.length).toBe(sent);
    expect(logs.length).toBe(1);

    ca.failValidation(null);
    clock += 1;
    expect(await manager.ensure()).toBe("issued");
    expect(requests.length).toBeGreaterThan(sent);
  });

  test("any failure is logged and reported, never thrown", async () => {
    start();
    manager = new AcmeManager({
      db,
      domain: DOMAIN,
      directory: ca.directory,
      email: null,
      deps: { now: () => clock, log: (line) => logs.push(line), fetch: async () => new Response("<html>not a directory</html>") },
    });
    expect(await manager.ensure()).toBe("failed");
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("JSON");
  });

  test("a certificate for another domain, or a self-signed one, is not used", async () => {
    start();
    loadSelfSigned(db, ["localhost", DOMAIN]); // what --tls self left beside the database
    manager = newManager();
    expect(manager.current()).toBeNull();
    expect(await manager.ensure()).toBe("issued");

    const other = new AcmeManager({ db, domain: "other.test", directory: ca.directory, email: null, deps: { log: () => {} } });
    expect(other.current()).toBeNull();
  });

  test("the challenge listener answers by path, whatever the Host", async () => {
    const challenges = new Map([["tok-1", "tok-1.thumb"]]);
    const server = serveChallenges({ challenges, hostname: "127.0.0.1", port: 0 });
    try {
      const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { host: DOMAIN } });
      const answer = await get("/.well-known/acme-challenge/tok-1");
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe("tok-1.thumb");
      expect((await get("/.well-known/acme-challenge/tok-2")).status).toBe(404);
      expect((await get("/.well-known/acme-challenge/tok-1/x")).status).toBe(404);
      expect((await get("/")).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe("keepCertificate", () => {
  const certificate = (n: number): AcmeCertificate => ({ certPem: `cert ${n}`, keyPem: "key", certDer: Buffer.from([n]) });

  /** A manager that answers `ensure` from `results`, holding `held`, and timers run by hand. */
  function setup(results: ("issued" | "renewed" | "current" | "failed")[], held: AcmeCertificate | null) {
    const state = { held, ensured: 0 };
    const manager = {
      current: () => state.held,
      ensure: async () => {
        const result = results[state.ensured++]!;
        if (result === "issued" || result === "renewed") state.held = certificate(state.ensured + 1);
        return result;
      },
    };
    const served: string[] = [];
    const logs: string[] = [];
    const timers: { ms: number; run: () => void; cancelled: boolean }[] = [];
    const keeper = keepCertificate({
      manager,
      serve: (c) => served.push(c.certPem),
      log: (line) => logs.push(line),
      schedule: (run, ms) => {
        const timer = { ms, run, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });
    /** Fires the last timer and waits for its check. */
    const tick = async () => {
      timers[timers.length - 1]!.run();
      await Bun.sleep(0);
    };
    return { state, served, logs, timers, keeper, tick };
  }

  test("retries hourly until there is a certificate, then serves it and checks every 12 hours", async () => {
    const t = setup(["failed", "failed", "issued", "current", "renewed"], null);
    await Bun.sleep(0);
    expect(t.served).toEqual([]);
    expect(t.logs).toEqual(["No certificate yet. Trying again in an hour."]);
    expect(t.timers.map((x) => x.ms)).toEqual([HOUR]);
    await t.tick();
    await t.tick();
    expect(t.served).toEqual(["cert 4"]);
    expect(t.timers.map((x) => x.ms)).toEqual([HOUR, HOUR, 12 * HOUR]);
    await t.tick();
    expect(t.served).toEqual(["cert 4"]); // current: the listener keeps running
    await t.tick();
    expect(t.served).toEqual(["cert 4", "cert 6"]); // renewed: the listener restarts
    expect(t.logs.length).toBe(2);
    t.keeper.stop();
    expect(t.timers[t.timers.length - 1]!.cancelled).toBe(true);
  });

  test("serves a certificate it already has before checking it", async () => {
    const t = setup(["failed"], certificate(1));
    expect(t.served).toEqual(["cert 1"]);
    await Bun.sleep(0);
    expect(t.served).toEqual(["cert 1"]);
    expect(t.logs).toEqual([]); // a failed renewal keeps the certificate it has
    expect(t.timers.map((x) => x.ms)).toEqual([HOUR]);
    t.keeper.stop();
  });
});

describe("bindAgain", () => {
  /** A bind that fails `failures` times, then returns "listening". */
  function flaky(failures: number) {
    const state = { calls: 0, slept: [] as number[], logs: [] as string[] };
    const bind = () => {
      state.calls += 1;
      if (state.calls <= failures) throw new Error(`Failed to start server. Is port 8443 in use? (${state.calls})`);
      return "listening";
    };
    const options = {
      log: (line: string) => state.logs.push(line),
      sleep: async (ms: number) => {
        state.slept.push(ms);
      },
    };
    return { state, bind, options };
  }

  test("binds at once when it can", async () => {
    const f = flaky(0);
    expect(await bindAgain(f.bind, f.options)).toBe("listening");
    expect(f.state).toEqual({ calls: 1, slept: [], logs: [] });
  });

  test("tries again a second apart, logging once", async () => {
    const f = flaky(3);
    expect(await bindAgain(f.bind, f.options)).toBe("listening");
    expect(f.state.calls).toBe(4);
    expect(f.state.slept).toEqual([1000, 1000, 1000]);
    expect(f.state.logs).toEqual([
      "Could not listen again with the new certificate (Failed to start server. Is port 8443 in use? (1)). Trying again every second, up to 10 times.",
    ]);
  });

  test("throws the last error after 10 failures", async () => {
    const f = flaky(10);
    let thrown: unknown;
    try {
      await bindAgain(f.bind, f.options);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe("Failed to start server. Is port 8443 in use? (10)");
    expect(f.state.calls).toBe(10);
    expect(f.state.slept).toHaveLength(9);
    expect(f.state.logs).toHaveLength(1);
  });

  test("rebinds a real listener's address once it is free", async () => {
    const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("first") });
    const port = first.port!;
    let freed = false;
    const second = await bindAgain(() => Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("second") }), {
      log: () => {},
      sleep: async () => {
        if (!freed) first.stop(true);
        freed = true;
      },
    });
    try {
      expect(freed).toBe(true); // the first try failed: the address was taken
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("second");
    } finally {
      first.stop(true);
      second.stop(true);
    }
  });
});

/** A port nothing listens on just now. */
const freePort = () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
};

describe("kerstel-server --tls self", () => {
  /** Reads `stream` until `pattern` matches what came so far, or `ms` pass. */
  async function waitForLine(stream: ReadableStream<Uint8Array>, pattern: RegExp, ms: number): Promise<{ match: RegExpExecArray | null; text: string }> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + ms;
    let text = "";
    try {
      while (Date.now() < deadline) {
        const next = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
        if (next === null || next.done) break;
        text += decoder.decode(next.value, { stream: true });
        const match = pattern.exec(text);
        if (match) return { match, text };
      }
      return { match: null, text };
    } finally {
      reader.releaseLock();
    }
  }

  test("prints its pin, and a client pinned to it reaches the server", async () => {
    const port = freePort();
    const server = `https://127.0.0.1:${port}`;
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/index.ts"), "--db", db, "--tls", "self", "--listen", `127.0.0.1:${port}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const { match, text } = await waitForLine(proc.stdout, /^Certificate pin: (sha256\/[A-Za-z0-9_-]{43})$/m, 10_000);
      if (!match) {
        proc.kill();
        throw new Error(`kerstel-server printed no pin. Its stdout:\n${text}\nIts stderr:\n${await new Response(proc.stderr).text()}`);
      }
      expect(text).toContain(`listening on ${server}`);
      const pin = parsePin(match[1]!);
      expect(pin).not.toBeNull();
      // The pin is the key's, which the server keeps beside its database.
      expect(pin!.equals(pinOfCertificate(new X509Certificate(readFileSync(tlsFiles(db).cert)).raw))).toBe(true);

      const response = await pinnedFetch(server, pin!)(new Request(`${server}/v1/health`));
      expect(response.status).toBe(200);
      await response.body?.cancel();

      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 20_000);
});

describe("kerstel-server --domain", () => {
  test("answers the challenge, then serves HTTPS with the certificate it got", async () => {
    const httpPort = freePort();
    const httpsPort = freePort();
    const ca = startFakeAcme({ challengePort: httpPort });
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../src/index.ts"),
        ...["--db", db, "--domain", DOMAIN, "--acme-directory", ca.directory],
        ...["--acme-http", `127.0.0.1:${httpPort}`, "--listen", `127.0.0.1:${httpsPort}`],
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      // Trust only the fake CA, and require the certificate to name the domain.
      const tls = {
        ca: ca.caPem,
        checkServerIdentity: (_host: string, cert: { raw: Buffer }) => {
          if (!certificateNames(cert.raw).includes(DOMAIN)) throw new Error(`the certificate does not name ${DOMAIN}`);
          return undefined;
        },
      };
      let response: Response | null = null;
      for (let i = 0; i < 150 && !response; i++) {
        response = await fetch(`https://127.0.0.1:${httpsPort}/v1/certificate`, { tls }).catch(() => null);
        if (!response) await Bun.sleep(100);
      }
      expect(response?.status).toBe(200);
      const served = Buffer.from(((await response!.json()) as { certificate: string }).certificate, "base64");
      expect(served.equals(new X509Certificate(readFileSync(tlsFiles(db).cert)).raw)).toBe(true);
      expect(ca.validated).toBe(1);

      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
      const stdout = await new Response(proc.stdout).text();
      expect(stdout).toContain(`Answering ACME challenges for ${DOMAIN} on http://127.0.0.1:${httpPort}`);
      expect(stdout).toContain(`Got a certificate for ${DOMAIN}, valid until 9999-12-31.`);
      expect(stdout).toContain(`listening on https://127.0.0.1:${httpsPort}`);
    } finally {
      proc.kill();
      ca.stop();
    }
  }, 20_000);
});
