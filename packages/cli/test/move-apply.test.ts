import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBackups, readBackup, readBackupVault } from "../src/init/backup";
import { loadEnvFiles } from "../src/init/collect";
import { discoverEnvFiles } from "../src/init/detect";
import { MoveApplyError, applyMove, removeStaleTemps, writeFileAtomic } from "../src/move/apply";
import { planMove, type ConflictChoice } from "../src/move/plan";
import { scanRows, type Place } from "../src/move/scan";
import { generateDataKey } from "../src/vault/crypto";
import { openVault, type Vault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

const createdDirs: string[] = [];
const openVaults: Vault[] = [];

afterEach(() => {
  while (openVaults.length > 0) openVaults.pop()!.close();
  const home = process.env.KERSTEL_HOME;
  if (home && home.startsWith(tmpdir())) createdDirs.push(home);
  restoreEnv();
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup(files: Record<string, string>, secrets: Record<string, string>) {
  const home = isolateEnv({ prefix: "move-apply" });
  const root = mkdtempSync(join(tmpdir(), "kerstel-move-apply-"));
  createdDirs.push(root);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  const dataKey = generateDataKey();
  const vault = openVault(dataKey, join(home, "vault.db"));
  openVaults.push(vault);
  for (const [id, value] of Object.entries(secrets)) {
    const [scope, key] = id.split("/") as [string, string];
    vault.setSecret({ scope, key }, value);
  }
  return { root, vault, dataKey };
}

function makePlan(
  root: string,
  vault: Vault,
  moves: [string, Place][],
  choices: Record<string, ConflictChoice> = {},
  recordedRoot: string | null = root,
) {
  const loaded = loadEnvFiles(discoverEnvFiles(root));
  const { rows } = scanRows(loaded, "app");
  return planMove({
    scope: "app",
    root,
    loaded,
    requests: moves.map(([id, to]) => ({ row: rows.find((r) => r.id === id)!, to })),
    vaultValue: (ref) => vault.getSecret(ref),
    recordedRoot,
    choices: new Map(Object.entries(choices)),
    gitStatus: () => null,
  });
}

test("apply backs up, writes, deletes, and saves every deleted and overwritten value", () => {
  const { root, vault, dataKey } = setup(
    { ".env": "A=kerstel://app/A\nB=kerstel://app/B\n" },
    { "app/A": "value-a", "app/B": "value-b", "global/B": "old-shared-b" },
  );
  const plan = makePlan(root, vault, [["A:kerstel://app/A", "plaintext"], ["B:kerstel://app/B", "global"]], {
    "kerstel://global/B": "replace",
  });

  const result = applyMove(plan, { vault, dataKey, scope: "app", root, recordedRoot: root });

  expect(readFileSync(join(root, ".env"), "utf8")).toBe("A=value-a\nB=kerstel://global/B\n");
  expect(vault.getSecret({ scope: "global", key: "B" })).toBe("value-b");
  expect(vault.getSecret({ scope: "app", key: "A" })).toBeNull();
  expect(vault.getSecret({ scope: "app", key: "B" })).toBeNull();
  expect(result.deleted.map((r) => `${r.scope}/${r.key}`).sort()).toEqual(["app/A", "app/B"]);

  expect(readBackup("app", result.backup.timestamp, dataKey)).toEqual([
    { name: ".env", contents: "A=kerstel://app/A\nB=kerstel://app/B\n" },
  ]);
  expect(readBackupVault("app", result.backup.timestamp, dataKey)).toEqual([
    { scope: "app", key: "A", value: "value-a" },
    { scope: "app", key: "B", value: "value-b" },
    { scope: "global", key: "B", value: "old-shared-b" },
  ]);
});

test("a failure writing the vault leaves the vault and files as they were", () => {
  const { root, vault, dataKey } = setup(
    { ".env": "A=plain-a\nB=plain-b\n" },
    { "global/B": "old-shared-b" },
  );
  const plan = makePlan(root, vault, [["A:plaintext", "global"], ["B:plaintext", "global"]], {
    "kerstel://global/B": "replace",
  });
  let calls = 0;
  const failing: Vault = {
    ...vault,
    setSecret(ref, value) {
      calls += 1;
      if (calls === 2) throw new Error("disk full");
      vault.setSecret(ref, value);
    },
  };

  let caught: unknown;
  try {
    applyMove(plan, { vault: failing, dataKey, scope: "app", root, recordedRoot: root });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MoveApplyError);
  expect((caught as MoveApplyError).message).toContain("kerstel://global/B");
  expect((caught as MoveApplyError).backupDir).toContain(join("app"));
  expect(vault.getSecret({ scope: "global", key: "A" })).toBeNull();
  expect(vault.getSecret({ scope: "global", key: "B" })).toBe("old-shared-b");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("A=plain-a\nB=plain-b\n");
  expect(listBackups("app")).toHaveLength(1);
});

test("a failure writing a file restores the vault and the files already written", () => {
  const { root, vault, dataKey } = setup(
    { ".env.local": "K=kerstel://app/K\n", ".env": "K=kerstel://app/K\n" },
    { "app/K": "v", "global/K": "old-shared" },
  );
  const plan = makePlan(root, vault, [["K:kerstel://app/K", "global"]], { "kerstel://global/K": "replace" });
  let writes = 0;
  const writeFile = (path: string, contents: string) => {
    writes += 1;
    if (writes === 2) throw new Error("read-only file system");
    writeFileAtomic(path, contents);
  };

  let caughtFile: unknown;
  try {
    applyMove(plan, { vault, dataKey, scope: "app", root, recordedRoot: root, writeFile });
  } catch (error) {
    caughtFile = error;
  }
  expect(caughtFile).toBeInstanceOf(MoveApplyError);
  expect((caughtFile as MoveApplyError).message).toContain("read-only file system");
  expect((caughtFile as MoveApplyError).message).toContain(".env");
  expect(vault.getSecret({ scope: "global", key: "K" })).toBe("old-shared");
  expect(vault.getSecret({ scope: "app", key: "K" })).toBe("v");
  expect(readFileSync(join(root, ".env.local"), "utf8")).toBe("K=kerstel://app/K\n");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("K=kerstel://app/K\n");
});

test("a failure that also fails to roll back still throws MoveApplyError naming what could not be restored", () => {
  const { root, vault, dataKey } = setup(
    { ".env": "A=plain-a\nB=plain-b\n" },
    { "global/B": "old-shared-b" },
  );
  const plan = makePlan(root, vault, [["A:plaintext", "global"], ["B:plaintext", "global"]], {
    "kerstel://global/B": "replace",
  });
  let setCalls = 0;
  const failing: Vault = {
    ...vault,
    setSecret(ref, value) {
      setCalls += 1;
      // 1st call: A's write, succeeds, so rollback will try to remove it.
      // 2nd call: B's write, fails, triggering rollback.
      if (setCalls === 2) throw new Error("disk full");
      vault.setSecret(ref, value);
    },
    removeSecret(ref) {
      // Rollback removing A's write also fails, so it stays unrestored.
      throw new Error("keychain locked");
    },
  };

  let caught: unknown;
  try {
    applyMove(plan, { vault: failing, dataKey, scope: "app", root, recordedRoot: root });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(MoveApplyError);
  const err = caught as MoveApplyError;
  expect(err.message).toContain("disk full");
  expect(err.message).toContain("kerstel://global/B");
  expect(err.message).toContain("kerstel://global/A");
  expect(err.backupDir).toContain(join("backups", "app"));
  expect(listBackups("app")).toHaveLength(1);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("A=plain-a\nB=plain-b\n");
});

test("the project is registered only when the vault has no record", () => {
  const { root, vault, dataKey } = setup({ ".env": "A=plain\n" }, {});
  vault.registerProject("app", "/elsewhere/app");
  const plan = makePlan(root, vault, [["A:plaintext", "project"]], {}, "/elsewhere/app");
  const result = applyMove(plan, { vault, dataKey, scope: "app", root, recordedRoot: "/elsewhere/app" });
  expect(result.registered).toBe(false);
  expect(vault.listProjects()).toEqual([expect.objectContaining({ name: "app", rootPath: "/elsewhere/app" })]);
});

test("an unregistered project is registered at this root", () => {
  const { root, vault, dataKey } = setup({ ".env": "A=plain\n" }, {});
  const plan = makePlan(root, vault, [["A:plaintext", "project"]], {}, null);
  const result = applyMove(plan, { vault, dataKey, scope: "app", root, recordedRoot: null });
  expect(result.registered).toBe(true);
  expect(vault.listProjects()).toEqual([expect.objectContaining({ name: "app", rootPath: root })]);
});

test("writeFileAtomic keeps the mode and leaves no temp file", () => {
  isolateEnv({ prefix: "move-atomic" });
  const root = mkdtempSync(join(tmpdir(), "kerstel-move-atomic-"));
  createdDirs.push(root);
  const path = join(root, ".env");
  writeFileSync(path, "A=1\n");
  chmodSync(path, 0o600);

  writeFileAtomic(path, "A=2\n");

  expect(readFileSync(path, "utf8")).toBe("A=2\n");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(root)).toEqual([".env"]);
});

test("writeFileAtomic writes through a symlink instead of replacing it", () => {
  isolateEnv({ prefix: "move-symlink" });
  const root = mkdtempSync(join(tmpdir(), "kerstel-move-symlink-"));
  createdDirs.push(root);
  const targetPath = join(root, "shared.env");
  const linkPath = join(root, ".env");
  writeFileSync(targetPath, "A=1\n");
  symlinkSync(targetPath, linkPath);

  writeFileAtomic(linkPath, "A=2\n");

  expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  expect(readFileSync(targetPath, "utf8")).toBe("A=2\n");
  expect(readFileSync(linkPath, "utf8")).toBe("A=2\n");
});

test("removeStaleTemps removes only Kerstel's leftover temp files", () => {
  isolateEnv({ prefix: "move-stale" });
  const root = mkdtempSync(join(tmpdir(), "kerstel-move-stale-"));
  createdDirs.push(root);
  writeFileSync(join(root, ".env"), "A=1\n");
  writeFileSync(join(root, "..env.kerstel-tmp"), "half");
  writeFileSync(join(root, "notes.kerstel-tmp"), "not ours");

  expect(removeStaleTemps(root)).toEqual(["..env.kerstel-tmp"]);
  expect(readdirSync(root).sort()).toEqual([".env", "notes.kerstel-tmp"]);
});
