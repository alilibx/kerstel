import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  classifyLauncher,
  LAUNCHER_FORMAT,
  LAUNCHER_RELATIVE_PATH,
  launcherSource,
  launcherStatus,
  planLauncher,
} from "../src/init/launcher";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kerstel-launcher-${prefix}-`));
  temps.push(dir);
  return dir;
}

/** A project with the launcher written, as `init` leaves it. */
function project(): string {
  const root = temp("project");
  mkdirSync(join(root, ".kerstel"));
  writeFileSync(join(root, ".kerstel", "exec.cjs"), launcherSource());
  return root;
}

/**
 * A `kerstel` on PATH that records its arguments and exits as told. Real
 * enough for the launcher: it only ever runs `kerstel exec -- <command>`.
 */
function fakeKerstel(dir: string, body = 'printf "%s\\n" "$@" > "$KERSTEL_FAKE_LOG"; exit "${KERSTEL_FAKE_EXIT:-0}"'): string {
  const file = join(dir, "kerstel");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

async function runLauncher(
  root: string,
  command: string[],
  options: { path: string; env?: Record<string, string>; runtime?: string[] } = { path: process.env.PATH ?? "" },
) {
  const proc = Bun.spawn([...(options.runtime ?? ["node"]), LAUNCHER_RELATIVE_PATH, "--", ...command], {
    cwd: root,
    env: { PATH: options.path, HOME: process.env.HOME ?? "", ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

const NODE_DIR = dirname(Bun.which("node") ?? "/usr/local/bin/node");

test("the launcher's first line carries the current format", () => {
  expect(launcherSource().split("\n")[0]).toBe(
    `// Kerstel launcher, format ${LAUNCHER_FORMAT}. Written by kerstel init; edits are overwritten on the next run.`,
  );
});

test("with kerstel on PATH, the launcher runs `kerstel exec -- <command>` and forwards the exit code", async () => {
  const root = project();
  const bin = temp("bin");
  fakeKerstel(bin);
  const log = join(temp("log"), "argv");

  const ok = await runLauncher(root, ["next", "build", "--flag", "two words"], {
    path: `${bin}:${NODE_DIR}`,
    env: { KERSTEL_FAKE_LOG: log },
  });
  expect(ok.code).toBe(0);
  expect(ok.stderr).toBe("");
  expect(readFileSync(log, "utf8")).toBe("exec\n--\nnext\nbuild\n--flag\ntwo words\n");

  const failing = await runLauncher(root, ["next", "build"], {
    path: `${bin}:${NODE_DIR}`,
    env: { KERSTEL_FAKE_LOG: log, KERSTEL_FAKE_EXIT: "7" },
  });
  expect(failing.code).toBe(7);
});

test("a child killed by a signal exits 128 plus the signal number", async () => {
  const root = project();
  const bin = temp("bin");
  fakeKerstel(bin, "kill -TERM $$");
  const result = await runLauncher(root, ["next", "build"], { path: `${bin}:${NODE_DIR}` });
  expect(result.code).toBe(143);
});

test("a kerstel that lives only in a node_modules/.bin on PATH counts as absent", async () => {
  const root = project();
  const shadow = join(root, "node_modules", ".bin");
  mkdirSync(shadow, { recursive: true });
  fakeKerstel(shadow, 'echo SHADOW; exit 9');
  const echo = dirname(Bun.which("echo") ?? "/bin/echo");

  const result = await runLauncher(root, ["echo", "ran-without-kerstel"], { path: `${shadow}:${NODE_DIR}:${echo}` });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("ran-without-kerstel\n");
  expect(result.stderr).toBe("kerstel: not installed here, running without it: echo ran-without-kerstel\n");
});

test("without kerstel, the launcher prints one line and runs the command as written", async () => {
  const root = project();
  const echo = dirname(Bun.which("echo") ?? "/bin/echo");
  const result = await runLauncher(root, ["echo", "a b", "c"], { path: `${NODE_DIR}:${echo}` });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("a b c\n");
  expect(result.stderr).toBe("kerstel: not installed here, running without it: echo a b c\n");
});

test("without kerstel, a missing command exits 127 and names the command", async () => {
  const root = project();
  const result = await runLauncher(root, ["no-such-command-xyz", "--flag"], { path: NODE_DIR });
  expect(result.code).toBe(127);
  expect(result.stderr).toContain('kerstel: "no-such-command-xyz" was not found on PATH.');
});

