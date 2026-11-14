import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { keyBelongsToHome, parseUninstallArgs, removeLinks, uninstallCommand } from "../src/commands/uninstall";
import { createBackup } from "../src/init/backup";
import { CancelledError, ScriptedPrompter, type Choice, type Prompter } from "../src/init/prompts";
import { readInstallRecord, writeInstallRecord, type InstallRecord } from "../src/sync/install-record";
import { manualCommand } from "../src/sync/installer";
import type { Host } from "../src/sync/remote";
import { cliName } from "../src/ui/cli-name";
import { VERSION } from "../src/version";
import { syncLockPath, tryLockSync } from "../src/sync/background";
import type { SyncTimer } from "../src/sync/timer";
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

const WIRED = '{\n  "name": "demo-app",\n  "scripts": {\n    "dev": "node .kerstel/exec.cjs -- next dev"\n  }\n}\n';
const NO_BINARY = { path: "/usr/local/bin/bun", compiled: false };

/** A home with one secret and one registered, wired project that uses it. */
async function setup(extra: { unusedSecret?: boolean } = {}): Promise<{ home: string; root: string }> {
  const home = isolateEnv({ prefix: "uninstall" });
  dirs.push(home);
  const root = mkdtempSync(join(tmpdir(), "kerstel-uninstall-app-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), WIRED);
  writeFileSync(join(root, ".env"), "API_KEY=ks:demo-app\n");

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
  expect(await uninstallCommand([], new ScriptedPrompter(["no"]), NO_BINARY)).toBe(0);
  expect(existsSync(home)).toBe(true);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_KEY=ks:demo-app\n");

  expect(await uninstallCommand([], new ScriptedPrompter(["yes"]), NO_BINARY)).toBe(0);
  expect(existsSync(home)).toBe(false);
});

test("a declined prompt leaves the home's file list byte-identical", async () => {
  const { home } = await setup();
  const before = readdirSync(home).sort();
  capture();
  expect(await uninstallCommand([], new ScriptedPrompter(["no"]), NO_BINARY)).toBe(0);
  // In particular: no hook/ directory and no session.token, which openContext()
  // would have created but a read-only vault open must not.
  expect(readdirSync(home).sort()).toEqual(before);
});

test("cancelling the final question exits 130 and changes nothing", async () => {
  const { home, root } = await setup();
  const before = readdirSync(home).sort();
  const cancelling: Prompter = {
    select: () => {
      throw new CancelledError();
    },
    multiselect: () => {
      throw new CancelledError();
    },
    text: () => {
      throw new CancelledError();
    },
  };
  capture();
  expect(await uninstallCommand([], cancelling, NO_BINARY)).toBe(130);
  expect(existsSync(home)).toBe(true);
  expect(readdirSync(home).sort()).toEqual(before);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_KEY=ks:demo-app\n");
});

test("removeLinks deletes a ks link next to the binary and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-ks-"));
  dirs.push(dir);
  const binary = join(dir, "kerstel");
  writeFileSync(binary, "bin");
  symlinkSync("kerstel", join(dir, "ks"));
  expect(removeLinks(binary, {})?.removed).toEqual([join(dir, "ks")]);
  expect(existsSync(join(dir, "ks"))).toBe(false);
  // The binary itself is the caller's to delete, after the links are gone.
  expect(existsSync(binary)).toBe(true);

  expect(removeLinks(binary, {})?.removed).toEqual([]);

  writeFileSync(join(dir, "ks"), "someone else's tool");
  expect(removeLinks(binary, {})?.removed).toEqual([]);
  expect(readFileSync(join(dir, "ks"), "utf8")).toBe("someone else's tool");

  rmSync(join(dir, "ks"));
  writeFileSync(join(dir, "other"), "x");
  symlinkSync("other", join(dir, "ks"));
  expect(removeLinks(binary, {})?.removed).toEqual([]);

  rmSync(join(dir, "ks"));
  symlinkSync("gone", join(dir, "ks"));
  expect(removeLinks(binary, {})?.removed).toEqual([]);

  // A binary that is not there has no links worth resolving.
  expect(removeLinks(join(dir, "missing"), {})).toBeNull();
});

