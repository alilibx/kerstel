import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandExists, resolveHelper, run, trustedPath } from "../src/vault/keychain/exec";

const originalPath = process.env.PATH;
const created: string[] = [];

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

test.if(process.platform !== "win32")("a helper that exists only on the caller's PATH is never used", async () => {
  const dir = shadowDir("kerstel-fake-helper");
  process.env.PATH = `${dir}:${process.env.PATH}`;

  // The shadow would win a naive lookup; that is the attack.
  expect(Bun.which("kerstel-fake-helper", { PATH: process.env.PATH })).toBe(join(dir, "kerstel-fake-helper"));

  expect(resolveHelper("kerstel-fake-helper")).toBeNull();
  expect(await commandExists("kerstel-fake-helper")).toBe(false);
  await expect(run(["kerstel-fake-helper"])).rejects.toThrow(/kerstel-fake-helper/);
});

test.if(process.platform !== "win32")("the trusted search path holds only system directories", () => {
  for (const dir of trustedPath().split(":")) {
    expect(dir.startsWith("/")).toBe(true);
    expect(dir).not.toContain("node_modules");
    expect(dir.startsWith(tmpdir())).toBe(false);
  }
});

test.if(process.platform === "darwin")("security resolves to /usr/bin even when a shadow comes first on PATH", async () => {
  const dir = shadowDir("security");
  process.env.PATH = `${dir}:${process.env.PATH}`;

  expect(resolveHelper("security")).toBe("/usr/bin/security");
  expect(await commandExists("security")).toBe(true);

  const res = await run(["security", "help"]);
  expect(res.stdout + res.stderr).not.toContain("SHADOWED");
});

test("an absolute path is not accepted as a helper name", () => {
  expect(resolveHelper("/bin/sh")).toBeNull();
});
