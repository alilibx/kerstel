import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExecEnv, preloadPathFor, withBunPreload } from "../src/commands/exec";
import { EXIT_COMMAND_NOT_FOUND } from "../src/commands/spawn";
import { startDaemon, type DaemonHandle } from "../src/daemon/server";
import { ensureToken } from "../src/daemon/token";
import { runCli } from "../src/index";
import { socketPath } from "../src/paths";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { captureLog } from "./helpers/capture-log";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

let handle: DaemonHandle | null = null;
let vault: Vault | null = null;

/**
 * The daemon that serves THIS test's KERSTEL_HOME, on the real socketPath().
 * test/helpers/boot-daemon.ts deliberately does something else -- its own
 * throwaway vault on its own socket -- which the child process spawned by
 * `exec` would never find.
 */
async function bootLocalDaemon(): Promise<void> {
  const token = ensureToken();
  const { key, backend } = await loadOrCreateDataKey();
  vault = openVault(key);
  handle = await startDaemon({ vault, socketPath: socketPath(), token, backendName: backend });
}

const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  if (handle) await handle.close();
  handle = null;
  if (vault) vault.close();
  vault = null;
  restoreEnv();
});

test("buildExecEnv wires the hook without resolving anything", () => {
  const env = buildExecEnv({
    base: { PATH: "/usr/bin", OPENAI_API_KEY: "kerstel://global/OPENAI_API_KEY" },
    socketPath: "/tmp/k.sock",
    tokenFile: "/home/dev/.kerstel/session.token",
    hookDir: "/home/dev/.kerstel/hook",
  });

  expect(env.PATH).toBe("/usr/bin");
  expect(env.KERSTEL_SOCKET).toBe("/tmp/k.sock");
  expect(env.KERSTEL_TOKEN_FILE).toBe("/home/dev/.kerstel/session.token");
  // The token VALUE never enters an environment, under any name.
  expect(env).not.toHaveProperty("KERSTEL_TOKEN");
  expect(JSON.stringify(env)).not.toContain("session-token-value");
  expect(env.KERSTEL_HOOK_DIR).toBe("/home/dev/.kerstel/hook");
  // A reference stays a reference: resolving is `run`'s job, never `exec`'s.
  expect(env.OPENAI_API_KEY).toBe("kerstel://global/OPENAI_API_KEY");
  expect(env.NODE_OPTIONS).toBe(`--require ${JSON.stringify(preloadPathFor("/home/dev/.kerstel/hook"))}`);
});

test("buildExecEnv drops a KERSTEL_TOKEN inherited from an older Kerstel", () => {
  // The upgrade window: this process was hooked by a previous version, so its
  // environment still carries a live bearer token. It must not reach the child.
  const env = buildExecEnv({
    base: { PATH: "/usr/bin", KERSTEL_TOKEN: "session-token-value" },
    socketPath: "/tmp/k.sock",
    tokenFile: "/home/dev/.kerstel/session.token",
    hookDir: "/home/dev/.kerstel/hook",
  });

  expect(env).not.toHaveProperty("KERSTEL_TOKEN");
  expect(JSON.stringify(env)).not.toContain("session-token-value");
  expect(env.KERSTEL_TOKEN_FILE).toBe("/home/dev/.kerstel/session.token");
});

test("buildExecEnv appends to an existing NODE_OPTIONS and never duplicates", () => {
  const hookDir = "/home/dev/.kerstel/hook";
  const first = buildExecEnv({
    base: { NODE_OPTIONS: "--max-old-space-size=4096" },
    socketPath: "/tmp/k.sock",
    tokenFile: "/home/dev/.kerstel/session.token",
    hookDir,
  });
  expect(first.NODE_OPTIONS).toBe(
    `--max-old-space-size=4096 --require ${JSON.stringify(preloadPathFor(hookDir))}`,
  );

  const second = buildExecEnv({ base: first, socketPath: "/tmp/k.sock", tokenFile: "/home/dev/.kerstel/session.token", hookDir });
  expect(second.NODE_OPTIONS).toBe(first.NODE_OPTIONS);
});

