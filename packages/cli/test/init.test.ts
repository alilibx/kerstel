import { afterEach, expect, test } from "bun:test";
import { launcherSource } from "../src/init/launcher";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  initCommand,
  parseInitArgs,
  runInit,
  summaryLines,
  type InitOptions,
} from "../src/commands/init";
import { startDaemon, type DaemonHandle } from "../src/daemon/server";
import { ensureToken } from "../src/daemon/token";
import { collectKeys, loadEnvFiles } from "../src/init/collect";
import { discoverEnvFiles } from "../src/init/detect";
import { listBackups, readBackupVault } from "../src/init/backup";
import { planUninstall } from "../src/uninstall/plan";
import {
  CancelledError,
  DefaultsPrompter,
  ScriptedPrompter,
  type Choice,
  type Prompter,
  type TextOptions,
} from "../src/init/prompts";
import { backupsDir, socketPath } from "../src/paths";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { captureLog as captureConsoleLog } from "./helpers/capture-log";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

let handle: DaemonHandle | null = null;
let daemonVault: Vault | null = null;

/**
 * `init`'s self-check spawns `node .kerstel/exec.cjs -- node -e ...`, which needs a
 * daemon serving THIS test's KERSTEL_HOME on the real socketPath().
 * test/helpers/boot-daemon.ts deliberately boots a different thing -- its own
 * throwaway vault on its own socket -- which that child could never find.
 */
async function bootLocalDaemon(): Promise<void> {
  const token = ensureToken();
  const { key, backend } = await loadOrCreateDataKey();
  daemonVault = openVault(key);
  handle = await startDaemon({ vault: daemonVault, socketPath: socketPath(), token, backendName: backend });
}

async function openTestVault<T>(use: (vault: Vault) => T): Promise<T> {
  const { key } = await loadOrCreateDataKey();
  const vault = openVault(key);
  try {
    return use(vault);
  } finally {
    vault.close();
  }
}

/**
 * Every throwaway directory this file creates, removed in afterEach.
 *
 * It is not tidiness: an abandoned KERSTEL_HOME holds the file backend's data
 * key, a vault.db with real secrets in it, and an encrypted backup. Leaving
 * one per test in /tmp is leaving the material to decrypt them next to them.
 */
const createdDirs: string[] = [];

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-init-"));
  createdDirs.push(root);
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(join(root, dirname(name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  return root;
}

function options(root: string, args: string[] = []): InitOptions {
  const parsed = parseInitArgs(args, root);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

const NPM_PACKAGE = `{
  "name": "@acme/demo-app",
  "scripts": {
    "dev": "next dev",
    "postinstall": "patch-package"
  }
}
`;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  if (daemonVault) daemonVault.close();
  daemonVault = null;

  // isolateEnv() mints the home itself, so read it back before restoreEnv()
  // puts the real one back. The tmpdir() guard is what makes this safe to run
  // unconditionally: a test that never isolated must not delete a developer's
  // actual ~/.kerstel.
  const home = process.env.KERSTEL_HOME;
  if (home && home.startsWith(tmpdir())) createdDirs.push(home);
  restoreEnv();

  // Pop-driven so cleanup still finishes if one rmSync throws, and so a
  // failing assertion earlier in the test cannot skip it.
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("init refuses, before writing anything, when node_modules/.bin holds a kerstel", async () => {
  const home = isolateEnv({ prefix: "init-shadow" });
  const root = makeProject({ "package.json": NPM_PACKAGE, ".env": "API_KEY=super-secret-shadow\n" });
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".bin", "kerstel"), "#!/bin/sh\nexec /usr/bin/true\n");

  expect(await runInit(options(root, ["--yes", "--non-interactive"]), new DefaultsPrompter())).toBe(1);

  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_KEY=super-secret-shadow\n");
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(NPM_PACKAGE);
  expect(existsSync(join(home, "vault.db"))).toBe(false);
});

test("init leaves an unquoted PEM block alone, never prints it, and does not call the file safe to commit", async () => {
  isolateEnv({ prefix: "init-pem" });
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7PEMBODY";
  const tail = "kL0tuEJ6abcdEFGH1234567890abcdefghijklmnopqrstuvwxyz==";
  const source = [
    "API_KEY=sk-pem-test-value",
    "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----",
    body,
    tail,
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n");
  const root = makeProject({ "package.json": NPM_PACKAGE, ".env": source });
  await bootLocalDaemon();

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  let code: number;
  try {
    code = await runInit(options(root, ["--yes", "--non-interactive"]), new DefaultsPrompter());
  } finally {
    console.log = realLog;
  }
  expect(code).toBe(0);

  const out = captured.join("\n");
  expect(out).not.toContain("PEMBODY");
  expect(out).not.toContain("kL0tu");
  expect(out).toContain("PRIVATE_KEY left untouched");
  expect(out).not.toContain("safe to commit");

  const after = readFileSync(join(root, ".env"), "utf8");
  expect(after).toContain("API_KEY=kerstel://demo-app/API_KEY");
  expect(after).toContain("PRIVATE_KEY=-----BEGIN PRIVATE KEY-----");
  expect(after).toContain(body);
  expect(after).toContain(tail);
  expect(after).not.toContain(`${tail.slice(0, -2)}=kerstel://`);
});

test("collectKeys applies the documented precedence and records conflicts", () => {
  const root = makeProject({
    ".env": "SHARED=from-env\nONLY_BASE=base\n",
    ".env.local": "SHARED=from-local\n",
    ".env.production.local": "SHARED=from-prod-local\n",
  });
  const keys = collectKeys(loadEnvFiles(discoverEnvFiles(root)));
  const shared = keys.find((k) => k.key === "SHARED");

  expect(shared?.value).toBe("from-prod-local");
  expect(shared?.source).toBe(".env.production.local");
  expect(shared?.files).toEqual([".env.production.local", ".env.local", ".env"]);
  expect(shared?.conflicts).toEqual([".env.local", ".env"]);
  expect(keys.find((k) => k.key === "ONLY_BASE")?.conflicts).toEqual([]);
});

test("collectKeys recognises a value that is already a reference", () => {
  const root = makeProject({ ".env": "A=kerstel://demo/A\nB=plain\n" });
  const keys = collectKeys(loadEnvFiles(discoverEnvFiles(root)));
  expect(keys.find((k) => k.key === "A")?.reference).toEqual({ scope: "demo", key: "A" });
  expect(keys.find((k) => k.key === "B")?.reference).toBeNull();
});

test("parseInitArgs reads every documented flag and rejects the rest", () => {
  const parsed = parseInitArgs(
    ["--yes", "--dry-run", "--non-interactive", "--from-stdin", "--scope", "my-app", "--global", "A,B", "--keep", "C"],
    "/tmp/p",
  );
  if ("error" in parsed) throw new Error(parsed.error);
  expect(parsed.yes).toBe(true);
  expect(parsed.dryRun).toBe(true);
  expect(parsed.nonInteractive).toBe(true);
  expect(parsed.fromStdin).toBe(true);
  expect(parsed.scope).toBe("my-app");
  expect([...parsed.globalKeys]).toEqual(["A", "B"]);
  expect([...parsed.keepKeys]).toEqual(["C"]);

  expect(parseInitArgs(["--frobnicate"], "/tmp/p")).toEqual({
    error: expect.stringContaining("--frobnicate") as unknown as string,
  });
  expect(parseInitArgs(["--scope", "Bad Scope"], "/tmp/p")).toEqual({
    error: expect.stringContaining("Invalid scope") as unknown as string,
  });
});

test("initCommand rejects an unknown flag before touching anything", async () => {
  isolateEnv({ prefix: "init-badflag" });
  expect(await initCommand(["--frobnicate"], new DefaultsPrompter())).toBe(2);
});

test("init migrates an npm project end to end", async () => {
  isolateEnv({ prefix: "init-npm" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    "package-lock.json": "{}",
    ".env": [
      "# app config",
      "NODE_ENV=development",
      "DATABASE_URL=postgres://u:pw@localhost:5432/app",
      'OPENAI_API_KEY="sk-project-key" # from the console',
      "",
    ].join("\n"),
  });

  // One by one: three keys -> three destinations, then accept, then apply.
  // .gitignore is not asked (this project has none).
  const prompter = new ScriptedPrompter(["each", "plaintext", "project", "global", "accept", "apply"]);
  expect(await runInit(options(root), prompter)).toBe(0);

  const env = readFileSync(join(root, ".env"), "utf8");
  expect(env).toContain("# app config");
  expect(env).toContain("NODE_ENV=development");
  expect(env).toContain("DATABASE_URL=kerstel://demo-app/DATABASE_URL");
  expect(env).toContain('OPENAI_API_KEY="kerstel://global/OPENAI_API_KEY" # from the console');
  expect(env).not.toContain("sk-project-key");
  expect(env).not.toContain("pw@localhost");

  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(`{
  "name": "@acme/demo-app",
  "scripts": {
    "dev": "node .kerstel/exec.cjs -- next dev",
    "postinstall": "patch-package"
  }
}
`);

  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "demo-app", key: "DATABASE_URL" })).toBe(
      "postgres://u:pw@localhost:5432/app",
    );
    expect(vault.getSecret({ scope: "global", key: "OPENAI_API_KEY" })).toBe("sk-project-key");
    expect(vault.getSecret({ scope: "demo-app", key: "NODE_ENV" })).toBeNull();
    expect(vault.listProjects().map((p) => p.name)).toContain("demo-app");
  });

  const backups = readdirSync(join(backupsDir(), "demo-app"));
  expect(backups.length).toBe(1);
  expect(existsSync(join(backupsDir(), "demo-app", backups[0]!, ".env.enc"))).toBe(true);
});

