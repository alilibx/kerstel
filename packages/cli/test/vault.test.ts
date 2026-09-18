import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDataKey } from "../src/vault/crypto";
import {
  META_KEYCHAIN_BACKEND,
  META_KEY_CHECK,
  readVaultMeta,
  sealKeyCheck,
  verifyKeyCheck,
} from "../src/vault/meta";
import { SCHEMA_VERSION, openVault, type Vault } from "../src/vault/store";

const open: Vault[] = [];
function vaultIn(dir: string, key: Buffer): Vault {
  const v = openVault(key, join(dir, "vault.db"));
  open.push(v);
  return v;
}
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kerstel-vault-"));
}
afterEach(() => {
  while (open.length) open.pop()!.close();
});

test("set then get round-trips a secret", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, "sk-test-123");
  expect(v.getSecret({ scope: "global", key: "OPENAI_API_KEY" })).toBe("sk-test-123");
});

test("getSecret returns null for an unknown key", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  expect(v.getSecret({ scope: "global", key: "NOPE" })).toBeNull();
});

test("scopes are isolated — no fallback to global", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.setSecret({ scope: "global", key: "API_KEY" }, "global-value");
  expect(v.getSecret({ scope: "my-app", key: "API_KEY" })).toBeNull();

  v.setSecret({ scope: "my-app", key: "API_KEY" }, "project-value");
  expect(v.getSecret({ scope: "my-app", key: "API_KEY" })).toBe("project-value");
  expect(v.getSecret({ scope: "global", key: "API_KEY" })).toBe("global-value");
});

test("setting the same scope and key twice updates in place", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.setSecret({ scope: "global", key: "K" }, "first");
  v.setSecret({ scope: "global", key: "K" }, "second");
  expect(v.getSecret({ scope: "global", key: "K" })).toBe("second");
  expect(v.listSecrets("global").length).toBe(1);
});

test("values are encrypted at rest", () => {
  const dir = tempDir();
  const v = vaultIn(dir, generateDataKey());
  v.setSecret({ scope: "global", key: "K" }, "PLAINTEXT_CANARY");
  v.close();
  open.pop();

  const raw = readFileSync(join(dir, "vault.db"));
  expect(raw.includes(Buffer.from("PLAINTEXT_CANARY"))).toBe(false);
  // The key name is metadata and is expected to be searchable.
  expect(raw.includes(Buffer.from("K"))).toBe(true);
});

test("a wrong data key cannot read existing secrets", () => {
  const dir = tempDir();
  const v1 = vaultIn(dir, generateDataKey());
  v1.setSecret({ scope: "global", key: "K" }, "secret");
  v1.close();
  open.pop();

  const v2 = vaultIn(dir, generateDataKey());
  expect(() => v2.getSecret({ scope: "global", key: "K" })).toThrow();
});

test("listSecrets filters by scope and never returns values", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  // These fixture values are deliberately non-numeric strings, not "1" / "2" —
  // a bare digit can appear inside the row's `updatedAt` (Date.now()) timestamp
  // by coincidence, which would make the leak check below pass for the wrong
  // reason. Do not "simplify" these back to short numeric strings.
  v.setSecret({ scope: "global", key: "A" }, "value-alpha");
  v.setSecret({ scope: "app", key: "B" }, "value-beta");

  const all = v.listSecrets();
  expect(all.length).toBe(2);
  expect(JSON.stringify(all)).not.toContain("value-alpha");
  expect(JSON.stringify(all)).not.toContain("value-beta");

  expect(v.listSecrets("app").map((s) => s.key)).toEqual(["B"]);
});

test("removeSecret reports whether a row was deleted", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.setSecret({ scope: "global", key: "K" }, "v");
  expect(v.removeSecret({ scope: "global", key: "K" })).toBe(true);
  expect(v.removeSecret({ scope: "global", key: "K" })).toBe(false);
  expect(v.getSecret({ scope: "global", key: "K" })).toBeNull();
});

test("projects register idempotently and update their path", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.registerProject("my-app", "/tmp/a");
  v.registerProject("my-app", "/tmp/b");
  const projects = v.listProjects();
  expect(projects.length).toBe(1);
  expect(projects[0]!.rootPath).toBe("/tmp/b");
});

test("audit entries are stored newest-first and hold no values", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.appendAudit({ ts: 1, event: "resolve", scope: "global", key: "A", pid: 10, processName: "node" });
  v.appendAudit({ ts: 2, event: "resolve", scope: "global", key: "B", pid: 11, processName: "bun" });

  const entries = v.listAudit(10);
  expect(entries.map((e) => e.key)).toEqual(["B", "A"]);
  expect(v.listAudit(1).length).toBe(1);
});

test("reopening an existing vault does not re-run migrations destructively", () => {
  const dir = tempDir();
  const key = generateDataKey();
  const v1 = vaultIn(dir, key);
  v1.setSecret({ scope: "global", key: "K" }, "persisted");
  v1.close();
  open.pop();

  const v2 = vaultIn(dir, key);
  expect(v2.getSecret({ scope: "global", key: "K" })).toBe("persisted");

  const db = new Database(join(dir, "vault.db"), { readonly: true });
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  expect(row?.user_version).toBe(SCHEMA_VERSION);
  db.close();
});

