import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readToken, writeToken } from "../src/daemon/token";
import { ensureHome, kerstelHome, socketPath, tokenPath, vaultPath } from "../src/paths";
import { restoreEnv } from "./helpers/isolate-env";

afterEach(restoreEnv);

test("KERSTEL_HOME overrides the default home", () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-paths-"));
  process.env.KERSTEL_HOME = dir;
  expect(kerstelHome()).toBe(dir);
  expect(vaultPath()).toBe(join(dir, "vault.db"));
  expect(tokenPath()).toBe(join(dir, "session.token"));
});

test("a relative override names one directory regardless of the working directory", () => {
  // Processes do not share a cwd: the daemon is started in the home directory,
  // so a relative override left unresolved would have it open a different home
  // from the CLI and bind its socket where no client looks.
  const dir = mkdtempSync(join(tmpdir(), "kerstel-relhome-"));
  const originalCwd = process.cwd();
  process.env.KERSTEL_HOME = ".kerstel-data";
  try {
    process.chdir(dir);
    const fromHere = kerstelHome();
    expect(fromHere).toBe(join(realpathSync(dir), ".kerstel-data"));
    process.chdir(tmpdir());
    // Same answer from somewhere else entirely would be wrong; what matters is
    // that it is absolute, so every process resolves it the same way.
    expect(kerstelHome().startsWith("/")).toBe(true);
    expect(socketPath()).toBe(join(kerstelHome(), "kerstel.sock"));
  } finally {
    process.chdir(originalCwd);
  }
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

test("ensureHome re-asserts 0700 on a home that was left loose", () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-relax-"));
  process.env.KERSTEL_HOME = dir;

  // A home created under a permissive umask, or by hand. mkdirSync's `mode`
  // would not touch it -- it applies only when it creates the directory -- so
  // without the explicit chmod this stays world-readable forever, and with it
  // every "0600 inside a 0700 home" claim Kerstel makes.
  if (process.platform === "win32") return;
  chmodSync(dir, 0o755);
  expect(statSync(dir).mode & 0o777).toBe(0o755);

  ensureHome();
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test("readToken re-asserts 0600 on a token left group- or world-readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-token-"));
  process.env.KERSTEL_HOME = dir;
  if (process.platform === "win32") return;

  writeToken("a-session-token-value");
  chmodSync(tokenPath(), 0o644);
  expect(statSync(tokenPath()).mode & 0o777).toBe(0o644);

  // This token IS the access boundary: anyone who can read it can ask the
  // daemon for every secret in the vault.
  expect(readToken()).toBe("a-session-token-value");
  expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
});