test("init stores the highest-precedence value and points every file at it", async () => {
  isolateEnv({ prefix: "init-conflict" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": '{\n  "name": "conflicted",\n  "scripts": {\n    "dev": "vite"\n  }\n}\n',
    ".env": "API_TOKEN=base-value-aaaa\n",
    ".env.local": "API_TOKEN=local-value-bbbb\n",
  });

  expect(await runInit(options(root), new ScriptedPrompter(["each", "project", "accept", "apply"]))).toBe(0);

  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_TOKEN=kerstel://conflicted/API_TOKEN\n");
  expect(readFileSync(join(root, ".env.local"), "utf8")).toBe(
    "API_TOKEN=kerstel://conflicted/API_TOKEN\n",
  );
  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "conflicted", key: "API_TOKEN" })).toBe("local-value-bbbb");
  });
});

test("--dry-run prints the plan and leaves every file byte-identical", async () => {
  isolateEnv({ prefix: "init-dry" });

  const envSource = "SECRET_TOKEN=do-not-touch-me\n";
  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": envSource,
  });

  expect(await runInit(options(root, ["--dry-run", "--yes"]), new DefaultsPrompter())).toBe(0);

  expect(readFileSync(join(root, ".env"), "utf8")).toBe(envSource);
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(NPM_PACKAGE);
  expect(existsSync(backupsDir())).toBe(false);
  await openTestVault((vault) => {
    expect(vault.listSecrets().length).toBe(0);
  });
});

test("a bun project is wired through package scripts alone", async () => {
  isolateEnv({ prefix: "init-bun" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": '{\n  "name": "bunny",\n  "scripts": {\n    "dev": "bun run index.ts"\n  }\n}\n',
    "bun.lock": "",
    ".env": "SERVICE_TOKEN=bun-secret-value\n",
  });

  expect(await runInit(options(root), new ScriptedPrompter(["each", "project", "accept", "apply"]))).toBe(0);

  expect(readFileSync(join(root, "package.json"), "utf8")).toContain(
    '"dev": "node .kerstel/exec.cjs -- bun run index.ts"',
  );
  // `kerstel exec` passes --preload to bun itself, so init leaves no per-machine
  // absolute path behind in a committed config file.
  expect(existsSync(join(root, "bunfig.toml"))).toBe(false);
});

test("a second run reports an already-migrated project and changes nothing", async () => {
  isolateEnv({ prefix: "init-again" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=first-run-value\n",
  });
  expect(await runInit(options(root), new ScriptedPrompter(["each", "project", "accept", "apply"]))).toBe(0);

  const envAfterFirst = readFileSync(join(root, ".env"), "utf8");
  const packageAfterFirst = readFileSync(join(root, "package.json"), "utf8");

  // No prompts at all the second time: nothing is left to decide.
  const second = new ScriptedPrompter([]);
  expect(await runInit(options(root), second)).toBe(0);
  expect(second.asked).toEqual([]);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe(envAfterFirst);
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(packageAfterFirst);
});

test("the teammate flow prompts for references the vault cannot resolve", async () => {
  isolateEnv({ prefix: "init-teammate" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=kerstel://demo-app/SERVICE_TOKEN\n",
  });

  // One `text` for the missing value, then apply (this fixture's scripts are
  // not wired yet, so there is still a change to approve).
  const prompter = new ScriptedPrompter(["teammate-supplied-value", "apply"]);
  expect(await runInit(options(root), prompter)).toBe(0);
  expect(prompter.asked[0]).toBe("SERVICE_TOKEN · 1 of 1");

  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "demo-app", key: "SERVICE_TOKEN" })).toBe("teammate-supplied-value");
  });
});

test("--non-interactive with a missing value exits 2 naming the flag", async () => {
  isolateEnv({ prefix: "init-noninteractive" });

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=kerstel://demo-app/SERVICE_TOKEN\n",
  });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await runInit(options(root, ["--non-interactive"]), new DefaultsPrompter())).toBe(2);
  } finally {
    console.log = realLog;
  }
  expect(captured.join("\n")).toContain("--from-stdin");
});

test("--keep forces plaintext and --global forces the global scope", async () => {
  isolateEnv({ prefix: "init-flags" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "KEEP_ME=keep-this-value\nSHARE_ME=share-this-value\n",
  });

  // Both keys are decided by flags, so "Look right?" has nothing to offer and
  // the only question is apply.
  expect(
    await runInit(options(root, ["--keep", "KEEP_ME", "--global", "SHARE_ME"]), new ScriptedPrompter(["apply"])),
  ).toBe(0);

  const env = readFileSync(join(root, ".env"), "utf8");
  expect(env).toContain("KEEP_ME=keep-this-value");
  expect(env).toContain("SHARE_ME=kerstel://global/SHARE_ME");
  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "global", key: "SHARE_ME" })).toBe("share-this-value");
    expect(vault.getSecret({ scope: "demo-app", key: "KEEP_ME" })).toBeNull();
  });
});

