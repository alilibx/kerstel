import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateDataKey, selectBackend } from "../src/vault/keychain";

const originalHome = process.env.KERSTEL_HOME;
const originalBackend = process.env.KERSTEL_KEYCHAIN_BACKEND;

function isolate(): string {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-kc-"));
  process.env.KERSTEL_HOME = dir;
  process.env.KERSTEL_KEYCHAIN_BACKEND = "file";
  return dir;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.KERSTEL_HOME;
  else process.env.KERSTEL_HOME = originalHome;
  if (originalBackend === undefined) delete process.env.KERSTEL_KEYCHAIN_BACKEND;
  else process.env.KERSTEL_KEYCHAIN_BACKEND = originalBackend;
});

test("the file backend round-trips a key", async () => {
  isolate();
  const backend = await selectBackend();
  expect(backend.name).toBe("file");
  expect(await backend.get()).toBeNull();

  const key = Buffer.alloc(32, 7);
  await backend.set(key);
  const loaded = await backend.get();
  expect(loaded?.equals(key)).toBe(true);

  await backend.delete();
  expect(await backend.get()).toBeNull();
});

test("the file backend writes the key file 0600", async () => {
  const dir = isolate();
  const backend = await selectBackend();
  await backend.set(Buffer.alloc(32, 1));
  if (process.platform !== "win32") {
    expect(statSync(join(dir, "vault.key")).mode & 0o777).toBe(0o600);
  }
});

test("loadOrCreateDataKey creates once and is stable afterwards", async () => {
  isolate();
  const first = await loadOrCreateDataKey();
  expect(first.created).toBe(true);
  expect(first.key.length).toBe(32);

  const second = await loadOrCreateDataKey();
  expect(second.created).toBe(false);
  expect(second.key.equals(first.key)).toBe(true);
});

test("KERSTEL_KEYCHAIN_BACKEND selects the backend explicitly", async () => {
  isolate();
  process.env.KERSTEL_KEYCHAIN_BACKEND = "file";
  expect((await selectBackend()).name).toBe("file");
});

test.if(process.platform === "darwin")("the macOS Keychain backend round-trips", async () => {
  isolate();
  process.env.KERSTEL_KEYCHAIN_BACKEND = "macos";
  const backend = await selectBackend();
  expect(backend.name).toBe("macos");
  const key = Buffer.alloc(32, 42);
  await backend.set(key);
  expect((await backend.get())?.equals(key)).toBe(true);
  await backend.delete();
  expect(await backend.get()).toBeNull();
});
