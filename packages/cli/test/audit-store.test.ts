import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDataKey } from "../src/vault/crypto";
import { openVault, type AuditEntry, type Vault } from "../src/vault/store";

const open: Vault[] = [];
const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "kerstel-audit-"));
  dirs.push(d);
  return d;
}
function vaultIn(dir: string): Vault {
  const v = openVault(generateDataKey(), join(dir, "vault.db"));
  open.push(v);
  return v;
}
afterEach(() => {
  while (open.length) open.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function row(over: Partial<AuditEntry> & Pick<AuditEntry, "ts" | "event">): AuditEntry {
  return { scope: "web", key: "K", pid: 1, processName: "node", ...over };
}

test("migrates a v4 vault to v5 and keeps its audit rows", () => {
  const dir = tempDir();
  const db = new Database(join(dir, "vault.db"), { create: true });
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
      package_name TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, key TEXT NOT NULL,
      value_ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, environment TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(scope, key));
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, event TEXT NOT NULL,
      scope TEXT NOT NULL, key TEXT NOT NULL, pid INTEGER, process_name TEXT,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL);
    CREATE INDEX audit_log_ts_idx ON audit_log(ts DESC);
    CREATE TABLE vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sync_state (
      scope TEXT NOT NULL, key TEXT NOT NULL, base_rev INTEGER NOT NULL, dirty INTEGER NOT NULL,
      change INTEGER NOT NULL, conflict BLOB, PRIMARY KEY (scope, key));
    INSERT INTO audit_log (ts, event, scope, key, pid, process_name) VALUES (7, 'resolve', 'web', 'A', 3, 'node');
    PRAGMA user_version = 4;
  `);
  db.close();

  const v = vaultIn(dir);
  const [first] = v.listAudit(5);
  expect(first).toMatchObject({ ts: 7, event: "resolve", scope: "web", key: "A", pid: 3, processName: "node" });
  expect(first!.chain).toBeNull();
  expect(first!.project).toBeNull();
});

test("stores the chain and maps cwd to the deepest registered checkout", () => {
  const v = vaultIn(tempDir());
  v.registerProject("mono", "/code/mono");
  v.registerProject("web", "/code/mono/packages/web");
  v.appendAudit(row({ ts: 1, event: "resolve", chain: ["node", "zsh"], cwd: "/code/mono/packages/web/src" }));
  v.appendAudit(row({ ts: 2, event: "resolve", cwd: "/code/mono/tools" }));
  v.appendAudit(row({ ts: 3, event: "resolve", cwd: "/code/mono2" }));
  v.appendAudit(row({ ts: 4, event: "resolve", cwd: "/elsewhere" }));
  v.appendAudit(row({ ts: 5, event: "resolve", cwd: "/code/mono/packages/web" }));

  const rows = v.listAudit(10).reverse();
  expect(rows.map((r) => r.project?.name ?? null)).toEqual(["web", "mono", null, null, "web"]);
  expect(rows[0]!.project).toEqual({ name: "web", rootPath: "/code/mono/packages/web" });
  expect(rows[0]!.chain).toEqual(["node", "zsh"]);
  expect(rows[1]!.chain).toBeNull();
});

function seedSix(v: Vault): void {
  v.appendAudit(row({ ts: 10, event: "resolve", scope: "web", key: "A" })); // 1
  v.appendAudit(row({ ts: 20, event: "reveal", scope: "web", key: "B" })); // 2
  v.appendAudit(row({ ts: 30, event: "set", scope: "api", key: "A" })); // 3
  v.appendAudit(row({ ts: 40, event: "run", scope: "api", key: "C" })); // 4
  v.appendAudit(row({ ts: 50, event: "resolve", scope: "api", key: "A" })); // 5
  v.appendAudit(row({ ts: 60, event: "remove", scope: "web", key: "B" })); // 6
}
const ids = (v: Vault, f: Parameters<Vault["listAudit"]>[0]) => v.listAudit(f).map((r) => r.id);

test("filters by scope, key, events, and since, newest first", () => {
  const v = vaultIn(tempDir());
  seedSix(v);
  expect(ids(v, { limit: 10 })).toEqual([6, 5, 4, 3, 2, 1]);
  expect(ids(v, { limit: 2 })).toEqual([6, 5]);
  expect(ids(v, { limit: 10, scope: "api" })).toEqual([5, 4, 3]);
  expect(ids(v, { limit: 10, key: "A" })).toEqual([5, 3, 1]);
  expect(ids(v, { limit: 10, events: ["resolve", "run"] })).toEqual([5, 4, 1]);
  expect(ids(v, { limit: 10, since: 30 })).toEqual([6, 5, 4, 3]);
  expect(ids(v, { limit: 10, scope: "api", key: "A", events: ["resolve"], since: 40 })).toEqual([5]);
  expect(ids(v, { limit: 10, events: [] })).toEqual([6, 5, 4, 3, 2, 1]);
});

test("counts reveals, app reads, processes, projects, and changes", () => {
  const v = vaultIn(tempDir());
  v.registerProject("web", "/code/web");
  v.registerProject("api", "/code/api");
  v.appendAudit(row({ ts: 1, event: "resolve", pid: 10, cwd: "/code/web" }));
  v.appendAudit(row({ ts: 2, event: "resolve", pid: 10, cwd: "/code/web" }));
  v.appendAudit(row({ ts: 3, event: "run", pid: 11, cwd: "/code/api" }));
  v.appendAudit(row({ ts: 4, event: "resolve", pid: 12 }));
  v.appendAudit(row({ ts: 5, event: "reveal", pid: 99, cwd: "/code/web" }));
  v.appendAudit(row({ ts: 6, event: "set", pid: 98, cwd: "/code/web" }));
  v.appendAudit(row({ ts: 7, event: "remove" }));
  v.appendAudit(row({ ts: 8, event: "sync", scope: "", key: "" }));
  v.appendAudit(row({ ts: 9, event: "device", scope: "", key: "" }));

  expect(v.auditCounts({})).toEqual({ reveals: 1, appReads: 4, processes: 3, projects: 2, changes: 4 });
  expect(v.auditCounts({ since: 4 })).toEqual({ reveals: 1, appReads: 1, processes: 1, projects: 0, changes: 4 });
  expect(vaultIn(tempDir()).auditCounts({})).toEqual({ reveals: 0, appReads: 0, processes: 0, projects: 0, changes: 0 });
});

test("groups app reads by project and process", () => {
  const v = vaultIn(tempDir());
  v.registerProject("web", "/code/web");
  v.appendAudit(row({ ts: 1, event: "resolve", key: "B", pid: 20, processName: "node", cwd: "/code/web" }));
  v.appendAudit(row({ ts: 2, event: "resolve", key: "A", pid: 21, processName: "node", cwd: "/code/web" }));
  v.appendAudit(row({ ts: 3, event: "resolve", key: "A", pid: 21, processName: "node", cwd: "/code/web" }));
  v.appendAudit(row({ ts: 4, event: "run", key: "C", pid: 22, processName: "bun" }));
  v.appendAudit(row({ ts: 5, event: "reveal", key: "Z", pid: 23, cwd: "/code/web" }));

  expect(v.appReadGroups({ limit: 100 })).toEqual([
    { project: "web", process: "node", keys: ["A", "B"], processes: 2 },
    { project: null, process: "kerstel run", keys: ["C"], processes: 1 },
  ]);
  expect(v.appReadGroups({ limit: 100, key: "C" })).toEqual([
    { project: null, process: "kerstel run", keys: ["C"], processes: 1 },
  ]);
});

test("prunes rows older than the cutoff", () => {
  const v = vaultIn(tempDir());
  for (const ts of [1, 2, 3]) v.appendAudit(row({ ts, event: "resolve" }));
  expect(v.pruneAudit(3)).toBe(2);
  expect(v.listAudit(10).map((r) => r.ts)).toEqual([3]);
});