test(".gitignore is left alone by default and cleaned up only on an explicit yes", async () => {
  isolateEnv({ prefix: "init-gitignore" });
  await bootLocalDaemon();

  const gitignore = "node_modules/\n.env\n.env.*\ndist/\n";
  const rootDefault = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=a-secret-value\n",
    ".gitignore": gitignore,
  });
  // one by one, accept, .gitignore -> keep, apply
  expect(
    await runInit(options(rootDefault), new ScriptedPrompter(["each", "project", "accept", "keep", "apply"])),
  ).toBe(0);
  expect(readFileSync(join(rootDefault, ".gitignore"), "utf8")).toBe(gitignore);

  const rootYes = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=a-secret-value\n",
    ".gitignore": gitignore,
  });
  expect(
    await runInit(options(rootYes), new ScriptedPrompter(["each", "project", "accept", "remove", "apply"])),
  ).toBe(0);
  const updated = readFileSync(join(rootYes, ".gitignore"), "utf8");
  expect(updated).toContain("# Kerstel: .env files hold references, safe to commit");
  expect(updated).toContain("node_modules/");
  expect(updated).toContain("dist/");
  expect(updated.split("\n")).not.toContain(".env");
  expect(updated.split("\n")).not.toContain(".env.*");
});

test("init refuses to run outside a project", async () => {
  isolateEnv({ prefix: "init-nopackage" });
  const root = makeProject({ ".env": "A=1\n" });
  expect(await runInit(options(root), new DefaultsPrompter())).toBe(2);
});

test("init reports a project with no env files instead of pretending to work", async () => {
  isolateEnv({ prefix: "init-noenv" });
  const root = makeProject({ "package.json": NPM_PACKAGE });
  expect(await runInit(options(root), new DefaultsPrompter())).toBe(1);
});

test("the printed diff masks the plaintext it is about to remove", async () => {
  isolateEnv({ prefix: "init-noleak" });

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": 'SECRET_TOKEN=super-secret-plaintext\nQUOTED_TOKEN="another-secret-value" # note\n',
  });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await runInit(options(root, ["--dry-run"]), new ScriptedPrompter(["each", "project", "global", "accept"]))).toBe(0);
  } finally {
    console.log = realLog;
  }

  const output = captured.join("\n");
  expect(output).not.toContain("super-secret-plaintext");
  expect(output).not.toContain("another-secret-value");
  // The diff still has to be a real, readable diff of the whole file.
  expect(output).toContain("SECRET_TOKEN=kerstel://demo-app/SECRET_TOKEN");
  expect(output).toContain("QUOTED_TOKEN=\"kerstel://global/QUOTED_TOKEN\" # note");
  // The mask tells the user the shape and size and nothing else.
  expect(output).toContain("SECRET_TOKEN=\u00ab22-chars-opaque\u00bb");
  expect(output).toContain("QUOTED_TOKEN=\"\u00ab20-chars-opaque\u00bb\" # note");
});

test("the diff masks every value it is not migrating, parsed or not", async () => {
  isolateEnv({ prefix: "init-nokeep-leak" });
  await bootLocalDaemon();

  // PRIVATE_KEY opens a quote that never closes on its line, so the parser
  // refuses it: it is never collected and so never appears in the rewrite
  // map. Its continuation lines are raw lines the parser cannot classify at
  // all. Both sit BETWEEN two migrated keys, which puts them inside
  // renderDiff's single hunk.
  const envSource = [
    "DATABASE_URL=postgres://u:pw@localhost:5432/app",
    'PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----',
    "MIIEowIBAAKCAQEAsecretkeymaterial",
    '-----END RSA PRIVATE KEY-----"',
    "KEEP_ME=kept-plaintext-value",
    "OPENAI_API_KEY=sk-a-real-looking-key",
    "",
  ].join("\n");
  const root = makeProject({ "package.json": NPM_PACKAGE, ".env": envSource });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  let code: number;
  try {
    code = await runInit(
      options(root, ["--keep", "KEEP_ME"]),
      new ScriptedPrompter(["each", "project", "global", "accept", "diff", "apply"]),
    );
  } finally {
    console.log = realLog;
  }
  expect(code).toBe(0);

  const output = captured.join("\n");
  expect(output).not.toContain("MIIEowIBAAKCAQEAsecretkeymaterial");
  expect(output).not.toContain("BEGIN RSA PRIVATE KEY");
  expect(output).not.toContain("kept-plaintext-value");
  expect(output).not.toContain("pw@localhost");
  expect(output).not.toContain("sk-a-real-looking-key");
  // The diff is still a diff: it names what changed, and masks what did not.
  expect(output).toContain("DATABASE_URL=kerstel://demo-app/DATABASE_URL");
  expect(output).toContain("OPENAI_API_KEY=kerstel://global/OPENAI_API_KEY");
  expect(output).toContain("KEEP_ME=«20-chars-opaque»");

  // Masking is a DISPLAY concern. The bytes on disk keep the unsupported
  // value and the kept value exactly as the developer wrote them.
  const env = readFileSync(join(root, ".env"), "utf8");
  expect(env).toContain('PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretkeymaterial\n-----END RSA PRIVATE KEY-----"');
  expect(env).toContain("KEEP_ME=kept-plaintext-value");
  expect(env).toContain("DATABASE_URL=kerstel://demo-app/DATABASE_URL");
  expect(env).toContain("OPENAI_API_KEY=kerstel://global/OPENAI_API_KEY");
});

test("init warns about a key it cannot parse and never prints its value", async () => {
  isolateEnv({ prefix: "init-badkey" });
  await bootLocalDaemon();

  const envSource = "MY-KEY=dash-secret-value\nGOOD_KEY=good-secret-value\n";
  const root = makeProject({ "package.json": NPM_PACKAGE, ".env": envSource });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  let code: number;
  try {
    code = await runInit(options(root), new ScriptedPrompter(["each", "project", "accept", "apply"]));
  } finally {
    console.log = realLog;
  }
  expect(code).toBe(0);

  const output = captured.join("\n");
  expect(output).toContain("MY-KEY");
  expect(output).toContain("Kerstel does not support");
  expect(output).not.toContain("dash-secret-value");
  expect(output).not.toContain("good-secret-value");

  // The line the wizard refused is on disk exactly as the developer wrote it.
  const env = readFileSync(join(root, ".env"), "utf8");
  expect(env).toContain("MY-KEY=dash-secret-value");
  expect(env).toContain("GOOD_KEY=kerstel://demo-app/GOOD_KEY");
});

