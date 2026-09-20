import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_COMMAND_NOT_EXECUTABLE,
  EXIT_COMMAND_NOT_FOUND,
  executableExists,
  missingExecutableMessage,
} from "../src/commands/spawn";
import { runCli } from "../src/index";
import { vaultPath } from "../src/paths";
import { captureLog } from "./helpers/capture-log";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

const dirs: string[] = [];
const originalCwd = process.cwd();
let restoreLog: (() => void) | null = null;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kerstel-${prefix}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  restoreLog?.();
  restoreLog = null;
  process.chdir(originalCwd);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  restoreEnv();
});

test("missingExecutableMessage names the executable and stops there outside a project", () => {
  const dir = tempDir("spawn-plain");
  const message = missingExecutableMessage("next", dir);
  expect(message).toContain('"next" was not found on PATH');
  expect(message).not.toContain("install");
});

test("missingExecutableMessage points at the lockfile's package manager when node_modules is missing", () => {
  const dir = tempDir("spawn-no-modules");
  writeFileSync(join(dir, "package.json"), '{"name":"app"}');
  writeFileSync(join(dir, "bun.lock"), "");
  const message = missingExecutableMessage("next", dir);
  expect(message).toContain("no node_modules yet");
  expect(message).toContain("`bun install`");
});

test("missingExecutableMessage still suggests an install when node_modules exists", () => {
  const dir = tempDir("spawn-modules");
  writeFileSync(join(dir, "package.json"), '{"name":"app"}');
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  mkdirSync(join(dir, "node_modules"));
  const message = missingExecutableMessage("next", dir);
  expect(message).not.toContain("no node_modules yet");
  expect(message).toContain("`pnpm install`");
});

test("missingExecutableMessage counts a hoisted node_modules above a workspace member", () => {
  const root = tempDir("spawn-workspace");
  mkdirSync(join(root, "node_modules"));
  const member = join(root, "apps", "web");
  mkdirSync(member, { recursive: true });
  writeFileSync(join(member, "package.json"), '{"name":"web"}');
  writeFileSync(join(root, "pnpm-lock.yaml"), "");
  const message = missingExecutableMessage("next", member);
  expect(message).not.toContain("no node_modules yet");
  expect(message).toContain("If it is a dependency of this project");
  // The lockfile is the root's, so the install command is the root's manager, not npm.
  expect(message).toContain("`pnpm install`");
});

test("missingExecutableMessage prefers a lockfile above the member over the member's packageManager", () => {
  const root = tempDir("spawn-workspace-field");
  writeFileSync(join(root, "bun.lock"), "");
  const member = join(root, "packages", "api");
  mkdirSync(member, { recursive: true });
  writeFileSync(join(member, "package.json"), '{"name":"api","packageManager":"npm@10.0.0"}');
  expect(missingExecutableMessage("tsx", member)).toContain("`bun install`");
});

test("missingExecutableMessage finds the project from a subdirectory of it", () => {
  const root = tempDir("spawn-nested");
  writeFileSync(join(root, "package.json"), '{"name":"app"}');
  writeFileSync(join(root, "yarn.lock"), "");
  const nested = join(root, "scripts", "tools");
  mkdirSync(nested, { recursive: true });
  const message = missingExecutableMessage("next", nested);
  expect(message).toContain("no node_modules yet");
  expect(message).toContain("`yarn install`");
});

test("missingExecutableMessage reads packageManager when there is no lockfile", () => {
  const dir = tempDir("spawn-corepack");
  writeFileSync(join(dir, "package.json"), '{"name":"app","packageManager":"yarn@4.1.0"}');
  expect(missingExecutableMessage("next", dir)).toContain("`yarn install`");
});

test("missingExecutableMessage treats a command given as a path as a missing file", () => {
  const dir = tempDir("spawn-path");
  writeFileSync(join(dir, "package.json"), '{"name":"app"}');
  const relative = missingExecutableMessage("./scripts/start.sh", dir);
  expect(relative).toBe(`"./scripts/start.sh" does not exist in ${dir}.`);
  expect(missingExecutableMessage("/opt/tools/start", dir)).toBe('"/opt/tools/start" does not exist.');
});

test("executableExists looks a name up on PATH and a path up on disk", () => {
  const dir = tempDir("spawn-exists");
  writeFileSync(join(dir, "tool.sh"), "#!/bin/sh\n");
  expect(executableExists("node")).toBe(true);
  expect(executableExists("kerstel-test-no-such-executable")).toBe(false);
  expect(executableExists("./tool.sh", dir)).toBe(true);
  expect(executableExists("./missing.sh", dir)).toBe(false);
  expect(executableExists(join(dir, "tool.sh"))).toBe(true);
});

test("run exits 127 with the message, and opens no vault, when the command is not on PATH", async () => {
  isolateEnv({ prefix: "spawn-run" });
  const dir = tempDir("spawn-run-project");
  process.chdir(dir);

  const log = captureLog();
  restoreLog = log.restore;
  const code = await runCli(["run", "--", "kerstel-test-no-such-executable"]);

  expect(code).toBe(EXIT_COMMAND_NOT_FOUND);
  expect(log.text()).toContain('"kerstel-test-no-such-executable" was not found on PATH');
  expect(log.text()).not.toContain("Executable not found in $PATH");
  // Refused before openContext(): nothing was created, and nothing prompted.
  expect(existsSync(vaultPath())).toBe(false);
});

test("run exits 126 and blames the interpreter when the executable exists but its #! target does not", async () => {
  isolateEnv({ prefix: "spawn-run-shebang" });
  const dir = tempDir("spawn-run-shebang-project");
  writeFileSync(join(dir, "package.json"), '{"name":"app"}');
  const script = join(dir, "tool.sh");
  writeFileSync(script, "#!/nonexistent/interpreter\necho ran\n");
  chmodSync(script, 0o755);

  const log = captureLog();
  restoreLog = log.restore;
  const code = await runCli(["run", "--", script]);

  expect(code).toBe(EXIT_COMMAND_NOT_EXECUTABLE);
  expect(log.text()).toContain("exists but could not be started");
  expect(log.text()).toContain("interpreter");
  expect(log.text()).not.toContain("install`");
  expect(log.text()).not.toContain("does not exist");
});

test("run leaves a spawn failure other than a missing file to the top-level handler", async () => {
  isolateEnv({ prefix: "spawn-run-eacces" });
  const dir = tempDir("spawn-run-eacces-project");
  const script = join(dir, "noexec.sh");
  writeFileSync(script, "#!/bin/sh\necho ran\n");
  chmodSync(script, 0o644);

  const log = captureLog();
  restoreLog = log.restore;
  const code = await runCli(["run", "--", script]);

  expect(code).toBe(1);
  expect(log.text()).toContain("permission denied");
  expect(log.text()).not.toContain("does not exist");
  expect(log.text()).not.toContain("install");
});
