import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditActor } from "../src/audit/actor";
import { runCli } from "../src/index";
import { vaultData } from "../src/tui/data";
import { generateDataKey } from "../src/vault/crypto";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

const open: Vault[] = [];
const dirs: string[] = [];
const realCwd = process.cwd();
const realLog = console.log;

function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "kerstel-writes-")));
  dirs.push(d);
  return d;
}
function actor(chain: string[] = ["bun", "zsh"]): AuditActor {
  return { pid: 4242, processName: "kerstel", cwd: null, chain: () => chain };
}
function vaultIn(options?: { actor?: AuditActor }): Vault {
  const v = openVault(generateDataKey(), join(tempDir(), "vault.db"), options ?? { actor: actor() });
  open.push(v);
  return v;
}
afterEach(() => {
  console.log = realLog;
  process.chdir(realCwd);
  while (open.length) open.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  restoreEnv();
});

const ref = { scope: "web", key: "A" };

test("set and rm through the CLI write rows stamped with the chain and project", async () => {
  isolateEnv({ prefix: "audit-writes" });
  const checkout = tempDir();
  mkdirSync(join(checkout, "src"));
  const seed = openVault((await loadOrCreateDataKey()).key);
  seed.registerProject("web", checkout);
  seed.close();

  process.chdir(join(checkout, "src"));
  console.log = () => {};
  const realWrite = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
  expect(await runCli(["set", "web/A", "--value", "x"])).toBe(0);
  expect(await runCli(["rm", "web/A", "--yes"])).toBe(0);
  } finally {
    process.stderr.write = realWrite;
  }
  process.chdir(realCwd);

  const v = openVault((await loadOrCreateDataKey()).key);
  open.push(v);
  const [newest, older] = v.listAudit(2);
  expect(newest!.event).toBe("remove");
  expect(older!.event).toBe("set");
  for (const r of [newest!, older!]) {
    expect(r.processName).toBe("kerstel");
    expect(Array.isArray(r.chain)).toBe(true);
    expect(r.project?.name).toBe("web");
  }
});

test("rm of a missing key writes no row", () => {
  const v = vaultIn();
  expect(v.removeSecret(ref)).toBe(false);
  expect(v.listAudit(10)).toHaveLength(0);
});

test("applyRemote writes a sync row only when it applies", () => {
  const v = vaultIn();
  v.setSecret(ref, "x");
  const before = v.listAudit(100).length;
  expect(v.sync.applyRemote(ref, "y", 1, 99)).toBe(false);
  expect(v.listAudit(100)).toHaveLength(before);
  const change = v.sync.row(ref)?.change ?? 0;
  expect(v.sync.applyRemote(ref, "y", 1, change)).toBe(true);
  const rows = v.listAudit(100);
  expect(rows).toHaveLength(before + 1);
  expect(rows[0]).toMatchObject({ event: "sync", scope: "web", key: "A" });
});

test("keepLocal writes a sync row", () => {
  const v = vaultIn();
  v.setSecret(ref, "x");
  v.sync.trackAll();
  v.sync.setConflict(ref, { rev: 2, blob: null });
  v.sync.keepLocal(ref, 2);
  expect(v.listAudit(1)[0]).toMatchObject({ event: "sync", scope: "web", key: "A" });
});

test("a rolled-back write leaves no row", () => {
  const v = vaultIn();
  expect(() =>
    v.transaction(() => {
      v.setSecret(ref, "x");
      throw new Error("stop");
    }),
  ).toThrow("stop");
  expect(v.getSecret(ref)).toBeNull();
  expect(v.listAudit(10)).toHaveLength(0);
});

test("the UI's store, remove, and reveal write set, remove, and reveal rows", () => {
  const v = vaultIn();
  const data = vaultData(v);
  expect(data.store(ref, "ui-value-123", false)).toBe(true);
  expect(data.reveal(ref)).toBe("ui-value-123");
  expect(data.remove(ref)).toBe(true);
  expect(v.listAudit(10).map((r) => r.event)).toEqual(["remove", "reveal", "set"]);
  expect(v.listAudit(10).every((r) => r.pid === 4242 && r.chain?.[0] === "bun")).toBe(true);
});

test("no row holds the value", () => {
  const v = vaultIn();
  const data = vaultData(v);
  data.store(ref, "needle-value-789", false);
  data.reveal(ref);
  v.sync.applyRemote(ref, "needle-remote-456", 1, v.sync.row(ref)?.change ?? 0);
  data.remove(ref);
  const dump = JSON.stringify(v.listAudit(100));
  expect(dump).not.toContain("needle-value-789");
  expect(dump).not.toContain("needle-remote-456");
});

test("a write still succeeds when the chain cannot be read", () => {
  const v = vaultIn({ actor: actor([]) });
  v.setSecret(ref, "x");
  expect(v.getSecret(ref)).toBe("x");
  expect(v.listAudit(1)[0]).toMatchObject({ event: "set", chain: [] });
});