test("the .gitignore offer names the keys that still hold plaintext", async () => {
  isolateEnv({ prefix: "init-gitignore-plain" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "KEEP_ME=kept-plaintext-value\nMIGRATE_ME=migrated-secret-value\n",
    ".gitignore": "node_modules/\n.env\n",
  });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  let code: number;
  try {
    code = await runInit(
      options(root, ["--keep", "KEEP_ME"]),
      new ScriptedPrompter(["each", "project", "accept", "keep", "apply"]),
    );
  } finally {
    console.log = realLog;
  }
  expect(code).toBe(0);

  const output = captured.join("\n");
  expect(output).toContain("1 key still holds a plaintext value: KEEP_ME");
  expect(output).toContain("committing these files would expose");
  expect(output).not.toContain("kept-plaintext-value");
  // The reassuring sentence is a claim, and here it would be a false one.
  expect(output).not.toContain("they'll hold references, not secrets");
});

test("the .gitignore offer reassures only when every value is a reference", async () => {
  isolateEnv({ prefix: "init-gitignore-clean" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "MIGRATE_ME=migrated-secret-value\n",
    ".gitignore": "node_modules/\n.env\n",
  });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(
      await runInit(options(root), new ScriptedPrompter(["each", "project", "accept", "keep", "apply"])),
    ).toBe(0);
  } finally {
    console.log = realLog;
  }

  const output = captured.join("\n");
  expect(output).toContain("they'll hold references, not secrets");
  expect(output).not.toContain("still holds a plaintext value");
});

test("the closing summary tells the user the migration completed even when the self-check fails", () => {
  const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
  const backupDir = "/home/dev/.kerstel/backups/demo-app/2026-09-18T00-00-00";

  const passed = summaryLines({
    scope: "demo-app",
    packageManager: "npm",
    backupDir,
    verified: true,
  }).map(strip);
  expect(passed.length).toBe(1);
  expect(passed[0]).toContain("demo-app is set up");
  expect(passed[0]).toContain("npm run <script>");

  const failed = summaryLines({
    scope: "demo-app",
    packageManager: "npm",
    backupDir,
    verified: false,
  }).map(strip);
  // The set-up summary is still there: the migration really did happen.
  expect(failed[0]).toBe(passed[0]);
  const rest = failed.slice(1).join("\n");
  expect(rest).toContain(backupDir);
  expect(rest).toContain("self-check");
  expect(rest).toContain("kerstel doctor");
});

/**
 * "Already migrated" is a claim about the FILE, not about the wiring. A rerun
 * of a project where a key was deliberately kept in plaintext has nothing to
 * change either, and saying every value is a reference there would tell the
 * user their secrets are in the vault when one of them is still on disk.
 */
test("a rerun names the keys still in plaintext instead of claiming migration", async () => {
  isolateEnv({ prefix: "init-kept" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "KEEP_ME=keep-this-value\nMOVE_ME=move-this-value\n",
  });
  const flags = ["--keep", "KEEP_ME"];
  expect(await runInit(options(root, flags), new ScriptedPrompter(["each", "project", "accept", "apply"]))).toBe(0);

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  let code: number;
  try {
    code = await runInit(options(root, flags), new ScriptedPrompter([]));
  } finally {
    console.log = realLog;
  }

  const out = captured.join("\n");
  expect(code).toBe(0);
  expect(out).toContain("Nothing to change");
  expect(out).toContain("KEEP_ME");
  expect(out).not.toContain("Already migrated");
  expect(out).toContain("To move a key between the vault and plain text later, run");
  // Rule 1 holds even here: the key is named, the value never is.
  expect(out).not.toContain("keep-this-value");
  expect(readFileSync(join(root, ".env"), "utf8")).toContain("KEEP_ME=keep-this-value");
});

test("a rerun of a fully migrated project still reports it as migrated", async () => {
  isolateEnv({ prefix: "init-migrated" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "MOVE_ME=move-this-value\n",
  });
  expect(await runInit(options(root), new ScriptedPrompter(["each", "project", "accept", "apply"]))).toBe(0);

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  let code: number;
  try {
    code = await runInit(options(root), new ScriptedPrompter([]));
  } finally {
    console.log = realLog;
  }

  expect(code).toBe(0);
  expect(captured.join("\n")).toContain("Already migrated");
  expect(captured.join("\n")).toContain("To move a key between the vault and plain text later, run");
});

test("a first run that leaves keys in plain text points at move", async () => {
  isolateEnv({ prefix: "init-pointer" });
  await bootLocalDaemon();
  const root = makeProject({ "package.json": NPM_PACKAGE, ".env": "PORT=3000\nMOVE_ME=move-this-value\n" });
  const out = await captureLog(() =>
    runInit(options(root, ["--keep", "PORT"]), new ScriptedPrompter(["each", "project", "accept", "apply"])),
  );
  expect(out).toContain("To move a key between the vault and plain text later, run");
});

test("a first run whose only remaining plain text is a parser-refused line does not point at move", async () => {
  isolateEnv({ prefix: "init-pointer-unsupported" });
  await bootLocalDaemon();
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7PEMBODY";
  const tail = "kL0tuEJ6abcdEFGH1234567890abcdefghijklmnopqrstuvwxyz==";
  const source = [
    "API_KEY=sk-pem-test-value",
    "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----",
    body,
    tail,
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n");
  const root = makeProject({ "package.json": NPM_PACKAGE, ".env": source });

  const out = await captureLog(() => runInit(options(root, ["--yes", "--non-interactive"]), new DefaultsPrompter()));

  // API_KEY is moved to the vault, leaving PRIVATE_KEY as the only plain-text
  // value -- and PRIVATE_KEY is a line the parser refused to read at all, so
  // `ks move` has nothing there to act on either.
  expect(out).toContain("PRIVATE_KEY left untouched");
  expect(out).not.toContain("To move a key between the vault and plain text later, run");
});

/** Runs `body` with console.log captured, and returns everything it printed. */
async function captureLog(body: () => Promise<unknown>): Promise<string> {
  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    await body();
  } finally {
    console.log = realLog;
  }
  return captured.join("\n");
}

const WIRED_PACKAGE = `{
  "name": "@acme/demo-app",
  "scripts": {
    "dev": "node .kerstel/exec.cjs -- next dev"
  }
}
`;

test("parseInitArgs rejects a key list that looks like a flag, or a key in both lists", () => {
  expect(parseInitArgs(["--keep", "-x"], "/tmp/p")).toEqual({
    error: expect.stringContaining("--keep") as unknown as string,
  });
  expect(parseInitArgs(["--keep", "A", "--global", "A"], "/tmp/p")).toEqual({
    error: expect.stringContaining("A") as unknown as string,
  });
});

test("--dry-run leaves KERSTEL_HOME exactly as it found it", async () => {
  const home = isolateEnv({ prefix: "init-dry-home" });
  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SECRET_TOKEN=do-not-touch-me\nOTHER=kerstel://demo-app/OTHER\n",
  });

  expect(await runInit(options(root, ["--dry-run", "--yes"]), new DefaultsPrompter())).toBe(0);
  expect(readdirSync(home)).toEqual([]);
});

test("--dry-run lists only the references the vault really lacks", async () => {
  isolateEnv({ prefix: "init-dry-missing" });
  await openTestVault((vault) => vault.setSecret({ scope: "demo-app", key: "HAVE_IT" }, "stored"));

  const root = makeProject({
    "package.json": WIRED_PACKAGE,
    ".kerstel/exec.cjs": launcherSource(),
    ".env": "HAVE_IT=kerstel://demo-app/HAVE_IT\nNEED_IT=kerstel://demo-app/NEED_IT\n",
  });

  const out = await captureLog(() => runInit(options(root, ["--dry-run"]), new ScriptedPrompter([])));
  expect(out).toContain("kerstel://demo-app/NEED_IT");
  expect(out).not.toContain("kerstel://demo-app/HAVE_IT");
});

