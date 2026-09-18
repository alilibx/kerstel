import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOrCreateDataKey,
  selectBackend,
  type KeychainBackend,
} from "../src/vault/keychain";

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
  // Start from a known-empty item: a leftover from an earlier run would now make
  // set() refuse rather than silently overwrite, which is the point of the fix.
  await backend.delete();
  try {
    await backend.set(key);
    expect((await backend.get())?.equals(key)).toBe(true);
  } finally {
    await backend.delete();
  }
  expect(await backend.get()).toBeNull();
});

// --- Never overwrite an existing stored key -------------------------------
//
// The item being protected is the vault's only data key. Losing it does not
// lock the user out temporarily; it makes every secret already in the vault
// undecryptable forever. Both layers below exist because of that asymmetry.

test("set refuses to overwrite an existing key and leaves it intact", async () => {
  isolate();
  const backend = await selectBackend();

  const original = Buffer.alloc(32, 7);
  await backend.set(original);

  const replacement = Buffer.alloc(32, 9);
  await expect(backend.set(replacement)).rejects.toThrow(/already stored|refus/i);

  // The bytes matter more than the throw: a failed set() that had already
  // truncated the file would be just as destructive as a successful one.
  expect((await backend.get())?.equals(original)).toBe(true);
});

test("set({ rotate: true }) replaces an existing key", async () => {
  isolate();
  const backend = await selectBackend();

  const original = Buffer.alloc(32, 7);
  await backend.set(original);

  const replacement = Buffer.alloc(32, 9);
  await backend.set(replacement, { rotate: true });
  expect((await backend.get())?.equals(replacement)).toBe(true);
});

test("exists() distinguishes stored-but-unreadable from absent", async () => {
  isolate();
  const backend = await selectBackend();
  expect(await backend.exists()).toBe(false);

  await backend.set(Buffer.alloc(32, 3));
  expect(await backend.exists()).toBe(true);

  await backend.delete();
  expect(await backend.exists()).toBe(false);
});

test("loadOrCreateDataKey refuses to create when a key is stored but unreadable", async () => {
  isolate();

  // This is the macOS "user clicked Deny" state, which no real backend can be
  // put into on demand: the item is there, the ACL refuses the read, so get()
  // reports null while exists() reports true. Before the fix this combination
  // read as "first run" and the generated key was written straight over the
  // real one.
  let setCalls = 0;
  const denied: KeychainBackend = {
    name: "macos",
    async isAvailable() {
      return true;
    },
    async get() {
      return null;
    },
    async exists() {
      return true;
    },
    async set() {
      setCalls += 1;
    },
    async delete() {},
  };

  await expect(loadOrCreateDataKey(denied)).rejects.toThrow(
    /could not read its vault key.*even though one is stored/is,
  );
  // The assertion that actually protects the vault.
  expect(setCalls).toBe(0);

  // The guidance has to be actionable, and must never carry key material.
  const message = await loadOrCreateDataKey(denied).then(
    () => "",
    (error: Error) => error.message,
  );
  expect(message).toContain("Always Allow");
  expect(message).toContain("kerstel doctor");
  expect(message).toContain("never overwrite");
});

test("loadOrCreateDataKey still creates when nothing is stored", async () => {
  isolate();

  let stored: Buffer | null = null;
  const empty: KeychainBackend = {
    name: "file",
    async isAvailable() {
      return true;
    },
    async get() {
      return stored;
    },
    async exists() {
      return stored !== null;
    },
    async set(key: Buffer) {
      stored = key;
    },
    async delete() {
      stored = null;
    },
  };

  const first = await loadOrCreateDataKey(empty);
  expect(first.created).toBe(true);
  expect(first.key.length).toBe(32);

  const second = await loadOrCreateDataKey(empty);
  expect(second.created).toBe(false);
  expect(second.key.equals(first.key)).toBe(true);
});

test.if(process.platform === "darwin")(
  "the macOS backend's exists() answers without reading the secret",
  async () => {
    isolate();
    process.env.KERSTEL_KEYCHAIN_BACKEND = "macos";
    const backend = await selectBackend();

    await backend.delete();
    expect(await backend.exists()).toBe(false);

    try {
      await backend.set(Buffer.alloc(32, 21));
      expect(await backend.exists()).toBe(true);
      // errSecDuplicateItem (45) rather than an in-place update.
      await expect(backend.set(Buffer.alloc(32, 22))).rejects.toThrow(/already stored/i);
      expect((await backend.get())?.equals(Buffer.alloc(32, 21))).toBe(true);
    } finally {
      await backend.delete();
    }
    expect(await backend.exists()).toBe(false);
  },
);
