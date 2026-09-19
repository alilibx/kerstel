import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_LINE_CHARS } from "../src/daemon/protocol";
import { startDaemon, type DaemonHandle } from "../src/daemon/server";
import { ensureToken } from "../src/daemon/token";
import { socketPath } from "../src/paths";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { runCli } from "../src/index";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

function isolate(): string {
  return isolateEnv({ prefix: "cli" });
}

let captured: string[] = [];
const realLog = console.log;

function capture(): void {
  captured = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
}

afterEach(async () => {
  console.log = realLog;
  await runCli(["daemon", "stop"]).catch(() => 0);
  restoreEnv();
});

test("set then get --reveal round-trips a secret", async () => {
  isolate();
  expect(await runCli(["set", "global/API_KEY", "--value", "sk-123"])).toBe(0);

  capture();
  expect(await runCli(["get", "global/API_KEY", "--reveal"])).toBe(0);
  expect(captured.join("\n")).toBe("sk-123");
});

test("get without --reveal masks the value", async () => {
  isolate();
  await runCli(["set", "global/API_KEY", "--value", "sk-supersecret"]);

  capture();
  expect(await runCli(["get", "global/API_KEY"])).toBe(0);
  const out = captured.join("\n");
  expect(out).not.toContain("sk-supersecret");
  expect(out).toContain("•");
});

test("ls prints references and never values", async () => {
  isolate();
  await runCli(["set", "global/A", "--value", "value-a"]);
  await runCli(["set", "my-app/B", "--value", "value-b"]);

  capture();
  expect(await runCli(["ls"])).toBe(0);
  const out = captured.join("\n");
  expect(out).toContain("kerstel://global/A");
  expect(out).toContain("kerstel://my-app/B");
  expect(out).not.toContain("value-a");
});

test("ls --scope filters", async () => {
  isolate();
  await runCli(["set", "global/A", "--value", "1"]);
  await runCli(["set", "my-app/B", "--value", "2"]);

  capture();
  await runCli(["ls", "--scope", "my-app"]);
  const out = captured.join("\n");
  expect(out).toContain("my-app/B");
  expect(out).not.toContain("global/A");
});

test("rm deletes and reports a missing key", async () => {
  isolate();
  await runCli(["set", "global/A", "--value", "1"]);
  expect(await runCli(["rm", "global/A", "--yes"])).toBe(0);
  expect(await runCli(["rm", "global/A", "--yes"])).toBe(1);
});

test("--value does not swallow the next flag as the secret", async () => {
  isolate();
  // `args[indexOf("--value") + 1]` would store the literal string "--reveal".
  expect(await runCli(["set", "global/OOPS", "--value", "--reveal"])).toBe(2);

  capture();
  expect(await runCli(["get", "global/OOPS"])).toBe(1);
  expect(captured.join("\n")).toContain("No secret");
});

test("a value too large to transport is refused rather than stored", async () => {
  isolate();
  const huge = "x".repeat(MAX_LINE_CHARS + 1);
  expect(await runCli(["set", "global/HUGE", "--value", huge])).toBe(2);

  // A secret the daemon could store but never serve should not be in the vault
  // at all -- the failure belongs at `set`, not at resolution time.
  capture();
  expect(await runCli(["get", "global/HUGE"])).toBe(1);
});

test("get --reveal writes an audit row", async () => {
  isolate();
  await runCli(["set", "global/SEEN", "--value", "peek"]);

  capture();
  expect(await runCli(["get", "global/SEEN", "--reveal"])).toBe(0);

  const { key } = await loadOrCreateDataKey();
  const vault = openVault(key);
  try {
    const rows = vault.listAudit(10).filter((e) => e.event === "reveal");
    expect(rows.length).toBe(1);
    expect(rows[0]?.key).toBe("SEEN");
    expect(rows[0]?.processName).toBe("kerstel");
  } finally {
    vault.close();
  }
});

test("run writes one audit row per reference it resolves", async () => {
  isolate();
  await runCli(["set", "global/RA", "--value", "a"]);
  await runCli(["set", "global/RB", "--value", "b"]);

  process.env.RA = "kerstel://global/RA";
  process.env.RB = "kerstel://global/RB";
  capture();
  const code = await runCli(["run", "--", "node", "-e", ""]);
  delete process.env.RA;
  delete process.env.RB;
  expect(code).toBe(0);

  const { key } = await loadOrCreateDataKey();
  const vault = openVault(key);
  try {
    const rows = vault.listAudit(20).filter((e) => e.event === "run");
    expect(rows.map((r) => r.key).sort()).toEqual(["RA", "RB"]);
  } finally {
    vault.close();
  }
});

test("an invalid reference is rejected before touching the vault", async () => {
  isolate();
  expect(await runCli(["set", "Bad-Scope/KEY", "--value", "x"])).toBe(2);
  expect(await runCli(["set", "global/bad-key", "--value", "x"])).toBe(2);
});

test("run injects resolved values into the child environment", async () => {
  isolate();
  await runCli(["set", "global/RUN_KEY", "--value", "run-value"]);

  const script = join(mkdtempSync(join(tmpdir(), "kerstel-run-")), "print.cjs");
  await Bun.write(script, "process.stdout.write(process.env.RUN_KEY);");

  process.env.RUN_KEY = "kerstel://global/RUN_KEY";
  capture();
  const code = await runCli(["run", "--", "node", script]);
  delete process.env.RUN_KEY;
  expect(code).toBe(0);
});

