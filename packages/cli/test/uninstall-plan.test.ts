import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup } from "../src/init/backup";
import { lookup, parseDotenv, restoreLineValue, serializeDotenv, setValue } from "../src/init/dotenv-file";
import { launcherSource } from "../src/init/launcher";
import { hasLoss, planUninstall } from "../src/uninstall/plan";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

const dirs: string[] = [];
let vault: Vault | null = null;
let dataKey: Buffer = Buffer.alloc(0);

afterEach(() => {
  vault?.close();
  vault = null;
  restoreEnv();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function freshVault(): Promise<Vault> {
  dirs.push(isolateEnv({ prefix: "uninstall-plan" }));
  const { key } = await loadOrCreateDataKey();
  dataKey = key;
  vault = openVault(key);
  return vault;
}

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-uninstall-project-"));
  dirs.push(root);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  return root;
}

const WIRED = '{\n  "name": "demo-app",\n  "scripts": {\n    "dev": "node .kerstel/exec.cjs -- next dev"\n  }\n}\n';

test("rewrites references to vault values and never puts a value in the diff", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "demo-app", key: "API_KEY" }, "sk-live-value");
  const root = project({
    "package.json": WIRED,
    ".env": "# keep me\r\nAPI_KEY=kerstel://demo-app/API_KEY\r\nPORT=3000\r\n",
  });
  v.registerProject("demo-app", root);

  const plan = planUninstall(v, dataKey);
  const env = plan.files.find((f) => f.path === join(root, ".env"))!;
  expect(env.after).toBe("# keep me\r\nAPI_KEY=sk-live-value\r\nPORT=3000\r\n");
  expect(env.diffBefore + env.diffAfter).not.toContain("sk-live-value");
  expect(env.label).toBe("demo-app: .env");

  const pkg = plan.files.find((f) => f.path === join(root, "package.json"))!;
  expect(pkg.after).toContain('"dev": "next dev"');
  expect(plan.restored).toEqual([{ name: "demo-app", rootPath: root, envFiles: [".env"] }]);
  expect(hasLoss(plan)).toBe(false);
});

test("swaps the .gitignore note back", async () => {
  const v = await freshVault();
  const root = project({
    "package.json": WIRED,
    ".gitignore": "node_modules\n# Kerstel: .env files hold references, safe to commit\n",
  });
  v.registerProject("demo-app", root);

  const plan = planUninstall(v, dataKey);
  expect(plan.files.find((f) => f.path === join(root, ".gitignore"))?.after).toBe("node_modules\n.env\n.env.*\n");
});

test("records an unreachable project, an unresolvable reference, and an unused secret", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "global", key: "ORPHAN" }, "x");
  const gone = join(tmpdir(), "kerstel-uninstall-gone-project");
  v.registerProject("gone", gone);
  const noPkg = project({});
  v.registerProject("no-pkg", noPkg);
  const root = project({ "package.json": WIRED, ".env": "MISSING=kerstel://demo-app/MISSING\n" });
  v.registerProject("demo-app", root);

  const plan = planUninstall(v, dataKey);
  expect(plan.unreachable).toEqual([
    { name: "gone", rootPath: gone, reason: "the folder no longer exists" },
    { name: "no-pkg", rootPath: noPkg, reason: "it has no package.json" },
  ]);
  expect(plan.unresolvable).toEqual([
    { project: "demo-app", file: join(root, ".env"), reference: "kerstel://demo-app/MISSING" },
  ]);
  expect(plan.unused).toEqual(["kerstel://global/ORPHAN"]);
  expect(hasLoss(plan)).toBe(true);
});

test("a malformed package.json makes the project unreachable", async () => {
  const v = await freshVault();
  const root = project({ "package.json": "{ nope" });
  v.registerProject("bad-json", root);
  expect(planUninstall(v, dataKey).unreachable[0]?.reason).toBe("its package.json is not valid JSON");
});

test("a secret used only through a global reference in a project is not unused", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "global", key: "SHARED" }, "shared-value");
  const root = project({ "package.json": WIRED, ".env": "SHARED=kerstel://global/SHARED\n" });
  mkdirSync(join(root, "sub"));
  v.registerProject("demo-app", root);
  expect(planUninstall(v, dataKey).unused).toEqual([]);
});

