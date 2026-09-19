import { afterEach, beforeAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Vault } from "../../cli/src/vault/store";
import { bootDaemon, cleanupDaemons } from "../../cli/test/helpers/boot-daemon";

const TOKEN = "preload-test-token-4242";
// The hook receives the token file's PATH, never the token; the worker reads
// the file itself. One file for the whole suite: every fixture daemon here is
// booted with the same TOKEN.
const TOKEN_FILE = join(mkdtempSync(join(tmpdir(), "kerstel-preload-token-")), "session.token");
writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
const DIST = resolve(import.meta.dir, "../dist");
const FIXTURES = resolve(import.meta.dir, "fixtures");

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", resolve(import.meta.dir, "../build.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await build.exited).toBe(0);
});

afterEach(cleanupDaemons);

async function boot(): Promise<{ sock: string; vault: Vault }> {
  const { sock, vault } = await bootDaemon({ prefix: "preload", token: TOKEN });
  return { sock, vault };
}

/** Runs a fixture under `node --require preload.cjs` and returns stdout. */
async function runHooked(
  runtime: "node" | "bun",
  sock: string,
  script: string,
  args: string[],
  env: Record<string, string>,
  options: { preloadDir?: string; hookDirEnv?: string | null } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const preload = join(options.preloadDir ?? DIST, "preload.cjs");
  const cmd =
    runtime === "node"
      ? ["node", "--require", preload, script, ...args]
      : ["bun", "--preload", preload, script, ...args];

  // `null` means "do not set KERSTEL_HOOK_DIR at all", which is what a real
  // `node --require ~/.kerstel/hook/preload.cjs` looks like when the CLI did
  // not launch the process. That is the case the worker path must survive on
  // its own, so it must be expressible here.
  const hookDirEnv = options.hookDirEnv === undefined ? DIST : options.hookDirEnv;

  const proc = Bun.spawn(cmd, {
    env: {
      ...process.env,
      KERSTEL_SOCKET: sock,
      KERSTEL_TOKEN_FILE: TOKEN_FILE,
      ...(hookDirEnv === null ? { KERSTEL_HOOK_DIR: undefined } : { KERSTEL_HOOK_DIR: hookDirEnv }),
      NODE_OPTIONS: "",
      ...env,
    },
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

// ---------------------------------------------------------------------------
// The shipped hook must not carry the build machine's paths.
//
// Bun's bundler rewrites __dirname, __filename, module.filename, module.path
// and module.id into string LITERALS holding the source path they had on the
// machine that ran the build, and it rewrites a statically resolvable
// require.resolve("./literal") the same way. Anything the hook derives from
// those points at files no user has: the resolver worker never boots and every
// lookup stalls to its deadline before blaming the daemon. The e2e suite cannot
// see this, because it runs on the machine those paths are true for.
//
// These two tests are the guard. The first fails the moment a baked path
// reappears in the output at all; the second proves the hook actually works
// from a directory that has no relationship to this repo.
// ---------------------------------------------------------------------------

test("the built hook contains no path from the build machine", () => {
  const repoRoot = resolve(import.meta.dir, "../../..");
  // Absolute-path roots on every platform Kerstel targets. A bundler that bakes
  // anything will bake something starting with one of these.
  const forbidden = [repoRoot, "/Users/", "/home/", "/private/", "/var/folders/"];

  for (const name of ["preload.cjs", "worker.cjs"]) {
    const source = readFileSync(join(DIST, name), "utf8");
    for (const needle of forbidden) {
      // Name the offending line in the failure: "it contains /Users/" is not
      // enough to act on, and the whole bundle is far too big to eyeball.
      const offending = source
        .split("\n")
        .map((line, index) => [index + 1, line] as const)
        .filter(([, line]) => line.includes(needle));
      expect(`${name}: ${offending.map(([n, l]) => `${n}: ${l.trim()}`).join("\n")}`).toBe(`${name}: `);
    }
  }
});

test("the built hook resolves from a directory outside the repo", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "OUTSIDE_KEY" }, "resolved-off-build-machine");

  // A fresh directory with nothing but the two shipped files, standing in for
  // ~/.kerstel/hook/ on a machine that never saw this repo. KERSTEL_HOOK_DIR is
  // deliberately NOT set: it would hand the hook the answer and hide exactly
  // the defect this test exists to catch.
  // realpath'd: require.resolve() reports the canonical path, and on macOS
  // tmpdir() is the /var -> /private/var symlink, so the raw mkdtemp path would
  // never compare equal to what the hook reports.
  const install = realpathSync(mkdtempSync(join(tmpdir(), "kerstel-install-")));
  copyFileSync(join(DIST, "preload.cjs"), join(install, "preload.cjs"));

  // The installed worker is the shipped one plus a provenance marker.
  //
  // Without this the test passes even with the bug reintroduced: the baked path
  // points at packages/hook/src/worker.js, which EXISTS on the build machine
  // and works, so the resolution succeeds and nothing looks wrong. That is the
  // accidental pass that let this ship. The marker makes the assertion about
  // WHICH worker ran, not merely that some worker answered — so a hook that
  // reaches back into the repo fails here even though its value is correct.
  const marker = join(install, "worker-loaded.marker");
  await Bun.write(
    join(install, "worker.cjs"),
    `${readFileSync(join(DIST, "worker.cjs"), "utf8")}\n` +
      "if (process.env.KERSTEL_WORKER_MARKER) " +
      'require("node:fs").writeFileSync(process.env.KERSTEL_WORKER_MARKER, "loaded");\n',
  );

  const script = join(mkdtempSync(join(tmpdir(), "kerstel-outside-")), "read.cjs");
  await Bun.write(
    script,
    "process.stdout.write(String(process.env.OUTSIDE_KEY) + '|' + String(process.env.KERSTEL_HOOK_DIR));",
  );

  const { stdout } = await runHooked(
    "node",
    sock,
    script,
    [],
    {
      OUTSIDE_KEY: "kerstel://global/OUTSIDE_KEY",
      KERSTEL_TIMEOUT_MS: "3000",
      KERSTEL_WORKER_MARKER: marker,
    },
    { preloadDir: install, hookDirEnv: null },
  );

  // The value came back...
  expect(stdout).toBe(`resolved-off-build-machine|${install}`);
  // ...and it came back through the worker sitting in the install directory,
  // not one the bundler remembered the path to.
  expect(existsSync(marker)).toBe(true);
});

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

// The test above spawns with an explicit `{ ...process.env }` spread, which
// goes through the proxy's getOwnPropertyDescriptor trap. The far more common
// case is passing no `env` option at all and letting Node copy the environment
// itself -- a different code path through the same proxy, and the one spec
// §6.1's claim actually rests on. The grandchild here is `sh`, not Node: it
// cannot load a preload and cannot resolve anything, so a correct value can
// only have come from the plaintext already being in its real envp.
test.skipIf(process.platform === "win32")(
  "a grandchild spawned with no env option inherits the resolved plaintext",
  async () => {
    const { sock, vault } = await boot();
    vault.setSecret({ scope: "global", key: "CHILD_KEY" }, "implicit-envp-value");

    const { stdout } = await runHooked("node", sock, join(FIXTURES, "spawn-implicit.cjs"), ["CHILD_KEY"], {
      CHILD_KEY: "kerstel://global/CHILD_KEY",
    });
    expect(stdout).toBe("implicit-envp-value");
  },
);

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