test("the teammate flow stores nothing when the user declines the plan", async () => {
  isolateEnv({ prefix: "init-teammate-no" });

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=kerstel://demo-app/SERVICE_TOKEN\n",
  });

  const prompter = new ScriptedPrompter(["typed-then-declined", "cancel"]);
  expect(await runInit(options(root), prompter)).toBe(0);
  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "demo-app", key: "SERVICE_TOKEN" })).toBeNull();
  });
});

test("the teammate flow stores values when nothing else needs changing", async () => {
  isolateEnv({ prefix: "init-teammate-only" });

  const root = makeProject({
    "package.json": WIRED_PACKAGE,
    ".kerstel/exec.cjs": launcherSource(),
    ".env": "SERVICE_TOKEN=kerstel://demo-app/SERVICE_TOKEN\n",
  });

  expect(await runInit(options(root), new ScriptedPrompter(["only-value"]))).toBe(0);
  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "demo-app", key: "SERVICE_TOKEN" })).toBe("only-value");
    expect(vault.listProjects().map((p) => p.name)).toContain("demo-app");
  });
});

test("--keep or --global naming a key no env file defines is reported", async () => {
  isolateEnv({ prefix: "init-unknown-key" });

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "REAL_KEY=value\n",
  });

  const out = await captureLog(() =>
    runInit(options(root, ["--dry-run", "--yes", "--keep", "TYPO_KEY", "--global", "OTHER_TYPO"]), new DefaultsPrompter()),
  );
  expect(out).toContain("TYPO_KEY");
  expect(out).toContain("OTHER_TYPO");
});

test("init says so when package.json is not valid JSON", async () => {
  isolateEnv({ prefix: "init-bad-json" });
  const root = makeProject({ "package.json": "{ nope", ".env": "A=1\n" });

  const out = await captureLog(() => runInit(options(root, ["--yes"]), new DefaultsPrompter()));
  expect(out).toContain("not valid JSON");
});

test("a project whose only env file is a broken symlink says so", async () => {
  isolateEnv({ prefix: "init-only-broken" });
  const root = makeProject({ "package.json": NPM_PACKAGE });
  symlinkSync(join(root, "gone"), join(root, ".env"));

  const out = await captureLog(() => runInit(options(root, ["--yes"]), new DefaultsPrompter()));
  expect(out).toContain(".env could not be read");
  expect(out).not.toContain("No .env files here");
});

test("--keep naming a key that is already a reference is reported", async () => {
  isolateEnv({ prefix: "init-keep-ref" });
  const root = makeProject({
    "package.json": WIRED_PACKAGE,
    ".kerstel/exec.cjs": launcherSource(),
    ".env": "ALREADY=kerstel://demo-app/ALREADY\nPLAIN=value\n",
  });

  const out = await captureLog(() =>
    runInit(options(root, ["--dry-run", "--yes", "--keep", "ALREADY"]), new DefaultsPrompter()),
  );
  expect(out).toContain("ALREADY");
  expect(out).toContain("already a reference");
});

/** Answers from its script, then cancels (Ctrl-C) at the next prompt. */
class CancellingPrompter extends ScriptedPrompter {
  private remaining: number;

  constructor(answers: (string | string[])[]) {
    super(answers);
    this.remaining = answers.length;
  }

  private take(): void {
    if (this.remaining === 0) throw new CancelledError();
    this.remaining -= 1;
  }

  override async select<T extends string>(question: string, choices: Choice<T>[], defaultValue: T): Promise<T> {
    this.take();
    return super.select(question, choices, defaultValue);
  }

  override async multiselect<T extends string>(question: string, choices: Choice<T>[], initial: T[]): Promise<T[]> {
    this.take();
    return super.multiselect(question, choices, initial);
  }

  override async text(question: string, options?: TextOptions): Promise<string> {
    this.take();
    return super.text(question, options);
  }
}

test("accepting the suggestions stores exactly what --yes would", async () => {
  isolateEnv({ prefix: "init-accept" });
  await bootLocalDaemon();
  const files = {
    "package.json": NPM_PACKAGE,
    ".env": "NODE_ENV=development\nDATABASE_URL=postgres://u:pw@localhost:5432/app\n",
  };
  const interactiveRoot = makeProject(files);
  expect(await runInit(options(interactiveRoot), new ScriptedPrompter(["accept", "apply"]))).toBe(0);
  const yesRoot = makeProject(files);
  expect(await runInit({ ...options(yesRoot), yes: true }, new DefaultsPrompter())).toBe(0);
  expect(readFileSync(join(interactiveRoot, ".env"), "utf8")).toBe(readFileSync(join(yesRoot, ".env"), "utf8"));
});

test("changing some asks only about the ticked keys", async () => {
  isolateEnv({ prefix: "init-change" });
  await bootLocalDaemon();
  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "NODE_ENV=development\nDATABASE_URL=postgres://u:pw@localhost:5432/app\n",
  });
  const prompter = new ScriptedPrompter(["change", ["NODE_ENV"], "project", "accept", "apply"]);
  expect(await runInit(options(root), prompter)).toBe(0);
  expect(readFileSync(join(root, ".env"), "utf8")).toContain("NODE_ENV=kerstel://demo-app/NODE_ENV");
  expect(prompter.asked.filter((q) => q.startsWith("DATABASE_URL"))).toEqual([]);
});

test("showing the full diff first, then applying", async () => {
  isolateEnv({ prefix: "init-diff" });
  await bootLocalDaemon();
  const root = makeProject({ "package.json": NPM_PACKAGE, ".env": "DATABASE_URL=postgres://u:pw@localhost/app\n" });
  const prompter = new ScriptedPrompter(["accept", "diff", "apply"]);
  expect(await runInit(options(root), prompter)).toBe(0);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("DATABASE_URL=kerstel://demo-app/DATABASE_URL\n");
});

test("cancelling at any prompt writes nothing", async () => {
  isolateEnv({ prefix: "init-cancel" });
  const original = "DATABASE_URL=postgres://u:pw@localhost/app\n";
  for (const answers of [[], ["accept"], ["each"]]) {
    const root = makeProject({ "package.json": NPM_PACKAGE, ".env": original });
    const prompter = new CancellingPrompter(answers);
    expect(await runInit(options(root), prompter)).toBe(130);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(original);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(NPM_PACKAGE);
  }
});

test("the overview never prints a vault-bound value", async () => {
  isolateEnv({ prefix: "init-no-leak" });
  await bootLocalDaemon();
  const root = makeProject({ "package.json": NPM_PACKAGE, ".env": "DB_PASSWORD=correct-horse-battery\n" });
  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await runInit(options(root), new ScriptedPrompter(["accept", "diff", "apply"]))).toBe(0);
  } finally {
    console.log = realLog;
  }
  expect(captured.join("\n")).not.toContain("correct-horse-battery");
});

