import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonError, connectDaemon, isDaemonRunning } from "../src/daemon/client";
import { startDaemon, type DaemonHandle } from "../src/daemon/server";
import { generateDataKey } from "../src/vault/crypto";
import { openVault, type Vault } from "../src/vault/store";

const running: DaemonHandle[] = [];
const vaults: Vault[] = [];
const TOKEN = "client-test-token-12345";

afterEach(async () => {
  while (running.length) await running.pop()!.close();
  while (vaults.length) vaults.pop()!.close();
});

async function boot(): Promise<{ sock: string; vault: Vault }> {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-client-"));
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\kerstel-c-${Date.now()}` : join(dir, "k.sock");
  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  vaults.push(vault);
  running.push(await startDaemon({ vault, socketPath: sock, token: TOKEN, backendName: "file" }));
  return { sock, vault };
}

test("resolve returns the secret value", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "value-1");

  const client = await connectDaemon({ socketPath: sock, token: TOKEN });
  expect(await client.resolve("global", "K")).toBe("value-1");
  client.close();
});

test("concurrent resolves on one connection match their own replies", async () => {
  const { sock, vault } = await boot();
  for (let i = 0; i < 20; i++) vault.setSecret({ scope: "global", key: `K${i}` }, `value-${i}`);

  const client = await connectDaemon({ socketPath: sock, token: TOKEN });
  const values = await Promise.all(
    Array.from({ length: 20 }, (_, i) => client.resolve("global", `K${i}`)),
  );
  expect(values).toEqual(Array.from({ length: 20 }, (_, i) => `value-${i}`));
  client.close();
});

test("a missing secret rejects with a not_found DaemonError", async () => {
  const { sock } = await boot();
  const client = await connectDaemon({ socketPath: sock, token: TOKEN });

  await expect(client.resolve("global", "MISSING")).rejects.toThrow(DaemonError);
  await client.resolve("global", "MISSING").catch((error: DaemonError) => {
    expect(error.code).toBe("not_found");
  });
  client.close();
});

test("a wrong token rejects with unauthorized", async () => {
  const { sock } = await boot();
  const client = await connectDaemon({ socketPath: sock, token: "nope-nope-nope-nope-1" });
  await client.resolve("global", "K").catch((error: DaemonError) => {
    expect(error.code).toBe("unauthorized");
  });
  client.close();
});

test("status reports the running daemon", async () => {
  const { sock } = await boot();
  const client = await connectDaemon({ socketPath: sock, token: TOKEN });
  const status = await client.status();
  expect(status.unlocked).toBe(true);
  expect(status.pid).toBeGreaterThan(0);
  client.close();
});

test("isDaemonRunning distinguishes a live socket from a dead one", async () => {
  const { sock } = await boot();
  expect(await isDaemonRunning(sock)).toBe(true);

  await running.pop()!.close();
  expect(await isDaemonRunning(sock)).toBe(false);
});

test("connecting to a nonexistent socket rejects quickly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-nosock-"));
  const sock = process.platform === "win32" ? "\\\\.\\pipe\\kerstel-absent" : join(dir, "absent.sock");
  await expect(connectDaemon({ socketPath: sock, token: TOKEN, timeoutMs: 300 })).rejects.toThrow();
});
