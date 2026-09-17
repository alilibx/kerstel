import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHome, kerstelHome, socketPath, tokenPath, vaultPath } from "../src/paths";

const original = process.env.KERSTEL_HOME;
afterEach(() => {
  if (original === undefined) delete process.env.KERSTEL_HOME;
  else process.env.KERSTEL_HOME = original;
});

test("KERSTEL_HOME overrides the default home", () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-paths-"));
  process.env.KERSTEL_HOME = dir;
  expect(kerstelHome()).toBe(dir);
  expect(vaultPath()).toBe(join(dir, "vault.db"));
  expect(tokenPath()).toBe(join(dir, "session.token"));
});

test("the override is read per call, not cached at import", () => {
  const a = mkdtempSync(join(tmpdir(), "kerstel-a-"));
  const b = mkdtempSync(join(tmpdir(), "kerstel-b-"));
  process.env.KERSTEL_HOME = a;
  expect(kerstelHome()).toBe(a);
  process.env.KERSTEL_HOME = b;
  expect(kerstelHome()).toBe(b);
});

test("ensureHome creates the directory with 0700 permissions", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "kerstel-ensure-")), "home");
  process.env.KERSTEL_HOME = dir;
  ensureHome();
  const mode = statSync(dir).mode & 0o777;
  if (process.platform !== "win32") expect(mode).toBe(0o700);
});

test("socketPath uses a named pipe on Windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-sock-"));
  process.env.KERSTEL_HOME = dir;
  const p = socketPath();
  if (process.platform === "win32") expect(p.startsWith("\\\\.\\pipe\\")).toBe(true);
  else expect(p).toBe(join(dir, "kerstel.sock"));
});
