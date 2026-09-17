import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDaemon, type DaemonHandle } from "../../cli/src/daemon/server";
import { generateDataKey } from "../../cli/src/vault/crypto";
import { openVault, type Vault } from "../../cli/src/vault/store";

const running: DaemonHandle[] = [];
const vaults: Vault[] = [];
const TOKEN = "preload-test-token-4242";
const DIST = resolve(import.meta.dir, "../dist");
const FIXTURES = resolve(import.meta.dir, "fixtures");

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", resolve(import.meta.dir, "../build.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await build.exited).toBe(0);
});

afterEach(async () => {
  while (running.length) await running.pop()!.close();
  while (vaults.length) vaults.pop()!.close();
});

async function boot(): Promise<{ sock: string; vault: Vault }> {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-preload-"));
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\kerstel-p-${Date.now()}` : join(dir, "k.sock");
  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  vaults.push(vault);
  running.push(await startDaemon({ vault, socketPath: sock, token: TOKEN, backendName: "file" }));
  return { sock, vault };
}

/** Runs a fixture under `node --require preload.cjs` and returns stdout. */
async function runHooked(
  runtime: "node" | "bun",
  sock: string,
  script: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; code: number }> {
  const preload = join(DIST, "preload.cjs");
  const cmd =
    runtime === "node"
      ? ["node", "--require", preload, script, ...args]
      : ["bun", "--preload", preload, script, ...args];

  const proc = Bun.spawn(cmd, {
    env: {
      ...process.env,
      KERSTEL_SOCKET: sock,
      KERSTEL_TOKEN: TOKEN,
      KERSTEL_HOOK_DIR: DIST,
      NODE_OPTIONS: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, code };
}

test("node resolves a reference through process.env", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, "sk-resolved-1");

  const { stdout } = await runHooked("node", sock, join(FIXTURES, "read-env.cjs"), ["OPENAI_API_KEY"], {
    OPENAI_API_KEY: "kerstel://global/OPENAI_API_KEY",
  });
  expect(stdout).toBe("sk-resolved-1");
});

test("bun resolves a reference through process.env", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, "sk-resolved-bun");

  const { stdout } = await runHooked("bun", sock, join(FIXTURES, "read-env.cjs"), ["OPENAI_API_KEY"], {
    OPENAI_API_KEY: "kerstel://global/OPENAI_API_KEY",
  });
  expect(stdout).toBe("sk-resolved-bun");
});

test("plain values pass through untouched", async () => {
  const { sock } = await boot();
  const { stdout } = await runHooked("node", sock, join(FIXTURES, "read-env.cjs"), ["PLAIN_URL"], {
    PLAIN_URL: "postgres://localhost:5432/dev",
  });
  expect(stdout).toBe("postgres://localhost:5432/dev");
});

test("an undefined variable stays undefined", async () => {
  const { sock } = await boot();
  const { stdout } = await runHooked("node", sock, join(FIXTURES, "read-env.cjs"), ["NOT_SET_AT_ALL"], {});
  expect(stdout).toBe("undefined");
});

test("a missing secret throws an actionable error naming the reference", async () => {
  const { sock } = await boot();
  const { stdout, code } = await runHooked("node", sock, join(FIXTURES, "read-env.cjs"), ["GONE"], {
    GONE: "kerstel://global/GONE",
  });
  expect(stdout).toContain("ERROR:not_found");
  expect(stdout).toContain("kerstel://global/GONE");
  expect(code).toBe(3);
});

test("the reference string is never returned to application code", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "real");
  const { stdout } = await runHooked("node", sock, join(FIXTURES, "read-env.cjs"), ["K"], {
    K: "kerstel://global/K",
  });
  expect(stdout).not.toContain("kerstel://");
  expect(stdout).toBe("real");
});

test("an unhooked grandchild still gets the resolved value, not the reference", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "CHILD_KEY" }, "child-value");

  // spawn-child.cjs strips NODE_OPTIONS before spawning its own child, so
  // that grandchild has no preload and cannot resolve anything itself. It
  // only prints the right value because the parent already resolved it while
  // building the grandchild's env -- proving resolution happens at envp
  // construction time, not by propagating the reference downstream.
  const { stdout } = await runHooked("node", sock, join(FIXTURES, "spawn-child.cjs"), ["CHILD_KEY"], {
    CHILD_KEY: "kerstel://global/CHILD_KEY",
  });
  expect(stdout).toBe("child-value");
});

test("the hook marks itself active for doctor", async () => {
  const { sock } = await boot();
  const { stdout } = await runHooked("node", sock, join(FIXTURES, "read-env.cjs"), ["KERSTEL_ACTIVE"], {});
  expect(stdout).toBe("1");
});

test("repeated reads of the same key hit the daemon once", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "CACHED" }, "cached-value");

  const script = join(mkdtempSync(join(tmpdir(), "kerstel-cache-")), "read-thrice.cjs");
  await Bun.write(
    script,
    "for (let i = 0; i < 3; i++) process.stdout.write(process.env.CACHED);",
  );

  const { stdout } = await runHooked("node", sock, script, [], { CACHED: "kerstel://global/CACHED" });
  expect(stdout).toBe("cached-valuecached-valuecached-value");
  expect(vault.listAudit(10).filter((e) => e.key === "CACHED").length).toBe(1);
});

test("Object.keys and spread still see every variable", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "SPREAD_KEY" }, "spread-value");

  const script = join(mkdtempSync(join(tmpdir(), "kerstel-spread-")), "spread.cjs");
  await Bun.write(
    script,
    "const has = Object.keys(process.env).includes('SPREAD_KEY');" +
      "process.stdout.write(`${has}:${{...process.env}.SPREAD_KEY}`);",
  );

  const { stdout } = await runHooked("node", sock, script, [], {
    SPREAD_KEY: "kerstel://global/SPREAD_KEY",
  });
  expect(stdout).toBe("true:spread-value");
});
