import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, PROTOCOL_VERSION, encodeMessage, type Response } from "../src/daemon/protocol";
import { startDaemon, type DaemonHandle } from "../src/daemon/server";
import { generateDataKey } from "../src/vault/crypto";
import { openVault, type Vault } from "../src/vault/store";

const running: DaemonHandle[] = [];
const vaults: Vault[] = [];

afterEach(async () => {
  while (running.length) await running.pop()!.close();
  while (vaults.length) vaults.pop()!.close();
});

/** Sends one request over a fresh connection and resolves with the reply. */
function request(sock: string, message: unknown): Promise<Response> {
  return new Promise((resolve, reject) => {
    const decoder = new LineDecoder();
    const conn = createConnection(sock);
    conn.on("error", reject);
    conn.on("connect", () => conn.write(encodeMessage(message)));
    conn.on("data", (chunk) => {
      for (const line of decoder.push(chunk)) {
        conn.end();
        resolve(JSON.parse(line) as Response);
        return;
      }
    });
  });
}

async function boot(): Promise<{ sock: string; token: string; vault: Vault }> {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-daemon-"));
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\kerstel-test-${Date.now()}` : join(dir, "k.sock");
  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  vaults.push(vault);
  const token = "test-token-0123456789";
  running.push(await startDaemon({ vault, socketPath: sock, token, backendName: "file" }));
  return { sock, token, vault };
}

test("resolve returns the stored secret", async () => {
  const { sock, token, vault } = await boot();
  vault.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, "sk-live-xyz");

  const res = await request(sock, {
    v: PROTOCOL_VERSION, id: "1", token, op: "resolve",
    scope: "global", key: "OPENAI_API_KEY", pid: 123, processName: "node",
  });
  expect(res).toMatchObject({ ok: true, op: "resolve", value: "sk-live-xyz" });
});

test("resolve records an audit entry without the value", async () => {
  const { sock, token, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "the-value");
  await request(sock, {
    v: PROTOCOL_VERSION, id: "1", token, op: "resolve",
    scope: "global", key: "K", pid: 42, processName: "bun",
  });

  const entries = vault.listAudit(5);
  expect(entries.length).toBe(1);
  expect(entries[0]).toMatchObject({ event: "resolve", scope: "global", key: "K", pid: 42 });
  expect(JSON.stringify(entries)).not.toContain("the-value");
});

test("an unknown secret returns not_found", async () => {
  const { sock, token } = await boot();
  const res = await request(sock, {
    v: PROTOCOL_VERSION, id: "1", token, op: "resolve",
    scope: "global", key: "MISSING", pid: null, processName: null,
  });
  expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
});

test("a wrong token is rejected", async () => {
  const { sock } = await boot();
  const res = await request(sock, {
    v: PROTOCOL_VERSION, id: "1", token: "wrong-token-000000000", op: "resolve",
    scope: "global", key: "K", pid: null, processName: null,
  });
  expect(res).toMatchObject({ ok: false, error: { code: "unauthorized" } });
});

test("an unsupported protocol version is rejected", async () => {
  const { sock, token } = await boot();
  const res = await request(sock, { v: 99, id: "1", token, op: "status" });
  expect(res).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
});

test("malformed JSON yields bad_request instead of crashing the daemon", async () => {
  const { sock, token } = await boot();
  const res = await new Promise<Response>((resolve, reject) => {
    const decoder = new LineDecoder();
    const conn = createConnection(sock);
    conn.on("error", reject);
    conn.on("connect", () => conn.write("{not json\n"));
    conn.on("data", (chunk) => {
      for (const line of decoder.push(chunk)) {
        conn.end();
        resolve(JSON.parse(line) as Response);
        return;
      }
    });
  });
  expect(res).toMatchObject({ ok: false, error: { code: "bad_request" } });

  const still = await request(sock, { v: PROTOCOL_VERSION, id: "2", token, op: "status" });
  expect(still).toMatchObject({ ok: true });
});

test("status reports the daemon state", async () => {
  const { sock, token, vault } = await boot();
  vault.setSecret({ scope: "global", key: "A" }, "1");
  const res = await request(sock, { v: PROTOCOL_VERSION, id: "1", token, op: "status" });
  expect(res).toMatchObject({ ok: true, op: "status", unlocked: true, secretCount: 1, backend: "file" });
});

// `lock` shuts the daemon down rather than flipping a flag. The data key is
// resident in the serving process's memory for as long as it is open, so a
// boolean that refuses requests leaves the key exactly where someone typing
// `lock` wants it gone from. Ending the process is what actually drops it; the
// next resolution auto-starts a daemon that re-reads the keychain.
test("lock acknowledges, then drops the key by shutting the daemon down", async () => {
  const { sock, token, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "v");

  const res = await Promise.race([
    request(sock, { v: PROTOCOL_VERSION, id: "1", token, op: "lock" }),
    new Promise<Response>((_resolve, reject) =>
      setTimeout(() => reject(new Error("lock ack was not delivered to the client")), 2000),
    ),
  ]);
  expect(res).toMatchObject({ ok: true, op: "lock" });

  // Let the microtask-scheduled close() finish tearing the server down.
  await Bun.sleep(50);

  await new Promise<void>((resolve, reject) => {
    const conn = createConnection(sock);
    conn.on("connect", () => {
      conn.destroy();
      reject(new Error("connected to a daemon that should have locked and stopped"));
    });
    conn.on("error", () => resolve());
  });
});

test("a client lock resolves the closed signal", async () => {
  const { sock, token } = await boot();
  const handle = running.pop()!;

  const res = await request(sock, { v: PROTOCOL_VERSION, id: "1", token, op: "lock" });
  expect(res).toMatchObject({ ok: true, op: "lock" });

  // `daemon serve` parks on this promise; a lock has to settle it or that
  // process stays alive holding the very key it was told to drop.
  await handle.closed;
});

test("the daemon relocks itself after the idle timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-idle-"));
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\kerstel-idle-${Date.now()}` : join(dir, "k.sock");
  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  vaults.push(vault);
  vault.setSecret({ scope: "global", key: "K" }, "v");

  running.push(await startDaemon({ vault, socketPath: sock, token: "t".repeat(20), backendName: "file", idleMs: 50 }));
  await Bun.sleep(120);

  const res = await request(sock, {
    v: PROTOCOL_VERSION, id: "1", token: "t".repeat(20), op: "resolve",
    scope: "global", key: "K", pid: null, processName: null,
  });
  expect(res).toMatchObject({ ok: false, error: { code: "locked" } });
});