// `resolve` goes through the daemon (see resolveCommand), so this test has to
// give it one. It cannot exercise the AUTO-START half of that: `bun test`
// reaps processes its tests spawn, so the detached `daemon serve` child
// ensureDaemon() starts is killed out from under it ("killed 1 dangling
// process"). The auto-start path is covered end to end against the compiled
// binary in e2e.test.ts instead.
test("resolve prints one value for scripting, through the daemon", async () => {
  isolate();
  await runCli(["set", "global/R", "--value", "resolved"]);

  const token = ensureToken();
  const { key, backend } = await loadOrCreateDataKey();
  const vault: Vault = openVault(key);
  const handle = await startDaemon({ vault, socketPath: socketPath(), token, backendName: backend });

  try {
    capture();
    expect(await runCli(["resolve", "kerstel://global/R"])).toBe(0);
    expect(captured.join("\n")).toBe("resolved");

    // The daemon audits every resolution it serves; routing `resolve` through
    // it is what gives this command an audit row at all.
    const audit = vault.listAudit(10).filter((e) => e.event === "resolve" && e.key === "R");
    expect(audit.length).toBe(1);
  } finally {
    await handle.close();
    vault.close();
  }
});

test("resolve reports a missing key without inventing one", async () => {
  isolate();
  const token = ensureToken();
  const { key, backend } = await loadOrCreateDataKey();
  const vault: Vault = openVault(key);
  const handle = await startDaemon({ vault, socketPath: socketPath(), token, backendName: backend });

  try {
    capture();
    expect(await runCli(["resolve", "kerstel://global/NOPE"])).toBe(1);
    expect(captured.join("\n")).toContain("No secret at kerstel://global/NOPE");
  } finally {
    await handle.close();
    vault.close();
  }
});

test("daemon status reports when nothing is running", async () => {
  isolate();
  capture();
  expect(await runCli(["daemon", "status"])).toBe(1);
  expect(captured.join("\n")).toMatch(/not running/i);
});

// Extra case for the serve/start split (see task-12 brief correction): `start`
// must be a no-op returning 0 when a daemon is already listening, rather than
// spawning a second one. The actual spawn-and-poll path (a fresh `daemon
// serve` child) is only exercisable against the compiled binary, since
// `process.execPath` under `bun test` is the test runner itself, not
// `kerstel` -- that end-to-end path is covered in Task 13.
test("daemon start reports already running instead of spawning a duplicate", async () => {
  isolate();
  const token = ensureToken();
  const { key, backend } = await loadOrCreateDataKey();
  const vault: Vault = openVault(key);
  const handle: DaemonHandle = await startDaemon({
    vault,
    socketPath: socketPath(),
    token,
    backendName: backend,
  });

  try {
    capture();
    expect(await runCli(["daemon", "start"])).toBe(0);
    expect(captured.join("\n")).toMatch(/already running/i);

    capture();
    expect(await runCli(["daemon", "status"])).toBe(0);
    expect(captured.join("\n")).toContain("running");
  } finally {
    await handle.close();
    vault.close();
  }
});

test("doctor reports the keychain backend and vault location", async () => {
  const dir = isolate();
  await runCli(["set", "global/A", "--value", "1"]);

  capture();
  expect(await runCli(["doctor"])).toBe(0);
  expect(captured.join("\n")).toContain("1 secret, key kept in a file");

  capture();
  expect(await runCli(["doctor", "--verbose"])).toBe(0);
  expect(captured.join("\n")).toContain(dir);
});

// A failed hook install used to throw out of openContext(), which is on the way
// into EVERY vault-opening command -- so a read-only ~/.kerstel (a binary
// upgrade, a stray chmod) took out `kerstel ls` and `kerstel get` along with
// the hook, and made doctor's "(not installed)" branch unreachable: doctor
// could not report the problem because doctor could not start.
test.if(process.platform !== "win32")(
  "a hook install failure degrades to a doctor warning instead of killing commands",
  async () => {
    const dir = isolate();
    await runCli(["set", "global/A", "--value", "1"]);

    const hook = join(dir, "hook");
    const preload = join(hook, "preload.cjs");
    // Corrupt it so the content check wants to rewrite, then make the rewrite
    // impossible: the file itself is unwritable (an existing file needs write
    // permission on the file, not the directory) and the directory is too, so
    // neither replacing nor recreating it can succeed.
    writeFileSync(preload, "// corrupted\n");
    chmodSync(preload, 0o400);
    chmodSync(hook, 0o500);

    try {
      // The vault still opens, and the command still works.
      capture();
      expect(await runCli(["ls"])).toBe(0);
      expect(captured.join("\n")).toContain("kerstel://global/A");

      capture();
      expect(await runCli(["doctor"])).toBe(0);
      const out = captured.join("\n");
      expect(out).toContain("not installed:");
      // The reason has to be in there, not just the fact.
      expect(out).toMatch(/EACCES|permission denied/i);
    } finally {
      chmodSync(hook, 0o700);
      chmodSync(preload, 0o644);
    }

    // And it recovers on the next run once the permissions are back.
    capture();
    expect(await runCli(["doctor"])).toBe(0);
    expect(captured.join("\n")).not.toContain("not installed:");
  },
);

test("bare kerstel lists the commands and exits 0; --help does the same", async () => {
  isolate();
  expect(await runCli([])).toBe(0);
  expect(await runCli(["--help"])).toBe(0);
});

test("an unknown command exits 2 with usage", async () => {
  isolate();
  capture();
  expect(await runCli(["frobnicate"])).toBe(2);
  expect(captured.join("\n")).toMatch(/usage/i);
});

test("--version and version print the bare package version", async () => {
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
  for (const flag of ["--version", "version"]) {
    capture();
    expect(await runCli([flag])).toBe(0);
    expect(captured.join("\n")).toBe(pkg.version);
  }
});
