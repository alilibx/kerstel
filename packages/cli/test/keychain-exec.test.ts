import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandExists,
  resolveHelper,
  resolveHelperIn,
  run,
  trustedDirs,
  trustedPath,
} from "../src/vault/keychain/exec";

const originalPath = process.env.PATH;
const created: string[] = [];
const posix = process.platform !== "win32";
// Root owns everything it creates, so the ownership tests would pass for the
// wrong reason under sudo or in a root container.
const posixNonRoot = posix && process.getuid?.() !== 0;

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A directory holding an executable of the given name, the way `npm run`
 * prepends `node_modules/.bin` for a dependency that declares a `bin` entry.
 */
function shadowDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-shadow-"));
  created.push(dir);
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\necho SHADOWED\n");
  chmodSync(file, 0o755);
  return dir;
}

test.if(posix)("a helper that exists only on the caller's PATH is never used", async () => {
  const dir = shadowDir("kerstel-fake-helper");
  process.env.PATH = `${dir}:${process.env.PATH}`;

  // The shadow would win a naive lookup; that is the attack.
  expect(Bun.which("kerstel-fake-helper", { PATH: process.env.PATH })).toBe(join(dir, "kerstel-fake-helper"));

  expect(resolveHelper("kerstel-fake-helper")).toBeNull();
  expect(await commandExists("kerstel-fake-helper")).toBe(false);
  await expect(run(["kerstel-fake-helper"])).rejects.toThrow(/kerstel-fake-helper/);
});

test.if(posixNonRoot)("a directory the user owns is not trusted even when it is listed", () => {
  const dir = shadowDir("kerstel-fake-helper");
  // Same name, same executable bit, but the directory and file belong to the
  // test user rather than root: a chowned /usr/local/bin looks exactly like this.
  expect(resolveHelperIn("kerstel-fake-helper", [dir])).toBeNull();
  expect(resolveHelperIn("kerstel-fake-helper", [dir, "/bin"])).toBeNull();
});

test.if(posix)("the trusted directories are fixed system paths", () => {
  for (const dir of trustedDirs()) {
    expect(dir.startsWith("/")).toBe(true);
    expect(dir).not.toContain("node_modules");
    expect(dir.startsWith(tmpdir())).toBe(false);
  }
  expect(trustedPath()).toBe(trustedDirs().join(":"));
});

test.if(posix)("a system binary resolves to its trusted directory even when a shadow comes first on PATH", async () => {
  const dir = shadowDir("sh");
  process.env.PATH = `${dir}:${process.env.PATH}`;

  const resolved = resolveHelper("sh") ?? "(null)";
  expect(["/bin/sh", "/usr/bin/sh"]).toContain(resolved);

  const res = await run(["sh", "-c", "echo REAL"]);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("REAL");
  expect(res.stdout + res.stderr).not.toContain("SHADOWED");
});

test("the missing-helper error says how to recover", async () => {
  await expect(run(["kerstel-fake-helper"])).rejects.toThrow(/KERSTEL_KEYCHAIN_BACKEND=file/);
});

test.if(process.platform === "darwin")("security resolves to /usr/bin even when a shadow comes first on PATH", async () => {
  const dir = shadowDir("security");
  process.env.PATH = `${dir}:${process.env.PATH}`;

  expect(resolveHelper("security")).toBe("/usr/bin/security");
  expect(await commandExists("security")).toBe(true);

  const res = await run(["security", "help"]);
  expect(res.stdout + res.stderr).not.toContain("SHADOWED");
});

test("a path is not accepted as a helper name", () => {
  expect(resolveHelper("/bin/sh")).toBeNull();
  expect(resolveHelper("bin/sh")).toBeNull();
  expect(resolveHelper("")).toBeNull();
});