test("shutdown acknowledges the request before the daemon stops accepting connections", async () => {
  const { sock, token } = await boot();

  // If the synchronous ack write got clobbered by the scheduled close()
  // destroying the socket first, this would hang forever instead of
  // resolving — race it against a timeout so that failure mode surfaces as
  // a clear assertion instead of a stuck test run.
  const res = await Promise.race([
    request(sock, { v: PROTOCOL_VERSION, id: "1", token, op: "shutdown" }),
    new Promise<Response>((_resolve, reject) =>
      setTimeout(() => reject(new Error("shutdown ack was not delivered to the client")), 2000),
    ),
  ]);
  expect(res).toMatchObject({ ok: true, op: "shutdown" });

  // Give the microtask-scheduled close() a moment to actually tear the
  // server down before probing that it is gone.
  await Bun.sleep(50);

  await new Promise<void>((resolve, reject) => {
    const conn = createConnection(sock);
    conn.on("connect", () => {
      conn.destroy();
      reject(new Error("connected to a daemon that should have shut down"));
    });
    conn.on("error", () => resolve());
  });
});

// This is the restart-after-CRASH story, which is the only reason the unlink in
// startDaemon() exists. A daemon that shuts down cleanly removes its own socket
// file, so closing one and starting another proves nothing about stale files --
// there is nothing left at the path to be stale. The state after a crash is a
// file sitting at the socket path with nobody listening, and bind(2) refusing
// to reuse it. Create exactly that, by hand, and make the daemon walk over it.
test("a socket path left occupied by a crashed daemon is rebound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-restart-"));
  const sock =
    process.platform === "win32"
      ? `\\\\.\\pipe\\kerstel-stale-${Date.now()}`
      : join(dir, "k.sock");
  const token = "test-token-0123456789";

  if (process.platform !== "win32") {
    // A bare regular file, never listened on: the leftover a SIGKILLed daemon
    // leaves behind. Without the unlink, listen() fails here with EADDRINUSE.
    writeFileSync(sock, "");
    expect(existsSync(sock)).toBe(true);
  }

  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  vaults.push(vault);
  running.push(await startDaemon({ vault, socketPath: sock, token, backendName: "file" }));

  const res = await request(sock, { v: PROTOCOL_VERSION, id: "1", token, op: "status" });
  expect(res).toMatchObject({ ok: true, op: "status" });
});

test("close() resolves the handle's closed signal", async () => {
  const { sock } = await boot();
  const handle = running.pop()!;
  expect(handle.socketPath).toBe(sock);

  let settled = false;
  void handle.closed.then(() => {
    settled = true;
  });

  // Nothing has closed the server yet, so the signal must still be pending.
  await Bun.sleep(10);
  expect(settled).toBe(false);

  await handle.close();
  await handle.closed;
  expect(settled).toBe(true);
});

test("a client shutdown resolves the closed signal too", async () => {
  const { sock, token } = await boot();
  const handle = running.pop()!;

  const res = await request(sock, { v: PROTOCOL_VERSION, id: "1", token, op: "shutdown" });
  expect(res).toMatchObject({ ok: true });

  // `daemon serve` awaits exactly this promise; a remote shutdown has to settle
  // it or that process parks forever holding an open vault.
  await handle.closed;
});