test("removeLinks follows a kerstel symlink on PATH to the ks beside it", () => {
  // The install.sh layout when the binary lives elsewhere and PATH holds a
  // link to it: ~/.local/bin/kerstel -> /opt/kerstel/kerstel, and
  // ~/.local/bin/ks -> kerstel. Bun reports the RESOLVED binary in
  // process.execPath, so the folder with the links is not the binary's own.
  const dir = mkdtempSync(join(tmpdir(), "kerstel-links-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const links = join(dir, "links");
  const other = join(dir, "other");
  for (const d of [bin, links, other]) mkdirSync(d);
  const binary = join(bin, "kerstel");
  writeFileSync(binary, "bin");
  symlinkSync(binary, join(links, "kerstel"));
  symlinkSync("kerstel", join(links, "ks"));
  writeFileSync(join(other, "ks"), "someone else's tool");
  writeFileSync(join(other, "kerstel"), "someone else's kerstel");

  const sweep = removeLinks(binary, { pathDirs: [links, other, join(dir, "missing")] });
  expect(sweep?.removed.sort()).toEqual([join(links, "kerstel"), join(links, "ks")].sort());
  expect(sweep?.failed).toEqual([]);
  expect(sweep?.target).toBe(realpathSync(binary));
  expect(existsSync(join(links, "ks"))).toBe(false);
  expect(existsSync(join(links, "kerstel"))).toBe(false);
  expect(existsSync(binary)).toBe(true);
  expect(readFileSync(join(other, "ks"), "utf8")).toBe("someone else's tool");
  expect(readFileSync(join(other, "kerstel"), "utf8")).toBe("someone else's kerstel");
});

test("removeLinks scans a folder once however many ways PATH names it", () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-dup-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const binary = join(bin, "kerstel");
  writeFileSync(binary, "bin");
  symlinkSync("kerstel", join(bin, "ks"));
  // The same folder as the binary's own, with a trailing slash, through a
  // symlinked alias, and via `..`: one scan, one removal, no false failure.
  const alias = join(dir, "alias");
  symlinkSync(bin, alias);
  const sweep = removeLinks(binary, { pathDirs: [`${bin}/`, alias, join(bin, "..", "bin")] });
  expect(sweep?.removed).toEqual([join(bin, "ks")]);
  expect(sweep?.failed).toEqual([]);
});

test("removeLinks searches the folder the binary was invoked from, even off PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-argv0-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const links = join(dir, "links");
  for (const d of [bin, links]) mkdirSync(d);
  const binary = join(bin, "kerstel");
  writeFileSync(binary, "bin");
  symlinkSync(binary, join(links, "kerstel"));
  symlinkSync("kerstel", join(links, "ks"));

  const removed = removeLinks(binary, { invokedAs: join(links, "ks"), pathDirs: [] })?.removed;
  expect(removed?.sort()).toEqual([join(links, "kerstel"), join(links, "ks")].sort());

  // Invoked by a RELATIVE path (`./links/ks`): resolved against the cwd. A
  // bare `ks`, found through PATH, names no folder and is ignored.
  symlinkSync(binary, join(links, "kerstel"));
  symlinkSync("kerstel", join(links, "ks"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    expect(removeLinks(binary, { invokedAs: "ks", pathDirs: [] })?.removed).toEqual([]);
    expect(removeLinks(binary, { invokedAs: join("links", "ks"), pathDirs: [] })?.removed.length).toBe(2);
  } finally {
    process.chdir(cwd);
  }
});

test("a link that cannot be deleted is reported, and uninstall still finishes", async () => {
  const { home } = await setup();
  const fake = join(home, "..", `kerstel-fake-bin-${Date.now()}`);
  writeFileSync(fake, "binary");
  dirs.push(fake);
  const locked = mkdtempSync(join(tmpdir(), "kerstel-locked-links-"));
  dirs.push(locked);
  symlinkSync(fake, join(locked, "kerstel"));
  symlinkSync("kerstel", join(locked, "ks"));
  chmodSync(locked, 0o555);
  try {
    capture();
    expect(await uninstallCommand(["--yes"], undefined, { path: fake, compiled: true, pathDirs: [locked] })).toBe(0);
    expect(existsSync(fake)).toBe(false);
    // existsSync follows the link, which now dangles; lstat sees the link itself.
    expect(lstatSync(join(locked, "ks")).isSymbolicLink()).toBe(true);
    const text = output.join("\n");
    expect(text).toContain(`Could not remove ${join(locked, "ks")}`);
    expect(text).toContain("delete it by hand");
  } finally {
    chmodSync(locked, 0o755);
  }
});

test("a binary path that is itself a link removes the real binary too", async () => {
  const { home } = await setup();
  const real = join(home, "..", `kerstel-real-bin-${Date.now()}`);
  writeFileSync(real, "binary");
  dirs.push(real);
  const links = mkdtempSync(join(tmpdir(), "kerstel-linked-bin-"));
  dirs.push(links);
  symlinkSync(real, join(links, "kerstel"));
  capture();
  expect(await uninstallCommand(["--yes"], undefined, { path: join(links, "kerstel"), compiled: true, pathDirs: [] })).toBe(0);
  expect(existsSync(join(links, "kerstel"))).toBe(false);
  expect(existsSync(real)).toBe(false);
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
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_KEY=ks:demo-app\n");
  expect(output.join("\n")).toContain("ks:global/ORPHAN");
});

test("a possible loss refuses without --force, even with --yes", async () => {
  const { home } = await setup({ unusedSecret: true });
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(1);
  expect(existsSync(home)).toBe(true);
  const text = output.join("\n");
  expect(text).toContain("ks:global/ORPHAN");
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
  const links = mkdtempSync(join(tmpdir(), "kerstel-fake-links-"));
  dirs.push(links);
  symlinkSync(fake, join(links, "kerstel"));
  symlinkSync("kerstel", join(links, "ks"));
  capture();
  expect(await uninstallCommand(["--yes"], undefined, { path: fake, compiled: true, pathDirs: [links] })).toBe(0);
  expect(existsSync(fake)).toBe(false);
  expect(existsSync(join(links, "kerstel"))).toBe(false);
  expect(existsSync(join(links, "ks"))).toBe(false);
  expect(output.join("\n")).toContain(`Removed ${join(links, "ks")}`);

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
  expect(text).toContain("Values kept only in an encrypted backup of init or");
  expect(text).toContain("demo-app: API_KEY in .env");
  expect(text).not.toContain("first-backup-only");

  expect(await uninstallCommand(["--yes", "--force"], undefined, NO_BINARY)).toBe(0);
  expect(existsSync(home)).toBe(false);
});

test("a value only a move backup's vault section holds trips the gate until --force, named by key", async () => {
  const { home } = await setup();
  const { key } = await loadOrCreateDataKey();
  createBackup({
    scope: "demo-app",
    dataKey: key,
    files: [{ name: ".env", contents: "API_KEY=ks:demo-app\n" }],
    vault: [{ scope: "global", key: "OLD_TOKEN", value: "move-backup-only" }],
  });
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(1);
  expect(existsSync(home)).toBe(true);
  const text = output.join("\n");
  expect(text).toContain("Values kept only in an encrypted backup of init or");
  expect(text).toContain("demo-app: OLD_TOKEN in vault.enc");
  expect(text).not.toContain("move-backup-only");

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

function fakeTimer(installed: boolean): SyncTimer & { removed: number } {
  const t = {
    removed: 0,
    status: () => (installed ? ({ state: "installed", kind: "launchd", current: true } as const) : ({ state: "missing", kind: "launchd" } as const)),
    ensure: () => "unchanged" as const,
    remove() {
      t.removed++;
      return true;
    },
  };
  return t;
}

test("uninstall removes the timer", async () => {
  const { home } = await setup();
  const timer = fakeTimer(true);
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY, { timer })).toBe(0);
  expect(timer.removed).toBe(1);
  expect(existsSync(home)).toBe(false);
  expect(output.join("\n")).toContain("Removes the scheduled sync pull.");
});

test("uninstall removes the timer holding the sync lock", async () => {
  // A background sync schedules pulls only under the lock: removing the timer
  // outside it could let that sync bring the timer back.
  const { home } = await setup();
  const lockFree: boolean[] = [];
  const timer: SyncTimer = {
    status: () => ({ state: "installed", kind: "launchd", current: true }),
    ensure: () => "unchanged",
    remove: () => {
      const release = tryLockSync(syncLockPath(join(home, "vault.db")));
      lockFree.push(release !== null);
      release?.();
      return true;
    },
  };
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY, { timer })).toBe(0);
  expect(lockFree).toEqual([false]);
  expect(existsSync(home)).toBe(false);
});

