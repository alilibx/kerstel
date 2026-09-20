import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_COMMAND_NOT_FOUND, missingExecutableMessage } from "../src/commands/spawn";
import { runCli } from "../src/index";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

const dirs: string[] = [];
const originalCwd = process.cwd();
const realLog = console.log;
let captured: string[] = [];

function capture(): void {
  captured = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kerstel-${prefix}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  console.log = realLog;
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

test("missingExecutableMessage reads packageManager when there is no lockfile", () => {
  const dir = tempDir("spawn-corepack");
  writeFileSync(join(dir, "package.json"), '{"name":"app","packageManager":"yarn@4.1.0"}');
  expect(missingExecutableMessage("next", dir)).toContain("`yarn install`");
});

test("run exits 127 with the message when the command is not on PATH", async () => {
  isolateEnv({ prefix: "spawn-run" });
  const dir = tempDir("spawn-run-project");
  process.chdir(dir);

  capture();
  const code = await runCli(["run", "--", "kerstel-test-no-such-executable"]);

  expect(code).toBe(EXIT_COMMAND_NOT_FOUND);
  const out = captured.join("\n");
  expect(out).toContain('"kerstel-test-no-such-executable" was not found on PATH');
  expect(out).not.toContain("Executable not found in $PATH");
});