test("the .gitignore answer is only written once the changes are applied", async () => {
  isolateEnv({ prefix: "init-gitignore-cancel" });
  const gitignore = "node_modules/\n.env\n";
  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=a-secret-value\n",
    ".gitignore": gitignore,
  });
  const prompter = new ScriptedPrompter(["accept", "remove", "cancel"]);
  expect(await runInit(options(root), prompter)).toBe(0);
  expect(prompter.asked.slice(1)).toEqual([
    "Remove the .env lines from .gitignore so these files can be committed?",
    "Apply these changes?",
  ]);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(gitignore);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("SERVICE_TOKEN=a-secret-value\n");
});

test("the overview shows a config value in full, but a secret moved to plain text only as its length", async () => {
  isolateEnv({ prefix: "init-moved-plain" });
  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "PORT=3000\nAPI_TOKEN=moved-to-plaintext-secret\n",
  });
  const out = await captureLog(() =>
    runInit(options(root, ["--dry-run"]), new ScriptedPrompter(["change", ["API_TOKEN"], "plaintext", "accept"])),
  );
  expect(out).not.toContain("moved-to-plaintext-secret");
  expect(out).toMatch(/^\s+API_TOKEN\s+•••• 25 chars\s/m);
  expect(out).toMatch(/^\s+PORT\s+3000\s/m);
});

test("under --yes the overview shows config values but never a credential-shaped one", async () => {
  isolateEnv({ prefix: "init-yes-display" });
  const harmless = "a".repeat(60);
  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env":
      "PORT=3000\nNODE_ENV=development\nDB_PASSWORD=12345678\n" +
      "SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T0/B0/webhookpathsecret\n" +
      "LOG_LEVEL=\u001b]0;pwned\u0007debug\n" +
      `PUBLIC_TAGLINE=${harmless}\n`,
  });
  const out = await captureLog(() => runInit(options(root, ["--dry-run", "--yes"]), new DefaultsPrompter()));
  expect(out).not.toContain("12345678");
  expect(out).not.toContain("webhookpathsecret");
  expect(out).not.toContain("\u001b]0;");
  expect(out).toMatch(/^\s+DB_PASSWORD\s+•••• 8 chars\s/m);
  expect(out).toMatch(/^\s+PORT\s+3000\s/m);
  expect(out).toMatch(/^\s+NODE_ENV\s+development\s/m);
  expect(out).not.toContain(harmless);
  expect(out).toContain(`${"a".repeat(39)}…`);
});

// ---------------------------------------------------------------------------
// The launcher. Spec 2026-09-21 §4.1.

test("init writes the launcher, rewrites a stale or edited one, and leaves a current one alone", async () => {
  isolateEnv({ prefix: "init-launcher" });
  await bootLocalDaemon();

  const root = makeProject({ "package.json": NPM_PACKAGE, ".env": "API_KEY=sk-launcher\n" });
  expect(await runInit(options(root), new ScriptedPrompter(["accept", "apply"]))).toBe(0);
  const path = join(root, ".kerstel", "exec.cjs");
  expect(readFileSync(path, "utf8")).toBe(launcherSource());

  // Current: nothing to change, nothing asked.
  const captured: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await runInit(options(root), new ScriptedPrompter([]))).toBe(0);
  } finally {
    console.log = original;
  }
  expect(captured.join("\n")).toContain("Already migrated");

  // Edited: rewritten on the next run.
  writeFileSync(path, `${launcherSource()}// edited\n`);
  expect(await runInit(options(root), new ScriptedPrompter(["apply"]))).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(launcherSource());

  // Stale: rewritten too.
  writeFileSync(path, launcherSource().replace("format 1.", "format 0."));
  expect(await runInit(options(root), new ScriptedPrompter(["apply"]))).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(launcherSource());
});

test("init warns when .gitignore hides the launcher's directory", async () => {
  isolateEnv({ prefix: "init-launcher-gitignore" });
  await bootLocalDaemon();

  const root = makeProject({ "package.json": NPM_PACKAGE, ".env": "API_KEY=sk-launcher\n", ".gitignore": ".kerstel/\n" });
  const captured: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await runInit(options(root), new ScriptedPrompter(["accept", "apply"]))).toBe(0);
  } finally {
    console.log = original;
  }
  expect(captured.join("\n")).toContain(".gitignore hides .kerstel/, so the launcher would not reach your deploy host");
});

test("init names a foreign .kerstel/exec.cjs before replacing it", async () => {
  isolateEnv({ prefix: "init-launcher-foreign" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "API_KEY=sk-launcher\n",
    ".kerstel/exec.cjs": "#!/bin/sh\necho mine\n",
  });
  const captured: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await runInit(options(root), new ScriptedPrompter(["accept", "apply"]))).toBe(0);
  } finally {
    console.log = original;
  }
  const out = captured.join("\n");
  expect(out).toContain("exists but is not Kerstel's launcher");
  expect(out).toContain("a file that is not Kerstel's is replaced by the launcher");
  expect(readFileSync(join(root, ".kerstel", "exec.cjs"), "utf8")).toBe(launcherSource());
});

test("init with nothing to wire writes no launcher and still passes its self-check", async () => {
  isolateEnv({ prefix: "init-no-launcher" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": '{\n  "name": "lifecycle-only",\n  "scripts": {\n    "postinstall": "patch-package"\n  }\n}\n',
    ".env": "API_KEY=sk-no-launcher\n",
  });
  expect(await runInit(options(root), new ScriptedPrompter(["accept", "apply"]))).toBe(0);
  expect(existsSync(join(root, ".kerstel"))).toBe(false);
});

test.each([".kerstel", ".kerstel/", "/.kerstel", "**/.kerstel/", ".kerstel/*", ".kerstel/**", ".kerstel/exec.cjs", "**/exec.cjs"])(
  "init warns when .gitignore hides the launcher with %j",
  async (pattern) => {
    isolateEnv({ prefix: "init-launcher-ignore" });
    await bootLocalDaemon();
    const root = makeProject({ "package.json": NPM_PACKAGE, ".env": "API_KEY=sk-x\n", ".gitignore": `node_modules\n${pattern}\n` });
    const captured: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      expect(await runInit(options(root), new ScriptedPrompter(["accept", "apply"]))).toBe(0);
    } finally {
      console.log = original;
    }
    expect(captured.join("\n")).toContain(".gitignore hides .kerstel/");
  },
);

test("init does not warn for a .gitignore that only negates or names something else", async () => {
  isolateEnv({ prefix: "init-launcher-noignore" });
  await bootLocalDaemon();
  const root = makeProject({ "package.json": NPM_PACKAGE, ".env": "API_KEY=sk-x\n", ".gitignore": "!.kerstel/\n.kerstel-cache\n" });
  const captured: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await runInit(options(root), new ScriptedPrompter(["accept", "apply"]))).toBe(0);
  } finally {
    console.log = original;
  }
  expect(captured.join("\n")).not.toContain(".gitignore hides");
});

const API_PACKAGE = (name: string) => `{\n  "name": "${name}",\n  "scripts": {\n    "dev": "vite"\n  }\n}\n`;