test("uninstall removes the timer anyway when the sync lock stays taken", async () => {
  const { home } = await setup();
  const timer = fakeTimer(true);
  const held = tryLockSync(syncLockPath(join(home, "vault.db")))!;
  expect(held).not.toBeNull();
  try {
    capture();
    const started = Date.now();
    expect(await uninstallCommand(["--yes"], undefined, NO_BINARY, { timer, lockWaitMs: 300 })).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(timer.removed).toBe(1);
    expect(existsSync(home)).toBe(false);
  } finally {
    try {
      held();
    } catch {
      // Its file went with the home: the close after the failed commit still frees it.
    }
  }
});

test("a timer that throws on removal never stops the uninstall", async () => {
  const { home } = await setup();
  const timer: SyncTimer = { status: () => ({ state: "installed", kind: "launchd", current: true }), ensure: () => "unchanged", remove: () => { throw new Error("boom"); } };
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY, { timer })).toBe(0);
  expect(existsSync(home)).toBe(false);
});

test("dry run keeps the timer", async () => {
  const { home } = await setup();
  const timer = fakeTimer(true);
  capture();
  expect(await uninstallCommand(["--dry-run"], undefined, NO_BINARY, { timer })).toBe(0);
  expect(timer.removed).toBe(0);
  expect(existsSync(home)).toBe(true);
  expect(output.join("\n")).toContain("Removes the scheduled sync pull.");
});

