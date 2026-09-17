import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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

test("lock stops further resolutions until restart", async () => {
  const { sock, token, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "v");
  await request(sock, { v: PROTOCOL_VERSION, id: "1", token, op: "lock" });

  const res = await request(sock, {
    v: PROTOCOL_VERSION, id: "2", token, op: "resolve",
    scope: "global", key: "K", pid: null, processName: null,
  });
  expect(res).toMatchObject({ ok: false, error: { code: "locked" } });
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

test("a stale socket file is replaced on restart", async () => {
  const { sock, token } = await boot();
  await running.pop()!.close();

  const dir = mkdtempSync(join(tmpdir(), "kerstel-restart-"));
  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  vaults.push(vault);
  running.push(await startDaemon({ vault, socketPath: sock, token, backendName: "file" }));

  const res = await request(sock, { v: PROTOCOL_VERSION, id: "1", token, op: "status" });
  expect(res).toMatchObject({ ok: true });
});
