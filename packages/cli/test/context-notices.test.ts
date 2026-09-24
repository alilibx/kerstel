import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { keyStoreNotices, openContext } from "../src/context";
import { keyFilePath } from "../src/vault/keychain/file";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

afterEach(() => {
  const home = process.env.KERSTEL_HOME;
  restoreEnv();
  if (home && home.startsWith(tmpdir())) rmSync(home, { recursive: true, force: true });
});

/** Runs `body` and returns everything it wrote to stderr. */
async function stderrOf(body: () => Promise<unknown>): Promise<string> {
  const written: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await body();
  } finally {
    process.stderr.write = real;
  }
  return written.join("");
}

test("a key file nobody asked for is warned about, naming the file and how to acknowledge it", () => {
  isolateEnv({ prefix: "notices" });
  const [warning] = keyStoreNotices({ backend: "file", created: false, forced: undefined, cli: "ks" });
  expect(warning?.level).toBe("warn");
  expect(warning?.text).toContain(keyFilePath());
  expect(warning?.text).toContain("ks doctor");
  expect(warning?.text).toContain("KERSTEL_KEYCHAIN_BACKEND=file");
});

test("a key file asked for with KERSTEL_KEYCHAIN_BACKEND=file is not warned about", () => {
  expect(keyStoreNotices({ backend: "file", created: false, forced: "file", cli: "ks" })).toEqual([]);
});

test("a native store says nothing on an ordinary run", () => {
  expect(keyStoreNotices({ backend: "macos", created: false, forced: undefined, cli: "ks" })).toEqual([]);
});

test("a new key is announced, with where it went", () => {
  expect(keyStoreNotices({ backend: "macos", created: true, forced: undefined, cli: "ks" })).toEqual([{ level: "info", text: "Created a new vault key in the macOS Keychain." }]);
  isolateEnv({ prefix: "notices-created" });
  const lines = keyStoreNotices({ backend: "file", created: true, forced: undefined, cli: "ks" });
  expect(lines).toHaveLength(2);
  expect(lines[0]).toEqual({ level: "info", text: `Created a new vault key in ${keyFilePath()}.` });
  expect(lines[1]?.level).toBe("warn");
});

test("doctor's opt-out drops the key-file warning but still announces a new key", () => {
  isolateEnv({ prefix: "notices-doctor" });
  const lines = keyStoreNotices({
    backend: "file",
    created: true,
    forced: undefined,
    cli: "ks",
    suppressFileWarning: true,
  });
  expect(lines).toEqual([{ level: "info", text: `Created a new vault key in ${keyFilePath()}.` }]);
});

test("openContext writes its notices to stderr, and can be told not to", async () => {
  isolateEnv({ prefix: "notices-open" });
  const first = await stderrOf(async () => (await openContext()).vault.close());
  expect(first).toContain(`Created a new vault key in ${keyFilePath()}.`);
  // KERSTEL_KEYCHAIN_BACKEND=file is explicit under isolateEnv: no warning.
  expect(first).not.toContain("no OS credential store");

  const again = await stderrOf(async () => (await openContext()).vault.close());
  expect(again).toBe("");

  const quiet = await stderrOf(async () => (await openContext({ warnFileKey: false })).vault.close());
  expect(quiet).toBe("");
});
