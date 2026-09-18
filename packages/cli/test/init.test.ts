import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand, parseInitArgs, runInit, type InitOptions } from "../src/commands/init";
import { startDaemon, type DaemonHandle } from "../src/daemon/server";
import { ensureToken } from "../src/daemon/token";
import { collectKeys, loadEnvFiles } from "../src/init/collect";
import { discoverEnvFiles } from "../src/init/detect";
import { DefaultsPrompter, ScriptedPrompter } from "../src/init/prompts";
import { backupsDir, socketPath } from "../src/paths";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

let handle: DaemonHandle | null = null;
let daemonVault: Vault | null = null;

/**
 * `init`'s self-check spawns `kerstel exec -- node -e ...`, which needs a
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
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
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

  // Three keys -> three `choose` answers, then apply, then .gitignore is not
  // asked (this project has none).
  const prompter = new ScriptedPrompter(["plaintext", "project", "global", true]);
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
    "dev": "kerstel exec -- next dev",
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

  expect(await runInit(options(root), new ScriptedPrompter(["project", true]))).toBe(0);

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

test("a bun project also gets a bunfig preload", async () => {
  isolateEnv({ prefix: "init-bun" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": '{\n  "name": "bunny",\n  "scripts": {\n    "dev": "bun run index.ts"\n  }\n}\n',
    "bun.lock": "",
    ".env": "SERVICE_TOKEN=bun-secret-value\n",
  });

  expect(await runInit(options(root), new ScriptedPrompter(["project", true]))).toBe(0);

  const bunfig = readFileSync(join(root, "bunfig.toml"), "utf8");
  expect(bunfig).toContain("preload = [");
  expect(bunfig).toContain("preload.cjs");
  expect(readFileSync(join(root, "package.json"), "utf8")).toContain(
    '"dev": "kerstel exec -- bun run index.ts"',
  );
});

test("a second run reports an already-migrated project and changes nothing", async () => {
  isolateEnv({ prefix: "init-again" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=first-run-value\n",
  });
  expect(await runInit(options(root), new ScriptedPrompter(["project", true]))).toBe(0);

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

  // One `text` for the missing value, then the apply confirm (this fixture's
  // scripts are not wired yet, so there is still a change to approve).
  const prompter = new ScriptedPrompter(["teammate-supplied-value", true]);
  expect(await runInit(options(root), prompter)).toBe(0);
  expect(prompter.asked[0]).toContain("kerstel://demo-app/SERVICE_TOKEN");

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

  // Both keys are decided by flags, so the only question is the apply confirm.
  expect(
    await runInit(options(root, ["--keep", "KEEP_ME", "--global", "SHARE_ME"]), new ScriptedPrompter([true])),
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
  // choose, apply, .gitignore -> no
  expect(await runInit(options(rootDefault), new ScriptedPrompter(["project", true, false]))).toBe(0);
  expect(readFileSync(join(rootDefault, ".gitignore"), "utf8")).toBe(gitignore);

  const rootYes = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=a-secret-value\n",
    ".gitignore": gitignore,
  });
  expect(await runInit(options(rootYes), new ScriptedPrompter(["project", true, true]))).toBe(0);
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
    expect(await runInit(options(root, ["--dry-run"]), new ScriptedPrompter(["project", "global"]))).toBe(0);
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
      new ScriptedPrompter(["project", "global", true]),
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
    code = await runInit(options(root), new ScriptedPrompter(["project", true]));
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
      new ScriptedPrompter(["project", true, false]),
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
  expect(output).not.toContain("they now hold references, not secrets");
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
    expect(await runInit(options(root), new ScriptedPrompter(["project", true, false]))).toBe(0);
  } finally {
    console.log = realLog;
  }

  const output = captured.join("\n");
  expect(output).toContain("They now hold references, not secrets");
  expect(output).not.toContain("still holds a plaintext value");
});
