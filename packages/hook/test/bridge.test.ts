import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DaemonHandle } from "../../cli/src/daemon/server";
import { generateDataKey } from "../../cli/src/vault/crypto";
import { openVault, type Vault } from "../../cli/src/vault/store";
// @ts-expect-error -- plain JS module without type declarations
import { createBridge } from "../src/bridge.js";

const running: DaemonHandle[] = [];
const vaults: Vault[] = [];
const bridges: { dispose(): void }[] = [];
const TOKEN = "bridge-test-token-98765";

afterEach(async () => {
  while (bridges.length) bridges.pop()!.dispose();
  while (running.length) await running.pop()!.close();
  while (vaults.length) vaults.pop()!.close();
});

const DAEMON_RUNNER = join(dirname(import.meta.path), "fixtures", "daemon-process.ts");

/**
 * Boots a daemon in a CHILD PROCESS, not in this one.
 *
 * resolveSync parks this thread on Atomics.wait, which stops this process's
 * event loop entirely. A daemon living on that same event loop could never
 * accept the worker's connection or write a reply, so every lookup would
 * deadlock until the worker's timeout fired. Out-of-process is also how the
 * daemon actually runs in production.
 */
async function boot(): Promise<{ sock: string; vault: Vault }> {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-bridge-"));
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\kerstel-b-${Date.now()}` : join(dir, "k.sock");
  const vaultFile = join(dir, "vault.db");
  const dataKey = generateDataKey();
  const vault = openVault(dataKey, vaultFile);
  vaults.push(vault);

  const child = Bun.spawn([process.execPath, DAEMON_RUNNER, sock, vaultFile], {
    env: { ...process.env, KERSTEL_TEST_TOKEN: TOKEN, KERSTEL_TEST_KEY: dataKey.toString("hex") },
    stdout: "pipe",
    stderr: "inherit",
  });

  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  if (first.done) throw new Error("daemon process exited before it was ready");

  const handle: DaemonHandle = {
    socketPath: sock,
    async close() {
      child.kill();
      await child.exited;
    },
  };
  running.push(handle);
  return { sock, vault };
}

function bridgeFor(sock: string, timeoutMs = 5_000) {
  const bridge = createBridge({ socketPath: sock, token: TOKEN, timeoutMs });
  bridges.push(bridge);
  return bridge;
}

test("resolveSync returns the value synchronously", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "sync-value");

  const bridge = bridgeFor(sock);
  expect(bridge.resolveSync("global", "K")).toBe("sync-value");
});

test("resolveSync handles many sequential lookups", async () => {
  const { sock, vault } = await boot();
  for (let i = 0; i < 30; i++) vault.setSecret({ scope: "global", key: `K${i}` }, `v${i}`);

  const bridge = bridgeFor(sock);
  for (let i = 0; i < 30; i++) expect(bridge.resolveSync("global", `K${i}`)).toBe(`v${i}`);
});

test("resolveSync round-trips values with newlines and unicode", async () => {
  const { sock, vault } = await boot();
  const value = "line1\nline2\t🔐 \"quoted\" \\slash";
  vault.setSecret({ scope: "global", key: "MULTI" }, value);

  expect(bridgeFor(sock).resolveSync("global", "MULTI")).toBe(value);
});

test("resolveSync handles a value larger than the shared buffer", async () => {
  const { sock, vault } = await boot();
  const big = "x".repeat(200_000);
  vault.setSecret({ scope: "global", key: "BIG" }, big);

  expect(bridgeFor(sock).resolveSync("global", "BIG")).toBe(big);
});

test("a missing secret throws with code not_found", async () => {
  const { sock } = await boot();
  const bridge = bridgeFor(sock);
  try {
    bridge.resolveSync("global", "MISSING");
    throw new Error("expected resolveSync to throw");
  } catch (error) {
    expect((error as { code?: string }).code).toBe("not_found");
  }
});

test("an unreachable daemon throws rather than hanging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-dead-"));
  const sock = process.platform === "win32" ? "\\\\.\\pipe\\kerstel-dead" : join(dir, "dead.sock");
  const bridge = bridgeFor(sock, 1_000);
  expect(() => bridge.resolveSync("global", "K")).toThrow();
});

test("the bridge does not keep the event loop alive", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "v");
  const bridge = bridgeFor(sock);
  bridge.resolveSync("global", "K");

  const proc = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore" });
  expect(await proc.exited).toBe(0);
});
