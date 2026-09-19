import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openContext } from "../src/context";
import { generateDataKey } from "../src/vault/crypto";
import {
  loadOrCreateDataKey,
  selectBackend,
  serviceName,
  type KeychainBackend,
} from "../src/vault/keychain";
import { keyFilePath } from "../src/vault/keychain/file";
import { addPasswordCommand } from "../src/vault/keychain/macos";
import { META_KEYCHAIN_BACKEND, META_KEY_CHECK, backendMismatchError, readVaultMeta } from "../src/vault/meta";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

function isolate(): string {
  return isolateEnv({ prefix: "kc" });
}

afterEach(restoreEnv);

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

// These two tests exercise the real macOS login Keychain -- they write to and
// delete from it, under the `dev.kerstel.vault.test` service name set by
// isolate() above, never the real `dev.kerstel.vault` item. They are opt-in
// (set KERSTEL_ALLOW_REAL_KEYCHAIN_TESTS=1) because a regression in that
// isolation would otherwise touch a developer's live vault key on their own
// machine the moment `bun test` runs.
test.if(
  process.platform === "darwin" && process.env.KERSTEL_ALLOW_REAL_KEYCHAIN_TESTS === "1",
)("the macOS Keychain backend round-trips", async () => {
  isolate();
  process.env.KERSTEL_KEYCHAIN_BACKEND = "macos";
  const backend = await selectBackend();
  expect(backend.name).toBe("macos");
  // Guards against a regression that silently stops honouring the override
  // and points the backend back at the real, machine-global item.
  expect(serviceName()).toBe("dev.kerstel.vault.test");
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

test("the macOS key goes to security -i on stdin, quoted, never as an argument", () => {
  const key = Buffer.alloc(32, 42);
  const line = addPasswordCommand(key, "dev.kerstel.vault", false);
  expect(line).toBe(
    `add-generic-password -a "kerstel" -s "dev.kerstel.vault" -D "Kerstel vault key" -w "${key.toString("base64")}"\n`,
  );
  expect(addPasswordCommand(key, "svc", true)).toContain(" -U -w ");
  expect(() => addPasswordCommand(key, 'bad"name', false)).toThrow(/quote/);
});

// The bug this guards against only shows up with a controlling terminal:
// `security add-generic-password -w` reads the value from the TTY, not stdin,
// so the first run in a real shell stopped at "password data for new item:".
// `script` gives the child a pseudo-terminal, which bun test itself lacks.
test.if(
  process.platform === "darwin" && process.env.KERSTEL_ALLOW_REAL_KEYCHAIN_TESTS === "1",
)("the macOS Keychain backend stores a key without prompting in a terminal", async () => {
  const service = "dev.kerstel.vault.test-tty";
  const source = resolve(import.meta.dir, "../src/vault/keychain/macos.ts");
  const code = `
    const { macosBackend } = await import(${JSON.stringify(source)});
    const key = Buffer.alloc(32, 5);
    await macosBackend.delete();
    try {
      await macosBackend.set(key);
      console.log((await macosBackend.get())?.equals(key) ? "ROUND-TRIP-OK" : "ROUND-TRIP-MISMATCH");
    } finally {
      await macosBackend.delete();
    }
  `;
  const proc = Bun.spawn(["script", "-q", "/dev/null", process.execPath, "-e", code], {
    env: { ...process.env, KERSTEL_KEYCHAIN_SERVICE: service },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 10_000);
  const output = await new Response(proc.stdout).text();
  clearTimeout(timer);
  expect(output).not.toContain("password data");
  expect(output).toContain("ROUND-TRIP-OK");
}, 15_000);

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

test.if(
  process.platform === "darwin" && process.env.KERSTEL_ALLOW_REAL_KEYCHAIN_TESTS === "1",
)(
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

// --- the vault remembers which credential store holds its key (Finding 2) ---

test("a fresh vault records the backend that minted its key", async () => {
  const dir = isolate();
  const ctx = await openContext();
  try {
    expect(ctx.firstRun).toBe(true);
    expect(ctx.backend).toBe("file");
    expect(ctx.vault.getMeta(META_KEYCHAIN_BACKEND)).toBe("file");
    expect(ctx.vault.getMeta(META_KEY_CHECK)).toBeTruthy();
  } finally {
    ctx.vault.close();
  }
  expect(readVaultMeta(join(dir, "vault.db"))[META_KEYCHAIN_BACKEND]).toBe("file");
});

test("a backend mismatch refuses to open and mints no second key", async () => {
  const dir = isolate();

  // Establish a vault whose key was minted by the macOS Keychain. This is the
  // state a developer's machine is in after any normal GUI session.
  const ctx = await openContext();
  ctx.vault.setMeta(META_KEYCHAIN_BACKEND, "macos");
  ctx.vault.close();
  rmSync(join(dir, "vault.key"));

  // Now the SSH session: the native backend reports unavailable, selection
  // falls through to the file backend, and nothing at all is stored there.
  // Before this guard, that minted a SECOND key and every existing secret
  // began failing GCM authentication with "Could not decrypt the stored value".
  await expect(openContext()).rejects.toThrow(/macOS Keychain/);

  // The critical assertion: it refused rather than creating.
  expect(existsSync(join(dir, "vault.key"))).toBe(false);
});

test("the mismatch error names both backends and leaks no key material", async () => {
  isolate();
  const ctx = await openContext();
  ctx.vault.setMeta(META_KEYCHAIN_BACKEND, "macos");
  ctx.vault.close();

  const error = await openContext().then(
    (opened) => {
      opened.vault.close();
      return null;
    },
    (caught: Error) => caught,
  );
  expect(error?.message).toContain("macOS Keychain");
  expect(error?.message).toContain('"file"');
  expect(error?.message).toContain("will not create a second key");
});

test("a wrong key is caught by the key check before any secret is touched", async () => {
  const dir = isolate();

  const ctx = await openContext();
  ctx.vault.setSecret({ scope: "global", key: "K" }, "the-original-value");
  ctx.vault.close();

  // Swap the stored key for a different one, keeping the same backend, so the
  // backend guard above cannot be what catches this. This is the shape of a
  // restored-from-backup vault paired with the wrong keychain entry.
  writeFileSync(join(dir, "vault.key"), generateDataKey().toString("base64"), { mode: 0o600 });

  await expect(openContext()).rejects.toThrow(/does not match the vault/);
});

test("an existing vault with secrets refuses a newly minted key", async () => {
  const dir = isolate();

  // An older vault: secrets present, nothing recorded in vault_meta, so there is
  // no recorded backend to compare against. The tell is that a key was just
  // CREATED, and a brand-new key cannot decrypt secrets that were already here.
  const ctx = await openContext();
  ctx.vault.setSecret({ scope: "global", key: "K" }, "pre-existing");
  ctx.vault.close();

  const db = new Database(join(dir, "vault.db"));
  db.exec("DELETE FROM vault_meta");
  db.close();
  rmSync(join(dir, "vault.key"));

  await expect(openContext()).rejects.toThrow(/will not create a second key/);
});

// --- exclusive create, not check-then-write (Finding 5) --------------------

test("the file backend refuses an overwrite even when the pre-check is bypassed", async () => {
  const dir = isolate();
  const backend = await selectBackend();

  // Write the key file directly, standing in for a concurrent process that
  // created it in the window between set()'s existsSync and its write. The
  // pre-check cannot see this; only the O_EXCL on the write can.
  const original = Buffer.alloc(32, 9);
  writeFileSync(join(dir, "vault.key"), original.toString("base64"), { mode: 0o600 });

  await expect(backend.set(Buffer.alloc(32, 1))).rejects.toThrow(/Refusing to/);

  // The decisive assertion: the original key is still the one on disk.
  expect((await backend.get())?.equals(original)).toBe(true);
});

test("an explicit rotate is still allowed to replace the key", async () => {
  isolate();
  const backend = await selectBackend();
  await backend.set(Buffer.alloc(32, 3));

  const rotated = Buffer.alloc(32, 4);
  await backend.set(rotated, { rotate: true });
  expect((await backend.get())?.equals(rotated)).toBe(true);
});

test("the mismatch advice matches the store that holds the key", () => {
  isolate();
  // `isolate()` forces the file backend through the variable; this test is
  // about the selection falling through on its own, so clear it.
  delete process.env.KERSTEL_KEYCHAIN_BACKEND;
  // A vault keyed in the macOS Keychain, opened over SSH: the Keychain is the
  // thing to unlock.
  const macos = backendMismatchError("macos", "file").message;
  expect(macos).toContain("macOS Keychain");
  expect(macos).toContain("Unlock");
  expect(macos).not.toContain("KERSTEL_KEYCHAIN_BACKEND");

  // A vault keyed in the Secret Service or the Credential Manager gets the
  // same shape of advice for its own store, never the Keychain's.
  const linux = backendMismatchError("linux", "file").message;
  expect(linux).toContain("Secret Service");
  expect(linux).not.toContain("Keychain");
  const windows = backendMismatchError("windows", "file").message;
  expect(windows).toContain("Credential Manager");
  expect(windows).not.toContain("Keychain");

  // A vault keyed in a file, opened from a session where the native store IS
  // reachable: the file is right here, so "unlock it" and "run from a GUI
  // session" are both wrong. The fix is to pin the backend to the file.
  const file = backendMismatchError("file", "macos").message;
  expect(file).toContain(keyFilePath());
  expect(file).toContain("KERSTEL_KEYCHAIN_BACKEND=file");
  expect(file).not.toContain("not reachable");
  expect(file).not.toContain("Unlock");
  expect(file).not.toContain("GUI session");

  // A vault that predates vault_meta cannot say which store minted its key.
  const unknown = backendMismatchError("another", "file").message;
  expect(unknown).toContain("doctor");
  expect(unknown).not.toContain("Unlock");
});

test("a mismatch forced by KERSTEL_KEYCHAIN_BACKEND names the variable, not an unreachable store", () => {
  isolate();
  // A GUI session with the Keychain unlocked, and the variable pointing at the
  // file backend anyway: the store IS reachable, so "unlock it" is wrong, and
  // the fix is the variable.
  process.env.KERSTEL_KEYCHAIN_BACKEND = "file";
  const forced = backendMismatchError("macos", "file").message;
  expect(forced).toContain("macOS Keychain");
  expect(forced).toContain("KERSTEL_KEYCHAIN_BACKEND=file");
  expect(forced).toContain('set it to "macos"');
  expect(forced).not.toContain("not reachable");
  expect(forced).not.toContain("Unlock");

  // The variable naming some OTHER backend than the one selected is not what
  // caused this mismatch, so the unreachable-store advice stands.
  process.env.KERSTEL_KEYCHAIN_BACKEND = "linux";
  expect(backendMismatchError("macos", "file").message).toContain("not reachable");

  // A file-keyed vault under a forced native backend keeps the file advice.
  process.env.KERSTEL_KEYCHAIN_BACKEND = "macos";
  const file = backendMismatchError("file", "macos").message;
  expect(file).toContain("KERSTEL_KEYCHAIN_BACKEND=file");
  expect(file).not.toContain("Unset");
});