test("a second checkout of the same package is registered beside the first", async () => {
  isolateEnv({ prefix: "init-checkouts" });
  await bootLocalDaemon();
  const main = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-aaaa-1111\n" });
  const worktree = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=kerstel://api/API_TOKEN\n" });

  expect(await runInit({ ...options(main), yes: true }, new DefaultsPrompter())).toBe(0);
  const log = captureConsoleLog();
  let code: number;
  try {
    code = await runInit({ ...options(worktree), yes: true }, new DefaultsPrompter());
  } finally {
    log.restore();
  }
  expect(code).toBe(0);
  expect(log.text()).toContain("Another checkout of api is at");

  await openTestVault((vault) => {
    const rows = vault.listProjects().filter((p) => p.name === "api");
    expect(rows.map((p) => p.rootPath).sort()).toEqual([realpathSync(main), realpathSync(worktree)].sort());
    expect(rows.every((p) => p.packageName === "@acme/api")).toBe(true);
    expect(vault.getSecret({ scope: "api", key: "API_TOKEN" })).toBe("tok-aaaa-1111");
  });
});

test("a different package whose name slugifies the same is refused, naming the owner", async () => {
  isolateEnv({ prefix: "init-collision" });
  await bootLocalDaemon();
  const acme = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-aaaa-1111\n" });
  const other = makeProject({ "package.json": API_PACKAGE("@other/api"), ".env": "API_TOKEN=tok-bbbb-2222\n" });
  expect(await runInit({ ...options(acme), yes: true }, new DefaultsPrompter())).toBe(0);

  for (const extra of [[], ["--dry-run"]]) {
    const log = captureConsoleLog();
    let code: number;
    try {
      code = await runInit({ ...options(other, extra), yes: true }, new DefaultsPrompter());
    } finally {
      log.restore();
    }
    expect(code).toBe(2);
    expect(log.text()).toContain(`The scope "api" belongs to @acme/api at ${realpathSync(acme)}.`);
    expect(log.text()).not.toContain("tok-bbbb-2222");
  }
  expect(readFileSync(join(other, ".env"), "utf8")).toBe("API_TOKEN=tok-bbbb-2222\n");
});

test("an explicit --scope shares a scope with another package, and says so", async () => {
  isolateEnv({ prefix: "init-share" });
  await bootLocalDaemon();
  const acme = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-aaaa-1111\n" });
  const other = makeProject({ "package.json": API_PACKAGE("@other/api"), ".env": "OTHER_TOKEN=tok-cccc-3333\n" });
  expect(await runInit({ ...options(acme), yes: true }, new DefaultsPrompter())).toBe(0);

  const log = captureConsoleLog();
  let code: number;
  try {
    code = await runInit({ ...options(other, ["--scope", "api"]), yes: true }, new DefaultsPrompter());
  } finally {
    log.restore();
  }
  expect(code).toBe(0);
  expect(log.text()).toContain(`The scope "api" is also used by @acme/api at ${realpathSync(acme)}`);
  await openTestVault((vault) => {
    expect(vault.listProjects().filter((p) => p.name === "api")).toHaveLength(2);
  });
});

test("a re-run without --scope keeps the scope this folder was registered under", async () => {
  isolateEnv({ prefix: "init-rerun-scope" });
  await bootLocalDaemon();
  const root = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-aaaa-1111\n" });
  expect(await runInit({ ...options(root, ["--scope", "custom"]), yes: true }, new DefaultsPrompter())).toBe(0);
  writeFileSync(join(root, ".env"), "API_TOKEN=kerstel://custom/API_TOKEN\nNEW_TOKEN=tok-dddd-4444\n");
  expect(await runInit({ ...options(root), yes: true }, new DefaultsPrompter())).toBe(0);

  expect(readFileSync(join(root, ".env"), "utf8")).toContain("NEW_TOKEN=kerstel://custom/NEW_TOKEN");
  await openTestVault((vault) => {
    expect(vault.listProjects().map((p) => p.name)).toEqual(["custom"]);
  });
});

async function initQuietly(root: string, args: string[], prompter: Prompter) {
  const log = captureConsoleLog();
  try {
    return { code: await runInit(options(root, args), prompter), out: log.text() };
  } finally {
    log.restore();
  }
}

test("a value the vault already holds becomes a reference without being stored again", async () => {
  isolateEnv({ prefix: "init-same-value" });
  await bootLocalDaemon();
  await openTestVault((vault) => vault.setSecret({ scope: "api", key: "API_TOKEN" }, "tok-aaaa-1111"));
  const root = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-aaaa-1111\n" });

  const { code, out } = await initQuietly(root, ["--yes"], new DefaultsPrompter());
  expect(code).toBe(0);
  expect(out).toContain("already in the vault");
  expect(out).not.toContain("tok-aaaa-1111");
  // Nothing was stored: the run only registered the folder.
  expect(out).toContain("Registered api with the vault.");
  expect(out).not.toMatch(/Stored \d+ secret/);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_TOKEN=kerstel://api/API_TOKEN\n");
});

test("a differing value keeps the vault's by default, and the file's on request", async () => {
  isolateEnv({ prefix: "init-differs" });
  await bootLocalDaemon();
  await openTestVault((vault) => vault.setSecret({ scope: "api", key: "API_TOKEN" }, "tok-vault-0000"));

  const kept = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-file-1111\n" });
  const first = await initQuietly(kept, ["--yes"], new DefaultsPrompter());
  expect(first.code).toBe(0);
  expect(first.out).toContain("differs from the vault");
  expect(first.out).not.toContain("tok-file-1111");
  expect(first.out).not.toContain("tok-vault-0000");
  expect(readFileSync(join(kept, ".env"), "utf8")).toBe("API_TOKEN=kerstel://api/API_TOKEN\n");
  await openTestVault((vault) => expect(vault.getSecret({ scope: "api", key: "API_TOKEN" })).toBe("tok-vault-0000"));

  const used = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-file-2222\n" });
  const prompter = new ScriptedPrompter(["accept", "use", "apply"]);
  expect((await initQuietly(used, [], prompter)).code).toBe(0);
  expect(prompter.asked.some((q) => q.includes("already holds a different value"))).toBe(true);
  await openTestVault((vault) => expect(vault.getSecret({ scope: "api", key: "API_TOKEN" })).toBe("tok-file-2222"));
});

test("a file value dropped for the vault's is saved in the backup, and uninstall names it", async () => {
  isolateEnv({ prefix: "init-differs-kept-backup" });
  await bootLocalDaemon();
  await openTestVault((vault) => vault.setSecret({ scope: "api", key: "API_TOKEN" }, "tok-vault-0000"));
  const root = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-file-1111\n" });
  expect((await initQuietly(root, ["--yes"], new DefaultsPrompter())).code).toBe(0);

  const { key } = await loadOrCreateDataKey();
  const [timestamp] = listBackups("api");
  const saved = readBackupVault("api", timestamp!, key);
  expect(saved.map((entry) => `${entry.scope}/${entry.key}`)).toEqual(["api/API_TOKEN"]);
  expect(saved[0]!.value === "tok-file-1111").toBe(true);

  const plan = await openTestVault((vault) => planUninstall(vault, key));
  expect(plan.backupOnly.map((entry) => [entry.project, entry.key, entry.files])).toEqual([
    ["api", "API_TOKEN", ["vault.enc"]],
  ]);
  expect(JSON.stringify(plan)).not.toContain("tok-file-1111");
});