test("duplicate keys with different references each get their own restored value", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "demo-app", key: "API_KEY" }, "api-value");
  v.setSecret({ scope: "demo-app", key: "SECRET" }, "secret-value");
  const root = project({
    "package.json": WIRED,
    ".env": "API_KEY=kerstel://demo-app/API_KEY\nAPI_KEY=kerstel://demo-app/SECRET\n",
  });
  v.registerProject("demo-app", root);

  const plan = planUninstall(v, dataKey);
  const env = plan.files.find((f) => f.path === join(root, ".env"))!;
  expect(env.after).toBe("API_KEY=api-value\nAPI_KEY=secret-value\n");
  expect(hasLoss(plan)).toBe(false);
});

test("duplicate keys on reference and plaintext lines preserve the plaintext", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "demo-app", key: "API_KEY" }, "restored-value");
  const root = project({
    "package.json": WIRED,
    ".env": "API_KEY=kerstel://demo-app/API_KEY\nAPI_KEY=local-plaintext-value\n",
  });
  v.registerProject("demo-app", root);

  const plan = planUninstall(v, dataKey);
  const env = plan.files.find((f) => f.path === join(root, ".env"))!;
  expect(env.after).toBe("API_KEY=restored-value\nAPI_KEY=local-plaintext-value\n");
  expect(hasLoss(plan)).toBe(false);
});

test("a key init collapsed across files is flagged as kept only in the backup", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "demo-app", key: "DB_PASSWORD" }, "my-local-pw");
  const reference = "DB_PASSWORD=kerstel://demo-app/DB_PASSWORD\n";
  const root = project({ "package.json": WIRED, ".env": reference, ".env.local": reference });
  v.registerProject("demo-app", root);
  // What init backs up: the originals, highest precedence first.
  const backup = createBackup({
    scope: "demo-app",
    dataKey,
    files: [
      { name: ".env.local", contents: "DB_PASSWORD=my-local-pw\n" },
      { name: ".env", contents: "DB_PASSWORD=shared-pw\nPORT=3000\n" },
    ],
  });

  const plan = planUninstall(v, dataKey);
  expect(plan.backupOnly).toEqual([
    // .env.local gets my-local-pw back from the vault; only .env's value is lost.
    { project: "demo-app", key: "DB_PASSWORD", files: [".env"], backupDir: backup.dir },
  ]);
  expect(hasLoss(plan)).toBe(true);
  expect(JSON.stringify(plan.backupOnly)).not.toContain("shared-pw");
});

test("a value collapsed by an earlier init is flagged from its older backup", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "demo-app", key: "API_KEY" }, "kept");
  const reference = "API_KEY=kerstel://demo-app/API_KEY\n";
  const root = project({ "package.json": WIRED, ".env": reference, ".env.local": reference });
  v.registerProject("demo-app", root);
  // First init collapsed two values; a re-run then backed up files that already held references.
  const first = createBackup({
    scope: "demo-app",
    dataKey,
    timestamp: "2026-01-01T00-00-00.000Z",
    files: [
      { name: ".env.local", contents: "API_KEY=kept\n" },
      { name: ".env", contents: "API_KEY=dropped\n" },
    ],
  });
  createBackup({
    scope: "demo-app",
    dataKey,
    timestamp: "2026-02-01T00-00-00.000Z",
    files: [
      { name: ".env.local", contents: reference },
      { name: ".env", contents: "API_KEY=kerstel://other/API_KEY\n" },
    ],
  });

  const plan = planUninstall(v, dataKey);
  // The later backup's differing references are not values, so only the first backup counts.
  expect(plan.backupOnly).toEqual([{ project: "demo-app", key: "API_KEY", files: [".env"], backupDir: first.dir }]);
  expect(hasLoss(plan)).toBe(true);
});

test("an unreadable backup is a possible loss, named without failing the plan", async () => {
  const v = await freshVault();
  const root = project({ "package.json": WIRED, ".env": "PORT=3000\n" });
  v.registerProject("demo-app", root);
  const backup = createBackup({ scope: "demo-app", dataKey, files: [{ name: ".env", contents: "PORT=3000\n" }] });
  writeFileSync(join(backup.dir, ".env.enc"), "not a ciphertext");

  const plan = planUninstall(v, dataKey);
  expect(plan.unreadableBackups).toEqual([
    { project: "demo-app", backupDir: backup.dir, reason: expect.any(String) as unknown as string },
  ]);
  expect(hasLoss(plan)).toBe(true);
});