test("buildExecEnv quotes a hook directory containing spaces", () => {
  const env = buildExecEnv({
    base: {},
    socketPath: "/tmp/k.sock",
    tokenFile: "/home/dev/.kerstel/session.token",
    hookDir: "/Users/dev name/.kerstel/hook",
  });
  expect(env.NODE_OPTIONS).toBe(
    `--require "${join("/Users/dev name/.kerstel/hook", "preload.cjs")}"`,
  );
});

test("exec with no command exits 2 with usage", async () => {
  isolateEnv({ prefix: "exec-usage" });
  expect(await runCli(["exec"])).toBe(2);
  expect(await runCli(["exec", "--"])).toBe(2);
});

test("exec runs a node command that resolves a reference through the daemon", async () => {
  isolateEnv({ prefix: "exec-node" });
  await runCli(["set", "global/EXEC_KEY", "--value", "exec-value"]);
  await bootLocalDaemon();

  const dir = mkdtempSync(join(tmpdir(), "kerstel-exec-app-"));
  const out = join(dir, "out.txt");
  const script = join(dir, "app.cjs");
  // stdio is inherited, so the child reports through a file, not a pipe.
  writeFileSync(
    script,
    `require("node:fs").writeFileSync(${JSON.stringify(out)}, String(process.env.EXEC_KEY));`,
  );

  process.env.EXEC_KEY = "kerstel://global/EXEC_KEY";
  const code = await runCli(["exec", "--", "node", script]);
  delete process.env.EXEC_KEY;

  expect(code).toBe(0);
  expect(readFileSync(out, "utf8")).toBe("exec-value");
});

test("exec refuses, without starting a daemon, when node_modules/.bin holds a kerstel", async () => {
  isolateEnv({ prefix: "exec-shadow" });
  const dir = mkdtempSync(join(tmpdir(), "kerstel-exec-shadow-"));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", ".bin", "kerstel"), "#!/bin/sh\nexec /usr/bin/true\n");
  process.chdir(dir);

  const out = join(dir, "ran.txt");
  const code = await runCli([
    "exec",
    "--",
    "node",
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(out)}, "ran")`,
  ]);

  expect(code).toBe(1);
  expect(existsSync(out)).toBe(false);
  expect(existsSync(socketPath())).toBe(false);
});

test("exec exits 127 and names the install command, without starting a daemon, when the executable is not on PATH", async () => {
  isolateEnv({ prefix: "exec-missing" });
  const dir = mkdtempSync(join(tmpdir(), "kerstel-exec-missing-"));
  writeFileSync(join(dir, "package.json"), '{"name":"app"}');
  writeFileSync(join(dir, "bun.lock"), "");
  process.chdir(dir);

  const log = captureLog();
  let code: number;
  try {
    code = await runCli(["exec", "--", "kerstel-test-no-such-executable", "dev"]);
  } finally {
    log.restore();
  }

  expect(code).toBe(EXIT_COMMAND_NOT_FOUND);
  expect(log.text()).toContain('"kerstel-test-no-such-executable" was not found on PATH');
  expect(log.text()).toContain("no node_modules yet");
  expect(log.text()).toContain("`bun install`");
  expect(log.text()).not.toContain("Executable not found in $PATH");
  // Refused before the vault opened or the daemon started.
  expect(existsSync(socketPath())).toBe(false);
});

test("exec propagates the child's exit code", async () => {
  isolateEnv({ prefix: "exec-code" });
  await bootLocalDaemon();
  expect(await runCli(["exec", "--", "node", "-e", "process.exit(7)"])).toBe(7);
});

test("exec passes the command through verbatim, flags and all", async () => {
  isolateEnv({ prefix: "exec-verbatim" });
  await bootLocalDaemon();

  const dir = mkdtempSync(join(tmpdir(), "kerstel-exec-argv-"));
  const out = join(dir, "argv.json");
  // A script file rather than `node -e`: node itself claims anything that
  // looks like an option before a script, so `-e` could only carry `--flag`
  // past it with node's own `--` in the way -- which would test node's
  // argument parsing instead of exec's pass-through.
  const script = join(dir, "argv.cjs");
  writeFileSync(
    script,
    `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`,
  );
  const code = await runCli(["exec", "--", "node", script, "--flag", "value with spaces"]);

  expect(code).toBe(0);
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["--flag", "value with spaces"]);
});

// Bun 1.3.10 IGNORES NODE_OPTIONS=--require (probed: a node child loads the
// preload, a bun child does not), so `exec` injects Bun's own `--preload`
// instead. This test is the guard on that path: if it starts failing, check
// whether Bun changed how it accepts a preload.
test("exec resolves a reference for a bun child", async () => {
  isolateEnv({ prefix: "exec-bun" });
  await runCli(["set", "global/BUN_KEY", "--value", "bun-value"]);
  await bootLocalDaemon();

  const dir = mkdtempSync(join(tmpdir(), "kerstel-exec-bun-"));
  const out = join(dir, "out.txt");
  const script = join(dir, "app.js");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, String(process.env.BUN_KEY));\n`,
  );

  process.env.BUN_KEY = "kerstel://global/BUN_KEY";
  const code = await runCli(["exec", "--", "bun", script]);
  delete process.env.BUN_KEY;

  expect(code).toBe(0);
  expect(readFileSync(out, "utf8")).toBe("bun-value");
});

