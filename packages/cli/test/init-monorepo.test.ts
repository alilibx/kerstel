import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseInitArgs, runInit, suppliedValue, type InitOptions } from "../src/commands/init";
import { startDaemon, type DaemonHandle } from "../src/daemon/server";
import { ensureToken } from "../src/daemon/token";
import { DefaultsPrompter, ScriptedPrompter } from "../src/init/prompts";
import { socketPath } from "../src/paths";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { captureLog } from "./helpers/capture-log";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

/** Monorepo spec §4: `kerstel init` at a workspace root. */

let handle: DaemonHandle | null = null;
let daemonVault: Vault | null = null;
const createdDirs: string[] = [];

async function bootLocalDaemon(): Promise<void> {
  const token = ensureToken();
  const { key, backend } = await loadOrCreateDataKey();
  daemonVault = openVault(key);
  handle = await startDaemon({ vault: daemonVault, socketPath: socketPath(), token, backendName: backend });
}

async function withVault<T>(use: (vault: Vault) => T): Promise<T> {
  const { key } = await loadOrCreateDataKey();
  const vault = openVault(key);
  try {
    return use(vault);
  } finally {
    vault.close();
  }
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  daemonVault?.close();
  daemonVault = null;
  const home = process.env.KERSTEL_HOME;
  if (home && home.startsWith(tmpdir())) createdDirs.push(home);
  restoreEnv();
  while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

function makeTree(files: Record<string, string>): string {
  // realpath: the vault stores canonical roots, and macOS tmpdir is a symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kerstel-monorepo-")));
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

const pkg = (name: string, extra: object = {}) =>
  `${JSON.stringify({ name, scripts: { dev: "node server.js" }, ...extra }, null, 2)}\n`;

/** A root with env files of its own and two members, sharing one Stripe key. */
function shop(): string {
  return makeTree({
    "package.json": pkg("shop", { workspaces: ["apps/*"] }),
    ".env": "TURBO_TOKEN=root-turbo-token-1\n",
    "apps/web/package.json": pkg("@shop/web"),
    "apps/web/.env": "STRIPE_SECRET_KEY=shared-stripe-value-1\nSESSION_SECRET=web-session-1\nPORT=3000\n",
    "apps/api/package.json": pkg("@shop/api"),
    "apps/api/.env": "STRIPE_SECRET_KEY=shared-stripe-value-1\nSESSION_SECRET=api-session-2\n",
    "packages/lib/package.json": pkg("@shop/lib"),
  });
}

test("--yes sets up every package, suggesting the shared vault for a value two packages share", async () => {
  isolateEnv({ prefix: "mono-yes" });
  await bootLocalDaemon();
  const root = shop();
  const log = captureLog();
  let code: number;
  try {
    code = await runInit(options(root, ["--yes"]), new DefaultsPrompter());
  } finally {
    log.restore();
  }
  expect(code).toBe(0);
  const out = log.text();
  expect(out).toContain("Workspace: 3 packages with .env files");
  expect(out).toContain("same value in apps/api and apps/web");

  expect(readFileSync(join(root, ".env"), "utf8")).toBe("TURBO_TOKEN=ks:shop\n");
  expect(readFileSync(join(root, "apps/web/.env"), "utf8")).toBe(
    "STRIPE_SECRET_KEY=ks:global\nSESSION_SECRET=ks:web\nPORT=3000\n",
  );
  expect(readFileSync(join(root, "apps/api/.env"), "utf8")).toBe("STRIPE_SECRET_KEY=ks:global\nSESSION_SECRET=ks:api\n");
  for (const dir of ["", "apps/web", "apps/api"]) {
    expect(readFileSync(join(root, dir, "package.json"), "utf8")).toContain("node .kerstel/exec.cjs -- node server.js");
    expect(existsSync(join(root, dir, ".kerstel/exec.cjs"))).toBe(true);
  }
  expect(readFileSync(join(root, "packages/lib/package.json"), "utf8")).not.toContain("exec.cjs");

  await withVault((vault) => {
    expect(vault.getSecret({ scope: "global", key: "STRIPE_SECRET_KEY" })).toBe("shared-stripe-value-1");
    expect(vault.getSecret({ scope: "web", key: "SESSION_SECRET" })).toBe("web-session-1");
    expect(vault.getSecret({ scope: "api", key: "SESSION_SECRET" })).toBe("api-session-2");
    expect(vault.listProjects().map((p) => [p.name, p.rootPath]).sort()).toEqual(
      [
        ["api", join(root, "apps/api")],
        ["shop", root],
        ["web", join(root, "apps/web")],
      ].sort(),
    );
  });
  // No value appears in what was printed.
  for (const value of ["shared-stripe-value-1", "web-session-1", "api-session-2", "root-turbo-token-1"]) {
    expect(out).not.toContain(value);
  }
});

test("picking some packages sets up only those", async () => {
  isolateEnv({ prefix: "mono-pick" });
  await bootLocalDaemon();
  const root = shop();
  const prompter = new ScriptedPrompter([[join(root, "apps/web")], "accept", "apply"]);
  const log = captureLog();
  try {
    expect(await runInit(options(root), prompter)).toBe(0);
  } finally {
    log.restore();
  }
  expect(prompter.asked[0]).toBe("Which packages should Kerstel set up?");
  expect(readFileSync(join(root, "apps/web/.env"), "utf8")).toContain("SESSION_SECRET=ks:web");
  // Alone, web shares no value with another package, so nothing is suggested for that reason.
  expect(log.text()).not.toContain("same value in");
  expect(readFileSync(join(root, "apps/api/.env"), "utf8")).toContain("api-session-2");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("TURBO_TOKEN=root-turbo-token-1\n");
});

test("an empty selection changes nothing", async () => {
  isolateEnv({ prefix: "mono-none" });
  const root = shop();
  const log = captureLog();
  try {
    expect(await runInit(options(root), new ScriptedPrompter([[]]))).toBe(0);
  } finally {
    log.restore();
  }
  expect(log.text()).toContain("Nothing selected. Nothing was changed.");
  expect(readFileSync(join(root, "apps/web/.env"), "utf8")).toContain("web-session-1");
  expect(existsSync(process.env.KERSTEL_HOME!)).toBe(true);
});

test("a workspace whose packages have no env files says so", async () => {
  isolateEnv({ prefix: "mono-empty" });
  const root = makeTree({
    "package.json": pkg("shop", { workspaces: ["apps/*"] }),
    "apps/web/package.json": pkg("@shop/web"),
  });
  const log = captureLog();
  try {
    expect(await runInit(options(root, ["--yes"]), new DefaultsPrompter())).toBe(1);
  } finally {
    log.restore();
  }
  expect(log.text()).toContain("No package in this workspace has a .env file.");
});

test("--dry-run labels every file with its package and writes nothing", async () => {
  isolateEnv({ prefix: "mono-dry" });
  const root = shop();
  const before = readFileSync(join(root, "apps/web/.env"), "utf8");
  const log = captureLog();
  try {
    expect(await runInit(options(root, ["--yes", "--dry-run"]), new DefaultsPrompter())).toBe(0);
  } finally {
    log.restore();
  }
  const out = log.text();
  expect(out).toContain("apps/web: .env: 2 values become references");
  expect(out).toContain("apps/api: package.json");
  expect(out).toContain("(root): .env");
  expect(readFileSync(join(root, "apps/web/.env"), "utf8")).toBe(before);
  expect(existsSync(join(process.env.KERSTEL_HOME!, "vault.db"))).toBe(false);
});

test("--scope renames the root package, and is refused when the root is not set up", async () => {
  isolateEnv({ prefix: "mono-scope" });
  const root = shop();
  const log = captureLog();
  try {
    expect(await runInit(options(root, ["--yes", "--dry-run", "--scope", "storefront"]), new DefaultsPrompter())).toBe(0);
    expect(log.text()).toContain("(root): Setting up storefront");
    expect(log.text()).toContain("apps/web: Setting up web");

    const noRootEnv = makeTree({
      "package.json": pkg("shop", { workspaces: ["apps/*"] }),
      "apps/web/package.json": pkg("@shop/web"),
      "apps/web/.env": "A_TOKEN=x\n",
    });
    expect(await runInit(options(noRootEnv, ["--yes", "--scope", "storefront"]), new DefaultsPrompter())).toBe(2);
    expect(log.text()).toContain("--scope names the package in this folder, and the root is not being set up.");
  } finally {
    log.restore();
  }
});

test("two members whose names give the same scope stop the run", async () => {
  isolateEnv({ prefix: "mono-dupe" });
  const root = makeTree({
    "package.json": pkg("shop", { workspaces: ["apps/*", "tools/*"] }),
    "apps/api/package.json": pkg("@shop/api"),
    "apps/api/.env": "A_TOKEN=x\n",
    "tools/api/package.json": pkg("@tools/api"),
    "tools/api/.env": "B_TOKEN=y\n",
  });
  const log = captureLog();
  try {
    expect(await runInit(options(root, ["--yes"]), new DefaultsPrompter())).toBe(2);
  } finally {
    log.restore();
  }
  expect(log.text()).toContain('apps/api and tools/api would both use the scope "api"');
});

test("a member whose scope belongs to another package is told to run init inside it", async () => {
  isolateEnv({ prefix: "mono-collide" });
  const elsewhere = makeTree({ "package.json": pkg("@other/web") });
  await withVault((vault) => vault.registerProject("web", elsewhere, "@other/web"));
  const root = shop();
  const log = captureLog();
  try {
    expect(await runInit(options(root, ["--yes"]), new DefaultsPrompter())).toBe(2);
  } finally {
    log.restore();
  }
  expect(log.text()).toContain('The scope "web" belongs to');
  expect(log.text()).toContain("inside apps/web");
});

test("Look right? lists keys with their package, and one .gitignore question covers every file", async () => {
  isolateEnv({ prefix: "mono-change" });
  await bootLocalDaemon();
  const root = shop();
  writeFileSync(join(root, ".gitignore"), "node_modules\n.env\n");
  writeFileSync(join(root, "apps/api/.gitignore"), "dist\n.env.local\n");
  const prompter = new ScriptedPrompter([
    [root, join(root, "apps/api"), join(root, "apps/web")],
    "change",
    ["apps/api: SESSION_SECRET"],
    "plaintext",
    "accept",
    "remove",
    "apply",
  ]);
  const log = captureLog();
  try {
    expect(await runInit(options(root), prompter)).toBe(0);
  } finally {
    log.restore();
  }
  expect(prompter.asked).toContain("apps/api: SESSION_SECRET · where should it go?");
  expect(prompter.asked.filter((q) => q.includes(".gitignore"))).toEqual([
    "Remove the .env lines from those 2 .gitignore files so these files can be committed?",
  ]);
  expect(readFileSync(join(root, "apps/api/.env"), "utf8")).toContain("SESSION_SECRET=api-session-2");
  expect(readFileSync(join(root, ".gitignore"), "utf8")).not.toMatch(/^\.env$/m);
  expect(readFileSync(join(root, "apps/api/.gitignore"), "utf8")).not.toContain(".env.local");
  expect(readFileSync(join(root, "apps/api/.gitignore"), "utf8")).toContain("dist");
});

test.skipIf(process.getuid?.() === 0)("a package that fails stops the run, and the ones before it stay set up", async () => {
  isolateEnv({ prefix: "mono-fail" });
  await bootLocalDaemon();
  const root = shop();
  chmodSync(join(root, "apps/web/.env"), 0o444);
  const log = captureLog();
  let code: number;
  try {
    code = await runInit(options(root, ["--yes"]), new DefaultsPrompter());
  } finally {
    log.restore();
    chmodSync(join(root, "apps/web/.env"), 0o644);
  }
  expect(code).toBe(1);
  const out = log.text();
  expect(out).toContain("apps/web: ");
  expect(out).toContain("(root), apps/api are set up. Fix apps/web, then run kerstel init here again to finish.");
  expect(readFileSync(join(root, "apps/api/.env"), "utf8")).toContain("ks:api");
});

test("--from-stdin values may nest by package path, or stay flat for every package", () => {
  const json = { "apps/web": { TOKEN: "web" }, TOKEN: "flat", ".": { ROOT_ONLY: "root" } };
  expect(suppliedValue(json, "apps/web", "TOKEN")).toBe("web");
  expect(suppliedValue(json, "apps/api", "TOKEN")).toBe("flat");
  expect(suppliedValue(json, ".", "ROOT_ONLY")).toBe("root");
  expect(suppliedValue(json, "apps/web", "MISSING")).toBeUndefined();
});

test("a key two packages hold with different values stays with each package", async () => {
  isolateEnv({ prefix: "mono-differ" });
  await bootLocalDaemon();
  const root = makeTree({
    "package.json": pkg("shop", { workspaces: ["apps/*"] }),
    "apps/web/package.json": pkg("@shop/web"),
    "apps/web/.env": "STRIPE_SECRET_KEY=web-stripe-account-1\n",
    "apps/api/package.json": pkg("@shop/api"),
    "apps/api/.env": "STRIPE_SECRET_KEY=api-stripe-account-2\n",
  });
  const log = captureLog();
  try {
    expect(await runInit(options(root, ["--yes"]), new DefaultsPrompter())).toBe(0);
  } finally {
    log.restore();
  }
  expect(log.text()).toContain("different values in apps/api and apps/web");
  await withVault((vault) => {
    expect(vault.getSecret({ scope: "web", key: "STRIPE_SECRET_KEY" })).toBe("web-stripe-account-1");
    expect(vault.getSecret({ scope: "api", key: "STRIPE_SECRET_KEY" })).toBe("api-stripe-account-2");
    expect(vault.getSecret({ scope: "global", key: "STRIPE_SECRET_KEY" })).toBeNull();
  });
});

test("two packages storing different values in one reference stop the run before any write", async () => {
  isolateEnv({ prefix: "mono-clash" });
  const root = makeTree({
    "package.json": pkg("shop", { workspaces: ["apps/*"] }),
    "apps/web/package.json": pkg("@shop/web"),
    "apps/web/.env": "STRIPE_SECRET_KEY=web-stripe-account-1\n",
    "apps/api/package.json": pkg("@shop/api"),
    "apps/api/.env": "STRIPE_SECRET_KEY=api-stripe-account-2\n",
  });
  const log = captureLog();
  try {
    expect(await runInit(options(root, ["--yes", "--global", "STRIPE_SECRET_KEY"]), new DefaultsPrompter())).toBe(2);
  } finally {
    log.restore();
  }
  expect(log.text()).toContain(
    "apps/api and apps/web would store different values in ks:global/STRIPE_SECRET_KEY",
  );
  expect(log.text()).not.toContain("web-stripe-account-1");
  expect(readFileSync(join(root, "apps/web/.env"), "utf8")).toBe("STRIPE_SECRET_KEY=web-stripe-account-1\n");
  await withVault((vault) => expect(vault.getSecret({ scope: "global", key: "STRIPE_SECRET_KEY" })).toBeNull());
});

test("the .gitignore question counts plaintext in packages and files this run leaves alone", async () => {
  isolateEnv({ prefix: "mono-ignore" });
  await bootLocalDaemon();
  const root = shop();
  writeFileSync(join(root, ".gitignore"), ".env\n.env.*\n");
  writeFileSync(join(root, "apps/web/.env.bak"), "OLD_TOKEN=stale-value-1\n");
  mkdirSync(join(root, "apps/web/docker"));
  writeFileSync(join(root, "apps/web/docker/.env"), "DB_PASSWORD=nested-value-1\n");
  const prompter = new ScriptedPrompter([[join(root, "apps/web")], "accept", "keep", "apply"]);
  const log = captureLog();
  try {
    expect(await runInit(options(root), prompter)).toBe(0);
  } finally {
    log.restore();
  }
  const warning = log.lines.find((line) => line.includes("committing these files would expose them"))!;
  expect(warning).toContain(".env: TURBO_TOKEN");
  expect(warning).toContain("apps/api/.env: SESSION_SECRET");
  expect(warning).toContain("apps/web/.env.bak: OLD_TOKEN");
  expect(warning).toContain("apps/web/docker/.env: DB_PASSWORD");
  expect(warning).not.toContain("stale-value-1");
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".env\n.env.*\n");
});
