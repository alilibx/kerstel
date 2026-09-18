import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  CancelledError,
  DefaultsPrompter,
  ScriptedPrompter,
  type Choice,
  type TextOptions,
} from "../src/init/prompts";
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
    '"dev": "kerstel exec -- bun run index.ts"',
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
    expect(
      await runInit(options(root), new ScriptedPrompter(["each", "project", "accept", "keep", "apply"])),
    ).toBe(0);
  } finally {
    console.log = realLog;
  }

  const output = captured.join("\n");
  expect(output).toContain("They now hold references, not secrets");
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
    "dev": "kerstel exec -- next dev"
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

  constructor(answers: (string | boolean | string[])[]) {
    super(answers);
    this.remaining = answers.length;
  }

  private take(): void {
    if (this.remaining === 0) throw new CancelledError();
    this.remaining -= 1;
  }

  override async confirm(question: string, defaultValue: boolean): Promise<boolean> {
    this.take();
    return super.confirm(question, defaultValue);
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