test("a conflicting key init left in plaintext is not flagged", async () => {
  const v = await freshVault();
  // `init --keep DEBUG`: both values stay in the live files, nothing in the vault.
  const root = project({ "package.json": WIRED, ".env": "DEBUG=1\n", ".env.local": "DEBUG=0\n" });
  v.registerProject("demo-app", root);
  createBackup({
    scope: "demo-app",
    dataKey,
    files: [
      { name: ".env.local", contents: "DEBUG=0\n" },
      { name: ".env", contents: "DEBUG=1\n" },
    ],
  });

  const plan = planUninstall(v, dataKey);
  expect(plan.backupOnly).toEqual([]);
  expect(hasLoss(plan)).toBe(false);
});

test("a key assigned twice with different values in one file is flagged", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "demo-app", key: "API_KEY" }, "second");
  const root = project({
    "package.json": WIRED,
    ".env": "API_KEY=kerstel://demo-app/API_KEY\nAPI_KEY=kerstel://demo-app/API_KEY\n",
  });
  v.registerProject("demo-app", root);
  const backup = createBackup({
    scope: "demo-app",
    dataKey,
    files: [{ name: ".env", contents: "API_KEY=first\nAPI_KEY=second\nSAME=x\nSAME=x\n" }],
  });

  const plan = planUninstall(v, dataKey);
  expect(plan.backupOnly).toEqual([{ project: "demo-app", key: "API_KEY", files: [".env"], backupDir: backup.dir }]);
  expect(hasLoss(plan)).toBe(true);
});

test("a backup with no conflicting values, or no backup at all, contributes nothing", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "demo-app", key: "API_KEY" }, "same-value");
  const root = project({
    "package.json": WIRED,
    ".env": "API_KEY=kerstel://demo-app/API_KEY\n",
    ".env.local": "API_KEY=kerstel://demo-app/API_KEY\n",
  });
  v.registerProject("demo-app", root);
  expect(planUninstall(v, dataKey).backupOnly).toEqual([]);

  createBackup({
    scope: "demo-app",
    dataKey,
    timestamp: "2026-02-01T00-00-00.000Z",
    files: [
      { name: ".env.local", contents: "API_KEY=same-value\n" },
      { name: ".env", contents: "API_KEY=same-value\nAPI_KEY=same-value\n" },
    ],
  });
  const plan = planUninstall(v, dataKey);
  expect(plan.backupOnly).toEqual([]);
  expect(hasLoss(plan)).toBe(false);
});

test("a value only a move backup's vault section holds is flagged, by key, never by value", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "global", key: "API_KEY" }, "kept-shared");
  const root = project({ "package.json": WIRED, ".env": "API_KEY=kerstel://global/API_KEY\n" });
  v.registerProject("demo-app", root);
  // ks move kept the shared value; the project's own copy was deleted and saved here.
  const backup = createBackup({
    scope: "demo-app",
    dataKey,
    files: [{ name: ".env", contents: "API_KEY=kerstel://demo-app/API_KEY\n" }],
    vault: [{ scope: "demo-app", key: "API_KEY", value: "moved-away-value" }],
  });

  const plan = planUninstall(v, dataKey);
  expect(plan.backupOnly).toEqual([
    { project: "demo-app", key: "API_KEY", files: ["vault.enc"], backupDir: backup.dir },
  ]);
  expect(hasLoss(plan)).toBe(true);
  expect(JSON.stringify(plan)).not.toContain("moved-away-value");
});

test("a move backup's vault value that a restored file or the vault still holds is not flagged", async () => {
  const v = await freshVault();
  // Moved project → global: the project copy was deleted, and global holds the same value.
  v.setSecret({ scope: "global", key: "API_KEY" }, "same-value");
  // Overwritten by a replace, then set back by hand: the vault holds it again.
  v.setSecret({ scope: "global", key: "TOKEN" }, "token-value");
  const root = project({
    "package.json": WIRED,
    ".env": "API_KEY=kerstel://global/API_KEY\nTOKEN=kerstel://global/TOKEN\n",
  });
  v.registerProject("demo-app", root);
  createBackup({
    scope: "demo-app",
    dataKey,
    files: [{ name: ".env", contents: "API_KEY=kerstel://demo-app/API_KEY\nTOKEN=kerstel://demo-app/TOKEN\n" }],
    vault: [
      { scope: "demo-app", key: "API_KEY", value: "same-value" },
      { scope: "global", key: "TOKEN", value: "token-value" },
    ],
  });

  const plan = planUninstall(v, dataKey);
  expect(plan.backupOnly).toEqual([]);
  expect(hasLoss(plan)).toBe(false);
});

