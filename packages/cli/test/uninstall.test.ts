import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { keyBelongsToHome, parseUninstallArgs, uninstallCommand } from "../src/commands/uninstall";
import { createBackup } from "../src/init/backup";
import { ScriptedPrompter } from "../src/init/prompts";
import { loadOrCreateDataKey, selectBackend } from "../src/vault/keychain";
import { fileBackend } from "../src/vault/keychain/file";
import { openVault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

const dirs: string[] = [];
const realLog = console.log;
let output: string[] = [];

afterEach(() => {
  console.log = realLog;
  restoreEnv();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function capture(): void {
  output = [];
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
}

const WIRED = '{\n  "name": "demo-app",\n  "scripts": {\n    "dev": "kerstel exec -- next dev"\n  }\n}\n';
const NO_BINARY = { path: "/usr/local/bin/bun", compiled: false };

/** A home with one secret and one registered, wired project that uses it. */
async function setup(extra: { unusedSecret?: boolean } = {}): Promise<{ home: string; root: string }> {
  const home = isolateEnv({ prefix: "uninstall" });
  dirs.push(home);
  const root = mkdtempSync(join(tmpdir(), "kerstel-uninstall-app-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), WIRED);
  writeFileSync(join(root, ".env"), "API_KEY=kerstel://demo-app/API_KEY\n");

  const { key } = await loadOrCreateDataKey();
  const vault = openVault(key);
  vault.setSecret({ scope: "demo-app", key: "API_KEY" }, "sk-restored");
  if (extra.unusedSecret) vault.setSecret({ scope: "global", key: "ORPHAN" }, "orphan-value");
  vault.registerProject("demo-app", root);
  vault.close();
  return { home, root };
}

test("parseUninstallArgs reads the three flags and rejects others", () => {
  expect(parseUninstallArgs(["--dry-run", "--yes", "--force"])).toEqual({ dryRun: true, yes: true, force: true });
  expect(parseUninstallArgs(["--nope"])).toEqual({ error: expect.stringContaining("--nope") as unknown as string });
});

test("--yes restores the project and deletes all Kerstel data", async () => {
  const { home, root } = await setup();
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(0);

  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_KEY=sk-restored\n");
  expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"dev": "next dev"');
  expect(existsSync(home)).toBe(false);
  expect(output.join("\n")).not.toContain("sk-restored");
});

test("an interactive yes applies; the default no changes nothing", async () => {
  const { home, root } = await setup();
  capture();
  expect(await uninstallCommand([], new ScriptedPrompter([false]), NO_BINARY)).toBe(0);
  expect(existsSync(home)).toBe(true);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_KEY=kerstel://demo-app/API_KEY\n");

  expect(await uninstallCommand([], new ScriptedPrompter([true]), NO_BINARY)).toBe(0);
  expect(existsSync(home)).toBe(false);
});

test("a declined prompt leaves the home's file list byte-identical", async () => {
  const { home } = await setup();
  const before = readdirSync(home).sort();
  capture();
  expect(await uninstallCommand([], new ScriptedPrompter([false]), NO_BINARY)).toBe(0);
  // In particular: no hook/ directory and no session.token, which openContext()
  // would have created but a read-only vault open must not.
  expect(readdirSync(home).sort()).toEqual(before);
});

test("--dry-run creates nothing when no vault exists yet", async () => {
  const home = isolateEnv({ prefix: "uninstall-empty" });
  dirs.push(home);
  const neverCreated = join(home, "never-created");
  process.env.KERSTEL_HOME = neverCreated;
  capture();
  expect(await uninstallCommand(["--dry-run"], undefined, NO_BINARY)).toBe(0);
  expect(existsSync(neverCreated)).toBe(false);
});

test("--dry-run writes nothing and exits 0 even when something would be lost", async () => {
  const { home, root } = await setup({ unusedSecret: true });
  capture();
  expect(await uninstallCommand(["--dry-run"], undefined, NO_BINARY)).toBe(0);
  expect(existsSync(home)).toBe(true);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_KEY=kerstel://demo-app/API_KEY\n");
  expect(output.join("\n")).toContain("kerstel://global/ORPHAN");
});

test("a possible loss refuses without --force, even with --yes", async () => {
  const { home } = await setup({ unusedSecret: true });
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(1);
  expect(existsSync(home)).toBe(true);
  const text = output.join("\n");
  expect(text).toContain("kerstel://global/ORPHAN");
  expect(text).toContain("--reveal");
  expect(text).not.toContain("orphan-value");

  expect(await uninstallCommand(["--yes", "--force"], undefined, NO_BINARY)).toBe(0);
  expect(existsSync(home)).toBe(false);
});

test("without a terminal and without --yes it exits 2", async () => {
  const { home } = await setup();
  capture();
  expect(await uninstallCommand([], undefined, NO_BINARY)).toBe(2);
  expect(existsSync(home)).toBe(true);
});

test("a failed write deletes nothing", async () => {
  const { home, root } = await setup();
  // A read-only file refuses the write; its folder stays writable, so cleanup can still remove it.
  chmodSync(join(root, ".env"), 0o444);
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(1);
  expect(existsSync(home)).toBe(true);
  expect(output.join("\n")).toContain(join(root, ".env"));
  // The writability pre-check runs before any file is touched, so package.json
  // -- which was perfectly writable -- proves nothing was written either.
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(WIRED);
});

test("the compiled binary removes itself; a source run leaves the runtime alone", async () => {
  const { home } = await setup();
  const fake = join(home, "..", `kerstel-fake-bin-${Date.now()}`);
  writeFileSync(fake, "binary");
  dirs.push(fake);
  capture();
  expect(await uninstallCommand(["--yes"], undefined, { path: fake, compiled: true })).toBe(0);
  expect(existsSync(fake)).toBe(false);

  const again = await setup();
  const runtime = join(again.home, "..", `kerstel-fake-bun-${Date.now()}`);
  writeFileSync(runtime, "bun");
  dirs.push(runtime);
  expect(await uninstallCommand(["--yes"], undefined, { path: runtime, compiled: false })).toBe(0);
  expect(existsSync(runtime)).toBe(true);
});

test("a value init kept only in its backup trips the gate until --force", async () => {
  const { home } = await setup();
  const { key } = await loadOrCreateDataKey();
  createBackup({
    scope: "demo-app",
    dataKey: key,
    files: [{ name: ".env", contents: "API_KEY=first-backup-only\nAPI_KEY=sk-restored\n" }],
  });
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(1);
  expect(existsSync(home)).toBe(true);
  const text = output.join("\n");
  expect(text).toContain("Values init kept only in its encrypted backup");
  expect(text).toContain("demo-app: API_KEY in .env");
  expect(text).not.toContain("first-backup-only");

  expect(await uninstallCommand(["--yes", "--force"], undefined, NO_BINARY)).toBe(0);
  expect(existsSync(home)).toBe(false);
});

test("a corrupt backup trips the gate, and --force gets past it", async () => {
  const { home, root } = await setup();
  const { key } = await loadOrCreateDataKey();
  const backup = createBackup({ scope: "demo-app", dataKey: key, files: [{ name: ".env", contents: "API_KEY=x\n" }] });
  writeFileSync(join(backup.dir, ".env.enc"), "not a ciphertext");
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(1);
  expect(existsSync(home)).toBe(true);
  expect(output.join("\n")).toContain("Backups Kerstel cannot read");

  expect(await uninstallCommand(["--yes", "--force"], undefined, NO_BINARY)).toBe(0);
  expect(existsSync(home)).toBe(false);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_KEY=sk-restored\n");
});

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

test("a restored .env that git tracks gets a git rm --cached warning naming it", async () => {
  const { root } = await setup();
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Kerstel Test");
  git(root, "config", "user.email", "test@kerstel.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", ".env", "package.json");
  git(root, "commit", "--quiet", "--no-verify", "-m", "references only");

  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(0);
  const text = output.join("\n");
  expect(text).toContain(`${join(root, ".env")} is tracked by git`);
  expect(text).toContain("git rm --cached .env");
});

test("a project outside any git repo gets only the generic warning", async () => {
  await setup();
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(0);
  const text = output.join("\n");
  expect(text).toContain("check your .gitignore");
  expect(text).not.toContain("git rm --cached");
});

test("with no vault, a real run deletes a key orphaned in the credential store", async () => {
  const home = isolateEnv({ prefix: "uninstall-orphan" });
  dirs.push(home);
  await loadOrCreateDataKey();
  const backend = await selectBackend();
  expect(await backend.exists()).toBe(true);

  capture();
  expect(await uninstallCommand(["--dry-run"], undefined, NO_BINARY)).toBe(0);
  expect(await backend.exists()).toBe(true);

  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(0);
  expect(await backend.exists()).toBe(false);
  expect(output.join("\n")).toContain("Deleted the orphaned vault key");
});

test("a key delete that silently fails is reported instead of claimed", async () => {
  const { home } = await setup();
  // The native backends ignore the delete tool's exit code, so a denied
  // Keychain prompt looks like success. Fake a key that survives the delete.
  const denied = spyOn(fileBackend, "delete").mockResolvedValue(undefined);
  const survives = spyOn(fileBackend, "exists").mockResolvedValue(true);
  capture();
  try {
    expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(1);
  } finally {
    denied.mockRestore();
    survives.mockRestore();
  }
  expect(existsSync(home)).toBe(false);
  expect(output.join("\n")).not.toContain("Deleted the vault key");
});

test("a native store's shared key belongs only to the default home", () => {
  const home = isolateEnv({ prefix: "uninstall-owner" });
  dirs.push(home);
  expect(keyBelongsToHome("file")).toBe(true);
  // isolateEnv rebinds the service name, which gives the key a slot of its own.
  expect(keyBelongsToHome("macos")).toBe(true);
  delete process.env.KERSTEL_KEYCHAIN_SERVICE;
  expect(keyBelongsToHome("macos")).toBe(false);
  expect(keyBelongsToHome("linux")).toBe(false);
  process.env.KERSTEL_HOME = join(homedir(), ".kerstel");
  expect(keyBelongsToHome("macos")).toBe(true);
});

test("under a custom home, a key in a shared native store is never treated as orphaned", async () => {
  const home = isolateEnv({ prefix: "uninstall-shared" });
  dirs.push(home);
  await loadOrCreateDataKey();
  delete process.env.KERSTEL_KEYCHAIN_SERVICE;
  // Stand in for a native backend, whose one key may belong to the real ~/.kerstel.
  const native = fileBackend as { name: string };
  native.name = "macos";
  const deleted = spyOn(fileBackend, "delete");
  capture();
  try {
    expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(0);
    expect(deleted).not.toHaveBeenCalled();
    expect(output.join("\n")).not.toContain("orphaned vault key");
  } finally {
    native.name = "file";
    deleted.mockRestore();
  }
});