test("a vault stranded at the wrong file mode repairs itself on reopen", () => {
  const dir = tempDir();
  const file = join(dir, "vault.db");
  const key = generateDataKey();

  const v1 = vaultIn(dir, key);
  v1.setSecret({ scope: "global", key: "K" }, "v");
  v1.close();
  open.pop();

  // Simulate a vault stranded at the umask default by an earlier crash
  // (a process killed between file creation and the chmod that follows it).
  chmodSync(file, 0o644);

  const v2 = vaultIn(dir, key);
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
  expect(v2.getSecret({ scope: "global", key: "K" })).toBe("v");
});

// --- vault_meta: the vault knows which key it belongs to (Finding 2) --------

test("a fresh vault records its keychain backend and a key check", () => {
  const dir = tempDir();
  const key = generateDataKey();
  const v = vaultIn(dir, key);

  // openVault itself records nothing -- openContext does, because it is the
  // only caller that knows which backend the key came from. What openVault
  // must provide is the storage.
  expect(v.getMeta(META_KEYCHAIN_BACKEND)).toBeNull();
  v.setMeta(META_KEYCHAIN_BACKEND, "macos");
  v.setMeta(META_KEY_CHECK, sealKeyCheck(key));

  expect(v.getMeta(META_KEYCHAIN_BACKEND)).toBe("macos");
  expect(readVaultMeta(join(dir, "vault.db"))[META_KEYCHAIN_BACKEND]).toBe("macos");
});

test("the key check verifies the right key and rejects a wrong one", () => {
  const right = generateDataKey();
  const wrong = generateDataKey();
  const sealed = sealKeyCheck(right);

  expect(verifyKeyCheck(sealed, right)).toBe(true);
  // This is the whole point: a wrong key is caught on a value that exists to
  // be a canary, before any actual secret is touched.
  expect(verifyKeyCheck(sealed, wrong)).toBe(false);
  // A truncated or malformed record is not evidence the key is right.
  expect(verifyKeyCheck("garbage", right)).toBe(false);
  expect(verifyKeyCheck("", right)).toBe(false);
});

test("the key check never stores the data key or the constant in the clear", () => {
  const key = generateDataKey();
  const sealed = sealKeyCheck(key);
  expect(sealed).not.toContain(key.toString("base64"));
  expect(sealed).not.toContain("kerstel/key-check");
});

test("readVaultMeta answers empty for a missing vault and a v1 vault", () => {
  const dir = tempDir();
  // Nothing on disk at all.
  expect(readVaultMeta(join(dir, "vault.db"))).toEqual({});

  // A vault that predates the vault_meta table: "nothing recorded", which the
  // caller must read as "establish a baseline", never as a mismatch.
  const file = join(dir, "legacy.db");
  const legacy = new Database(file, { create: true });
  legacy.exec("CREATE TABLE secrets (id INTEGER PRIMARY KEY)");
  legacy.close();
  expect(readVaultMeta(file)).toEqual({});
});

test("readVaultMeta does not create a vault file that was not there", () => {
  const dir = tempDir();
  const file = join(dir, "absent.db");
  readVaultMeta(file);
  expect(existsSync(file)).toBe(false);
});

// --- busy_timeout (Finding 3) ----------------------------------------------

test("a second writer waits for the first instead of failing with SQLITE_BUSY", async () => {
  const dir = tempDir();
  const key = generateDataKey();
  const file = join(dir, "vault.db");

  // Create and migrate the vault first, so the holder cannot race the
  // migration itself.
  const seed = vaultIn(dir, key);
  seed.setSecret({ scope: "global", key: "SEED" }, "seed");

  // The lock holder has to be a separate PROCESS, not a timer in this one.
  // setSecret() is synchronous: it blocks inside SQLite, so this thread's
  // event loop never turns and an in-process setTimeout that was meant to
  // release the lock could not fire until after the call it is supposed to
  // unblock had already finished. Verified -- the first version of this test
  // deadlocked for the full busy_timeout on exactly that.
  const holderScript = join(dir, "holder.ts");
  await Bun.write(
    holderScript,
    `import { Database } from "bun:sqlite";
     const db = new Database(${JSON.stringify(file)});
     db.exec("PRAGMA busy_timeout = 5000");
     db.exec("BEGIN IMMEDIATE");
     process.stdout.write("held\\n");
     await Bun.sleep(300);
     db.exec("COMMIT");
     db.close();`,
  );

  const holder = Bun.spawn([process.execPath, holderScript], { stdout: "pipe", stderr: "inherit" });
  // Wait for the child to actually own the write lock before racing it.
  const reader = holder.stdout.getReader();
  await reader.read();
  reader.releaseLock();

  const writer = vaultIn(dir, key);
  const started = Date.now();
  // Without PRAGMA busy_timeout in migrate() this throws SQLITE_BUSY
  // immediately (measured at ~0ms); with it, it waits out the holder.
  writer.setSecret({ scope: "global", key: "CONCURRENT" }, "written-after-waiting");
  const waited = Date.now() - started;

  await holder.exited;

  expect(writer.getSecret({ scope: "global", key: "CONCURRENT" })).toBe("written-after-waiting");
  // It really did block on the holder rather than finding the lock free.
  expect(waited).toBeGreaterThanOrEqual(100);
});