test("withBunPreload injects the preload for bun commands only", () => {
  const hookDir = "/home/dev/.kerstel/hook";
  const preload = preloadPathFor(hookDir);
  // `--preload=<path>`, joined: the two-argument form makes Bun 1.3.10 lose
  // the `run` subcommand and skip the script entirely. See withBunPreload.
  const flag = `--preload=${preload}`;

  expect(withBunPreload(["bun", "run", "dev"], hookDir)).toEqual(["bun", flag, "run", "dev"]);
  expect(withBunPreload(["bunx", "vitest"], hookDir)).toEqual(["bunx", flag, "vitest"]);
  expect(withBunPreload(["/usr/local/bin/bun", "app.ts"], hookDir)).toEqual([
    "/usr/local/bin/bun",
    flag,
    "app.ts",
  ]);
  expect(withBunPreload(["node", "app.js"], hookDir)).toEqual(["node", "app.js"]);
  expect(withBunPreload(["vite", "build"], hookDir)).toEqual(["vite", "build"]);
  // Idempotent: a nested exec must not stack preloads.
  expect(withBunPreload(["bun", flag, "run", "dev"], hookDir)).toEqual(["bun", flag, "run", "dev"]);
});

test("exec still runs a `bun run <script>` and reaches its child", async () => {
  isolateEnv({ prefix: "exec-bun-run" });
  await runCli(["set", "global/RUN_KEY", "--value", "run-value"]);
  await bootLocalDaemon();

  // `bun run dev` is the shape the wizard writes into package.json, and it is
  // the shape a malformed preload flag breaks silently: Bun prints its usage
  // and exits 0 without running anything, so only checking the exit code
  // would call that a pass.
  const dir = mkdtempSync(join(tmpdir(), "kerstel-exec-bunrun-"));
  const out = join(dir, "out.txt");
  const script = join(dir, "app.cjs");
  writeFileSync(
    script,
    `require("node:fs").writeFileSync(${JSON.stringify(out)}, String(process.env.RUN_KEY));`,
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "exec-probe", scripts: { probe: `node ${JSON.stringify(script)}` } }),
  );

  process.chdir(dir);
  process.env.RUN_KEY = "kerstel://global/RUN_KEY";
  const code = await runCli(["exec", "--", "bun", "run", "probe"]);
  delete process.env.RUN_KEY;

  expect(code).toBe(0);
  expect(readFileSync(out, "utf8")).toBe("run-value");
});