describe("the sync server this device installed", () => {
  const QUESTION = "Also remove the sync server on ali@homebox? Other devices may still use it.";
  const MANAGE = `The server keeps running. To manage it from another device: ${cliName()} sync server manage ali@homebox`;
  const serverRecord = (o: Partial<InstallRecord> = {}): InstallRecord => ({
    installId: "install-id-1",
    route: "ssh",
    host: "ali@homebox",
    runtime: "docker",
    reach: "self",
    addresses: ["https://192.168.1.20:8787"],
    version: "0.0.1",
    finished: true,
    ...o,
  });

  /** A host whose installer exits with `code`; it keeps every command it was asked to run. */
  function fakeHost(code = 0) {
    const calls: { route: string; target: string | null; args: string[] }[] = [];
    const hostFor = (route: "ssh" | "local", target: string | null): Host => ({
      label: target ?? "this machine",
      async run(args) {
        calls.push({ route, target, args });
        return { code, lines: [], value: null };
      },
    });
    return { calls, hostFor };
  }

  /** Answers each question in turn, and keeps every question with its default. */
  class Recorder extends ScriptedPrompter {
    readonly defaults = new Map<string, string>();
    override async select<T extends string>(question: string, choices: Choice<T>[], d: T): Promise<T> {
      this.defaults.set(question, d);
      return super.select(question, choices, d);
    }
  }

  test("--dry-run only lists the question", async () => {
    const { home } = await setup();
    writeInstallRecord(serverRecord(), home);
    const host = fakeHost();
    capture();
    expect(await uninstallCommand(["--dry-run"], undefined, NO_BINARY, { timer: fakeTimer(false), hostFor: host.hostFor })).toBe(0);
    expect(output.join("\n")).toContain("Asks whether to also remove the sync server on ali@homebox.");
    expect(host.calls).toEqual([]);
    expect(readInstallRecord(home)).not.toBeNull();
  });

  test("Yes removes the server and keeps its database; the question defaults to No", async () => {
    const { home } = await setup();
    writeInstallRecord(serverRecord(), home);
    const host = fakeHost();
    const prompter = new Recorder(["yes", "yes"]);
    capture();
    expect(await uninstallCommand([], prompter, NO_BINARY, { timer: fakeTimer(false), hostFor: host.hostFor })).toBe(0);
    expect(prompter.asked[1]).toBe(QUESTION);
    expect(prompter.defaults.get(QUESTION)).toBe("no");
    expect(host.calls).toEqual([{ route: "ssh", target: "ali@homebox", args: ["remove", "--install-id", "install-id-1"] }]);
    expect(output.join("\n")).toContain("Removed the server from ali@homebox. Its database stays on the host.");
    expect(existsSync(home)).toBe(false);
  });

  test("No leaves the server running and names manage", async () => {
    const { home } = await setup();
    writeInstallRecord(serverRecord(), home);
    const host = fakeHost();
    capture();
    expect(await uninstallCommand([], new ScriptedPrompter(["yes", "no"]), NO_BINARY, { timer: fakeTimer(false), hostFor: host.hostFor })).toBe(0);
    expect(host.calls).toEqual([]);
    expect(output.join("\n")).toContain(MANAGE);
    expect(existsSync(home)).toBe(false);
  });

  test("--yes never removes the server", async () => {
    const { home } = await setup();
    writeInstallRecord(serverRecord(), home);
    const host = fakeHost();
    capture();
    expect(await uninstallCommand(["--yes"], undefined, NO_BINARY, { timer: fakeTimer(false), hostFor: host.hostFor })).toBe(0);
    expect(host.calls).toEqual([]);
    expect(output.join("\n")).toContain(MANAGE);
  });

  test("a removal that fails never stops the uninstall", async () => {
    const { home } = await setup();
    writeInstallRecord(serverRecord(), home);
    const host = fakeHost(1);
    capture();
    expect(await uninstallCommand([], new ScriptedPrompter(["yes", "yes"]), NO_BINARY, { timer: fakeTimer(false), hostFor: host.hostFor })).toBe(0);
    expect(host.calls).toHaveLength(1);
    const out = output.join("\n");
    expect(out).toContain("The server on ali@homebox was not removed.");
    expect(out).toContain(MANAGE);
    expect(existsSync(home)).toBe(false);
  });

  test("a server on this machine or installed by hand names manage with a placeholder", async () => {
    for (const r of [serverRecord({ route: "local", host: null }), serverRecord({ route: "manual", host: null })]) {
      const { home } = await setup();
      writeInstallRecord(r, home);
      capture();
      expect(await uninstallCommand(["--yes"], undefined, NO_BINARY, { timer: fakeTimer(false), hostFor: fakeHost().hostFor })).toBe(0);
      expect(output.join("\n")).toContain(`To manage it from another device: ${cliName()} sync server manage <ssh-host>`);
    }
  });

  test("Yes on a server installed by hand prints the command that removes it and keeps its database", async () => {
    const { home } = await setup();
    writeInstallRecord(serverRecord({ route: "manual", host: null }), home);
    const host = fakeHost();
    const prompter = new ScriptedPrompter(["yes", "yes"]);
    capture();
    expect(await uninstallCommand([], prompter, NO_BINARY, { timer: fakeTimer(false), hostFor: host.hostFor })).toBe(0);
    expect(prompter.asked[1]).toBe("Also remove the sync server on 192.168.1.20? Other devices may still use it.");
    expect(host.calls).toEqual([]);
    expect(output.join("\n")).toContain("keeps its database");
    expect(output.join("\n")).toContain(manualCommand({ version: VERSION, args: ["remove", "--install-id", "install-id-1"] }));
    // It keeps running until that command runs there.
    expect(output.join("\n")).toContain(`To manage it from another device: ${cliName()} sync server manage <ssh-host>`);
  });

  test("a host that runs another device's server is left alone", async () => {
    const { home } = await setup();
    writeInstallRecord(serverRecord(), home);
    const host = fakeHost(3);
    capture();
    expect(await uninstallCommand([], new ScriptedPrompter(["yes", "yes"]), NO_BINARY, { timer: fakeTimer(false), hostFor: host.hostFor })).toBe(0);
    const out = output.join("\n");
    expect(out).toContain("ali@homebox runs a Kerstel server that another device set up, not the one this device did. Nothing was changed there.");
    expect(out).toContain(MANAGE);
    expect(existsSync(home)).toBe(false);
  });

  test("no record, no question", async () => {
    await setup();
    const prompter = new ScriptedPrompter(["yes"]);
    capture();
    expect(await uninstallCommand([], prompter, NO_BINARY, { timer: fakeTimer(false) })).toBe(0);
    expect(prompter.asked).toHaveLength(1);
    expect(output.join("\n")).not.toContain("sync server");
  });
});
