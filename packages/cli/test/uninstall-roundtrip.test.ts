import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInitArgs, runInit } from "../src/commands/init";
import { uninstallCommand } from "../src/commands/uninstall";
import { startDaemon, type DaemonHandle } from "../src/daemon/server";
import { ensureToken } from "../src/daemon/token";
import { DefaultsPrompter } from "../src/init/prompts";
import { socketPath } from "../src/paths";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

/**
 * Spec §7: the real `init` followed by the real `uninstall` gives back the
 * developer's files byte for byte -- comments, `export`, both quote styles with
 * escapes, inline comments, CRLF -- and a value `init` collapsed is reported
 * by the loss gate instead of vanishing.
 */

let handle: DaemonHandle | null = null;
let daemonVault: Vault | null = null;
const dirs: string[] = [];
const realLog = console.log;
let output: string[] = [];

/** init's self-check needs a daemon serving this test's KERSTEL_HOME. */
async function bootLocalDaemon(): Promise<void> {
  const token = ensureToken();
  const { key, backend } = await loadOrCreateDataKey();
  daemonVault = openVault(key);
  handle = await startDaemon({ vault: daemonVault, socketPath: socketPath(), token, backendName: backend });
}

async function stopLocalDaemon(): Promise<void> {
  if (handle) await handle.close();
  handle = null;
  daemonVault?.close();
  daemonVault = null;
}

afterEach(async () => {
  console.log = realLog;
  await stopLocalDaemon();
  restoreEnv();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// CRLF throughout, with comments, `export`, both quote styles with escapes,
// inline comments, and a `#` that is part of a value.
const ENV = [
  "# Database settings",
  "export DB_HOST=localhost",
  "DB_PASSWORD='single quoted pw' # inline comment",
  'API_SECRET="sk-\\"quoted\\" \\tvalue" # escapes stay literal',
  "",
  "AUTH_TOKEN=tok#not-a-comment",
  "export WEBHOOK_SECRET='whsec_single'",
  "",
].join("\r\n");

// LF, highest precedence, so every value it holds wins.
const ENV_LOCAL = [
  "# local overrides",
  'STRIPE_KEY="sk_test_\\\\server\\share"',
  "SHARED_SECRET=local-wins",
  "export PRIVATE_KEY=back\\slash # trailing",
  "",
].join("\n");

// Lower precedence than .env.local and disagreeing with it on SHARED_SECRET:
// init keeps the .env.local value, so this one survives only in the backup.
const ENV_DEVELOPMENT = "SHARED_SECRET=dev-loses\nDEV_ONLY_SECRET=dev-value\n";

const PACKAGE = '{\r\n  "name": "gnarly-app",\r\n  "scripts": {\r\n    "dev": "vite",\r\n    "build": "vite build"\r\n  }\r\n}\r\n';
const GITIGNORE = "node_modules\n.env.local\n";

test("init then uninstall restores every file byte for byte and gates the collapsed value", async () => {
  const home = isolateEnv({ prefix: "uninstall-roundtrip" });
  dirs.push(home);
  const root = mkdtempSync(join(tmpdir(), "kerstel-roundtrip-app-"));
  dirs.push(root);
  const originals: Record<string, string> = {
    ".env": ENV,
    ".env.local": ENV_LOCAL,
    ".env.development": ENV_DEVELOPMENT,
    "package.json": PACKAGE,
    ".gitignore": GITIGNORE,
  };
  for (const [name, contents] of Object.entries(originals)) writeFileSync(join(root, name), contents);

  await bootLocalDaemon();
  const parsed = parseInitArgs(["--yes"], root);
  if ("error" in parsed) throw new Error(parsed.error);
  output = [];
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
  expect(await runInit(parsed, new DefaultsPrompter())).toBe(0);

  // init really did rewrite the secrets and wire both scripts, so the restore
  // below has something to undo.
  const wiredEnv = readFileSync(join(root, ".env"), "utf8");
  for (const key of ["DB_PASSWORD", "API_SECRET", "AUTH_TOKEN", "WEBHOOK_SECRET"]) {
    expect(wiredEnv).toContain(`kerstel://gnarly-app/${key}`);
  }
  const wiredLocal = readFileSync(join(root, ".env.local"), "utf8");
  for (const key of ["STRIPE_KEY", "SHARED_SECRET", "PRIVATE_KEY"]) {
    expect(wiredLocal).toContain(`kerstel://gnarly-app/${key}`);
  }
  expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"dev": "kerstel exec -- vite"');
  expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"build": "kerstel exec -- vite build"');

  await stopLocalDaemon();

  // Without --force the collapsed value stops the uninstall, by name only.
  output = [];
  expect(await uninstallCommand(["--yes"], undefined, { path: "/nonexistent/bun", compiled: false })).toBe(1);
  const refusal = output.join("\n");
  expect(refusal).toContain("Values init kept only in its encrypted backup");
  // .env.local gets its value back from the vault; only .env.development loses one.
  expect(refusal).toContain("gnarly-app: SHARED_SECRET in .env.development (backup");
  expect(refusal).not.toContain("dev-loses");
  expect(existsSync(home)).toBe(true);

  output = [];
  expect(
    await uninstallCommand(["--yes", "--force"], undefined, { path: "/nonexistent/bun", compiled: false }),
  ).toBe(0);
  expect(existsSync(home)).toBe(false);

  // Every file without a conflicting duplicate is back exactly as written.
  for (const name of [".env", ".env.local", "package.json", ".gitignore"]) {
    expect({ name, contents: readFileSync(join(root, name), "utf8") }).toEqual({
      name,
      contents: originals[name]!,
    });
  }
  // The one with the collapsed value gets the value init kept, as the gate said.
  expect(readFileSync(join(root, ".env.development"), "utf8")).toBe(
    "SHARED_SECRET=local-wins\nDEV_ONLY_SECRET=dev-value\n",
  );
});