test("a vault value replaced by the file's is saved in the backup, and uninstall names it", async () => {
  isolateEnv({ prefix: "init-differs-used-backup" });
  await bootLocalDaemon();
  await openTestVault((vault) => vault.setSecret({ scope: "api", key: "API_TOKEN" }, "tok-vault-0000"));
  const root = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-file-2222\n" });
  expect((await initQuietly(root, [], new ScriptedPrompter(["accept", "use", "apply"]))).code).toBe(0);

  const { key } = await loadOrCreateDataKey();
  const [timestamp] = listBackups("api");
  const saved = readBackupVault("api", timestamp!, key);
  expect(saved.map((entry) => `${entry.scope}/${entry.key}`)).toEqual(["api/API_TOKEN"]);
  expect(saved[0]!.value === "tok-vault-0000").toBe(true);

  const plan = await openTestVault((vault) => planUninstall(vault, key));
  expect(plan.backupOnly.map((entry) => [entry.project, entry.key, entry.files])).toEqual([
    ["api", "API_TOKEN", ["vault.enc"]],
  ]);
  expect(JSON.stringify(plan)).not.toContain("tok-vault-0000");
});

test("an existing global entry sets the destination, and --keep still wins", async () => {
  isolateEnv({ prefix: "init-global-entry" });
  await bootLocalDaemon();
  await openTestVault((vault) => vault.setSecret({ scope: "global", key: "SHARED_TOKEN" }, "tok-shared-5555"));
  const root = makeProject({
    "package.json": API_PACKAGE("@acme/api"),
    ".env": "SHARED_TOKEN=tok-shared-5555\nKEPT_TOKEN=tok-kept-6666\n",
  });
  await openTestVault((vault) => vault.setSecret({ scope: "api", key: "KEPT_TOKEN" }, "tok-other-7777"));

  expect((await initQuietly(root, ["--yes", "--keep", "KEPT_TOKEN"], new DefaultsPrompter())).code).toBe(0);
  const env = readFileSync(join(root, ".env"), "utf8");
  expect(env).toContain("SHARED_TOKEN=kerstel://global/SHARED_TOKEN");
  expect(env).toContain("KEPT_TOKEN=tok-kept-6666");
  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "api", key: "SHARED_TOKEN" })).toBeNull();
    expect(vault.getSecret({ scope: "api", key: "KEPT_TOKEN" })).toBe("tok-other-7777");
  });
});

test("a shared value that differs is left alone, and the key stays with this project", async () => {
  isolateEnv({ prefix: "init-shared-differs" });
  await bootLocalDaemon();
  await openTestVault((vault) => {
    vault.setSecret({ scope: "global", key: "DATABASE_URL" }, "postgres://u:pw-other@db.example/other");
    // A name the classifier suggests for the shared vault on its own.
    vault.setSecret({ scope: "global", key: "STRIPE_SECRET_KEY" }, "sk-shared-8888");
  });
  const root = makeProject({
    "package.json": API_PACKAGE("@acme/api"),
    ".env": "DATABASE_URL=postgres://u:pw-mine@db.example/mine\nSTRIPE_SECRET_KEY=sk-mine-9999\n",
  });

  const prompter = new ScriptedPrompter(["accept", "apply"]);
  const { code, out } = await initQuietly(root, [], prompter);
  expect(code).toBe(0);
  expect(prompter.asked.some((q) => q.includes("already holds a different value"))).toBe(false);
  expect(out).toContain("differs from the shared vault");
  expect(out).not.toContain("pw-mine");
  expect(out).not.toContain("pw-other");
  expect(out).not.toContain("sk-mine-9999");
  expect(out).not.toContain("sk-shared-8888");

  const env = readFileSync(join(root, ".env"), "utf8");
  expect(env).toContain("DATABASE_URL=kerstel://api/DATABASE_URL");
  expect(env).toContain("STRIPE_SECRET_KEY=kerstel://api/STRIPE_SECRET_KEY");
  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "global", key: "DATABASE_URL" })).toBe("postgres://u:pw-other@db.example/other");
    expect(vault.getSecret({ scope: "global", key: "STRIPE_SECRET_KEY" })).toBe("sk-shared-8888");
    expect(vault.getSecret({ scope: "api", key: "DATABASE_URL" })).toBe("postgres://u:pw-mine@db.example/mine");
    expect(vault.getSecret({ scope: "api", key: "STRIPE_SECRET_KEY" })).toBe("sk-mine-9999");
  });
});

test("one by one, a key kept out of a differing shared vault is suggested for this project", async () => {
  isolateEnv({ prefix: "init-shared-each" });
  await bootLocalDaemon();
  await openTestVault((vault) => vault.setSecret({ scope: "global", key: "STRIPE_SECRET_KEY" }, "sk-shared-8888"));
  const root = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "STRIPE_SECRET_KEY=sk-mine-9999\n" });

  const hints: string[] = [];
  const prompter = new (class extends ScriptedPrompter {
    override async select<T extends string>(question: string, choices: Choice<T>[], defaultValue: T): Promise<T> {
      if (question.startsWith("STRIPE_SECRET_KEY · 1 of 1")) {
        hints.push(...choices.filter((c) => c.hint?.includes("(suggested)")).map((c) => c.value));
      }
      return super.select(question, choices, defaultValue);
    }
  })(["each", "project", "accept", "apply"]);
  expect((await initQuietly(root, [], prompter)).code).toBe(0);
  expect(hints).toEqual(["project"]);
});

test("choosing the shared vault for a differing key still asks which value stays", async () => {
  isolateEnv({ prefix: "init-shared-chosen" });
  await bootLocalDaemon();
  await openTestVault((vault) => vault.setSecret({ scope: "global", key: "DATABASE_URL" }, "postgres://shared-db"));
  const root = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "DATABASE_URL=postgres://mine-db\n" });

  const prompter = new ScriptedPrompter(["keep", "apply"]);
  expect((await initQuietly(root, ["--global", "DATABASE_URL"], prompter)).code).toBe(0);
  expect(prompter.asked.some((q) => q.includes("kerstel://global/DATABASE_URL already holds a different value"))).toBe(
    true,
  );
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("DATABASE_URL=kerstel://global/DATABASE_URL\n");
  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "global", key: "DATABASE_URL" })).toBe("postgres://shared-db");
    expect(vault.getSecret({ scope: "api", key: "DATABASE_URL" })).toBeNull();
  });
});

test("--dry-run marks a key the vault holds without comparing values", async () => {
  isolateEnv({ prefix: "init-dry-entry" });
  await openTestVault((vault) => vault.setSecret({ scope: "api", key: "API_TOKEN" }, "tok-vault-0000"));
  const root = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-file-1111\n" });
  const { code, out } = await initQuietly(root, ["--dry-run", "--yes"], new DefaultsPrompter());
  expect(code).toBe(0);
  // The overview row's note is exactly "in the vault": "already in the vault" must not satisfy it.
  const row = out.split("\n").find((line) => line.includes("API_TOKEN") && line.includes("in the vault"));
  expect(row).toBeDefined();
  expect(row).not.toContain("already in the vault");
  expect(out).not.toContain("differs from the vault");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_TOKEN=tok-file-1111\n");
});