test("no command after -- is a usage error", async () => {
  const root = project();
  const result = await runLauncher(root, [], { path: NODE_DIR });
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("Usage: node .kerstel/exec.cjs -- <command>");
});

test("under `bun run`, the launcher runs with the system node, and with bun itself when node is absent", async () => {
  const root = project();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "p", scripts: { go: `node ${LAUNCHER_RELATIVE_PATH} -- echo via-bun-run` } }),
  );
  const bunDir = dirname(Bun.which("bun") ?? process.execPath);
  const echo = dirname(Bun.which("echo") ?? "/bin/echo");
  // A PATH with bun and echo but no node.
  const noNode = temp("nonode");
  symlinkSync(join(bunDir, "bun"), join(noNode, "bun"));

  for (const path of [`${bunDir}:${NODE_DIR}:${echo}`, `${noNode}:${echo}`]) {
    const proc = Bun.spawn(["bun", "run", "go"], {
      cwd: root,
      env: { PATH: path, HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("via-bun-run");
    expect(stderr).toContain("kerstel: not installed here, running without it: echo via-bun-run");
  }
});

test("the Windows command line quotes a .cmd shim's arguments the way npm does", () => {
  // The source path is already loaded as a text module by launcher.ts, so a
  // require of it would return the text; a copy loads as code.
  const copy = join(temp("helpers"), "exec.cjs");
  writeFileSync(copy, launcherSource());
  const require = createRequire(import.meta.url);
  const { windowsCommandLine, quoteForCmd } = require(copy) as {
    windowsCommandLine: (file: string, rest: string[]) => string;
    quoteForCmd: (argument: string) => string;
  };
  expect(quoteForCmd("plain")).toBe("plain");
  expect(quoteForCmd("")).toBe('""');
  expect(quoteForCmd("two words")).toBe('"two words"');
  expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
  expect(quoteForCmd("a&b")).toBe('"a^&b"');
  expect(quoteForCmd("100%")).toBe('"100^%"');
  expect(windowsCommandLine("C:\\p\\node_modules\\.bin\\next.CMD", ["build", "--name", "x y"])).toBe(
    'C:\\p\\node_modules\\.bin\\next.CMD build --name "x y"',
  );
});

test("classifyLauncher tells current, stale, edited, and foreign apart", () => {
  expect(classifyLauncher(launcherSource())).toEqual({ kind: "current" });
  expect(classifyLauncher(launcherSource().replace("format 1.", "format 0."))).toEqual({ kind: "stale", format: 0 });
  expect(classifyLauncher(`${launcherSource()}\n// edited`)).toEqual({ kind: "edited" });
  expect(classifyLauncher("#!/bin/sh\necho mine\n")).toEqual({ kind: "foreign" });
});

test("launcherStatus and planLauncher read the file at the package root", () => {
  const root = temp("plan");
  expect(launcherStatus(root)).toEqual({ kind: "missing" });
  const plan = planLauncher(root);
  expect(plan).toMatchObject({ before: null, after: launcherSource(), status: { kind: "missing" } });
  expect(existsSync(join(root, ".kerstel"))).toBe(false);

  mkdirSync(join(root, ".kerstel"));
  writeFileSync(join(root, ".kerstel", "exec.cjs"), launcherSource());
  expect(launcherStatus(root)).toEqual({ kind: "current" });
  expect(planLauncher(root)).toBeNull();

  writeFileSync(join(root, ".kerstel", "exec.cjs"), `${launcherSource()}// tampered\n`);
  expect(planLauncher(root)).toMatchObject({ status: { kind: "edited" } });
});

test("the launcher runs when invoked through a symlinked absolute path", async () => {
  const root = project();
  const link = join(temp("link"), "proj");
  symlinkSync(root, link);
  const echo = dirname(Bun.which("echo") ?? "/bin/echo");
  const proc = Bun.spawn(["node", join(link, ".kerstel", "exec.cjs"), "--", "echo", "via-symlink"], {
    env: { PATH: `${NODE_DIR}:${echo}`, HOME: process.env.HOME ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  expect(stdout).toBe("via-symlink\n");
});

test("a CRLF checkout of the launcher still counts as current", () => {
  expect(classifyLauncher(launcherSource().replace(/\n/g, "\r\n"))).toEqual({ kind: "current" });
});