test("a move backup whose vault section cannot be read is an unreadable backup", async () => {
  const v = await freshVault();
  const root = project({ "package.json": WIRED, ".env": "PORT=3000\n" });
  v.registerProject("demo-app", root);
  const backup = createBackup({
    scope: "demo-app",
    dataKey,
    files: [{ name: ".env", contents: "PORT=3000\n" }],
    vault: [{ scope: "demo-app", key: "API_KEY", value: "saved" }],
  });
  writeFileSync(join(backup.dir, "vault.enc"), "not a ciphertext");

  const plan = planUninstall(v, dataKey);
  expect(plan.unreadableBackups).toEqual([
    { project: "demo-app", backupDir: backup.dir, reason: expect.any(String) as unknown as string },
  ]);
  expect(plan.backupOnly).toEqual([]);
});

// Each line as a developer wrote it. init rewrites it to a reference with
// setValue; uninstall must put back these exact bytes, not a re-quoted copy.
const QUOTING_CASES = [
  'B="with \\"escape\\""',
  'E=a"b',
  'H="tab\\there"',
  "I=back\\slash",
];

test.each(QUOTING_CASES)("restoring %s keeps its original quoting byte for byte", (line) => {
  const original = `# c\r\nexport ${line} # note\r\n`;
  const parsed = parseDotenv(original);
  const key = parsed.lines[1]!.kind === "pair" ? parsed.lines[1]!.key : "";
  const value = lookup(parsed, key)!;

  // init-style rewrite
  const wired = parseDotenv(original);
  setValue(wired, key, `kerstel://demo-app/${key}`);
  const wiredText = serializeDotenv(wired);
  expect(wiredText).not.toContain(value);

  // uninstall-style restore
  const restored = parseDotenv(wiredText);
  restoreLineValue(restored, 1, value);
  expect(serializeDotenv(restored)).toBe(original);
});

test("restoreLineValue falls back to a quoting that holds the value", () => {
  const file = parseDotenv("A=kerstel://demo-app/A # note\n");
  restoreLineValue(file, 0, "has space #hash");
  const text = serializeDotenv(file);
  expect(text).toBe('A="has space #hash" # note\n');
  expect(lookup(parseDotenv(text), "A")).toBe("has space #hash");
});

test("the plan restores values in their original quoting", async () => {
  const v = await freshVault();
  const originals = parseDotenv(QUOTING_CASES.join("\n") + "\n");
  let wiredEnv = QUOTING_CASES.join("\n") + "\n";
  const wired = parseDotenv(wiredEnv);
  for (const pair of originals.lines) {
    if (pair.kind !== "pair") continue;
    v.setSecret({ scope: "demo-app", key: pair.key }, pair.value);
    setValue(wired, pair.key, `kerstel://demo-app/${pair.key}`);
  }
  wiredEnv = serializeDotenv(wired);
  const root = project({ "package.json": WIRED, ".env": wiredEnv });
  v.registerProject("demo-app", root);

  const env = planUninstall(v, dataKey).files.find((f) => f.path === join(root, ".env"))!;
  expect(env.after).toBe(QUOTING_CASES.join("\n") + "\n");
});

test("the plan deletes Kerstel's launcher and leaves a foreign one, named", async () => {
  const v = await freshVault();
  const ours = project({ "package.json": WIRED, ".env": "PORT=3000\n" });
  mkdirSync(join(ours, ".kerstel"));
  writeFileSync(join(ours, ".kerstel", "exec.cjs"), launcherSource());
  v.registerProject("demo-app", ours);

  const theirs = project({ "package.json": WIRED.replace("demo-app", "other-app"), ".env": "PORT=3000\n" });
  mkdirSync(join(theirs, ".kerstel"));
  writeFileSync(join(theirs, ".kerstel", "exec.cjs"), "#!/bin/sh\necho mine\n");
  v.registerProject("other-app", theirs);

  const plan = planUninstall(v, dataKey);
  expect(plan.launchers).toEqual([{ path: join(ours, ".kerstel", "exec.cjs"), project: "demo-app" }]);
  expect(plan.foreignLaunchers).toEqual([{ path: join(theirs, ".kerstel", "exec.cjs"), project: "other-app" }]);
  expect(hasLoss(plan)).toBe(false);
});
