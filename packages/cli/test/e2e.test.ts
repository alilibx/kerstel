import { afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const BINARY = join(REPO, "dist", process.platform === "win32" ? "kerstel.exe" : "kerstel");

let home: string;

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: join(REPO, "packages/cli"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await build.exited;
  if (code !== 0) console.error(await new Response(build.stderr).text());
  expect(code).toBe(0);
  expect(existsSync(BINARY)).toBe(true);
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    KERSTEL_HOME: home,
    KERSTEL_KEYCHAIN_BACKEND: "file",
    NODE_OPTIONS: "",
    ...extra,
  };
}

async function kerstel(args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([BINARY, ...args], { env: env(extra), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

afterEach(async () => {
  await kerstel(["daemon", "stop"]);
});

test("the compiled binary stores and lists a secret", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-"));
  expect((await kerstel(["set", "global/OPENAI_API_KEY", "--value", "sk-e2e"])).code).toBe(0);

  const list = await kerstel(["ls"]);
  expect(list.stdout).toContain("kerstel://global/OPENAI_API_KEY");
  expect(list.stdout).not.toContain("sk-e2e");
});

test("a node app reads the real secret from a reference-only .env", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-node-"));
  expect((await kerstel(["set", "global/OPENAI_API_KEY", "--value", "sk-end-to-end"])).code).toBe(0);
  // Assert the daemon actually came up before spawning the child: without this
  // a failed start surfaces as an opaque resolution error from the Node
  // process, several steps away from the thing that broke.
  const started = await kerstel(["daemon", "start"]);
  if (started.code !== 0) console.error(started.stdout + started.stderr);
  expect(started.code).toBe(0);

  const project = mkdtempSync(join(tmpdir(), "kerstel-project-"));
  const app = join(project, "app.cjs");
  await Bun.write(app, "process.stdout.write(process.env.OPENAI_API_KEY);");

  // The hook the binary INSTALLED, under this test's KERSTEL_HOME -- never the
  // one in the repo checkout. The point of this suite is that the compiled
  // binary stands alone on a machine that has no Kerstel source tree, so
  // reaching back into packages/hook/dist here would hide exactly the bug it
  // exists to catch.
  const installedHookDir = join(home, "hook");
  const preload = join(installedHookDir, "preload.cjs");
  expect(existsSync(preload)).toBe(true);
  expect(existsSync(join(installedHookDir, "worker.cjs"))).toBe(true);

  const token = (await Bun.file(join(home, "session.token")).text()).trim();
  const socket = join(home, "kerstel.sock");

  const proc = Bun.spawn(["node", "--require", preload, app], {
    env: env({
      // This is exactly what a committed .env would contain.
      OPENAI_API_KEY: "kerstel://global/OPENAI_API_KEY",
      KERSTEL_SOCKET: socket,
      KERSTEL_TOKEN: token,
      KERSTEL_HOOK_DIR: installedHookDir,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect(code).toBe(0);
  expect(stdout).toBe("sk-end-to-end");
});

test("kerstel run resolves references for an unhooked command", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-run-"));
  await kerstel(["set", "global/RUN_KEY", "--value", "via-run"]);

  const project = mkdtempSync(join(tmpdir(), "kerstel-run-project-"));
  const app = join(project, "app.cjs");
  await Bun.write(app, "process.stdout.write(process.env.RUN_KEY);");

  const proc = Bun.spawn([BINARY, "run", "--", "node", app], {
    env: env({ RUN_KEY: "kerstel://global/RUN_KEY" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect(code).toBe(0);
  expect(stdout).toBe("via-run");
});

test("the binary installs the runtime hook into KERSTEL_HOME on first use", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-hook-"));
  // Any vault-opening command is enough -- nothing here mentions the hook.
  expect((await kerstel(["ls"])).code).toBe(0);

  // The product's central promise is that `curl | bash` puts a working hook on
  // a machine with no Kerstel source tree anywhere. The binary carries both
  // files and writes them here; nothing else on the system could have.
  for (const name of ["preload.cjs", "worker.cjs"]) {
    const installed = join(home, "hook", name);
    expect(existsSync(installed)).toBe(true);
    expect((await Bun.file(installed).text()).length).toBeGreaterThan(0);
  }

  const doctor = await kerstel(["doctor"]);
  expect(doctor.stdout).toContain(join(home, "hook"));
  expect(doctor.stdout).not.toContain("not installed");
});

test("resolve starts the daemon by itself and audits the resolution", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-autostart-"));
  expect((await kerstel(["set", "global/AUTO", "--value", "auto-started"])).code).toBe(0);

  // No `daemon start` anywhere: `resolve` goes through the daemon, so it has to
  // bring one up on its own. This is the only place the spawn-and-poll path in
  // ensureDaemon() is exercisable -- under `bun test` the runner reaps the
  // detached child before it can answer.
  expect((await kerstel(["daemon", "status"])).code).toBe(1);

  const resolved = await kerstel(["resolve", "kerstel://global/AUTO"]);
  expect(resolved.code).toBe(0);
  expect(resolved.stdout.trim()).toBe("auto-started");

  expect((await kerstel(["daemon", "status"])).code).toBe(0);
});

test("the vault file holds no plaintext after a full round trip", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-enc-"));
  await kerstel(["set", "global/CANARY", "--value", "PLAINTEXT_CANARY_E2E"]);

  const raw = await Bun.file(join(home, "vault.db")).arrayBuffer();
  expect(Buffer.from(raw).includes(Buffer.from("PLAINTEXT_CANARY_E2E"))).toBe(false);
});

// Windows has no `sh`, and this test's whole point is running the rewritten
// script the way a package manager would -- through a shell.
test.if(process.platform !== "win32")(
  "the binary migrates a project and the rewritten script still resolves the secret",
  async () => {
    home = mkdtempSync(join(tmpdir(), "kerstel-e2e-init-"));
    const project = mkdtempSync(join(tmpdir(), "kerstel-e2e-init-project-"));

    const printScript = 'node -e "process.stdout.write(String(process.env.APP_KEY))"';
    await Bun.write(
      join(project, "package.json"),
      `${JSON.stringify({ name: "e2e-demo", scripts: { printkey: printScript } }, null, 2)}\n`,
    );
    // Presence is all the detector needs; nothing here runs npm.
    await Bun.write(join(project, "package-lock.json"), "{}\n");
    await Bun.write(join(project, ".env"), "APP_KEY=super-secret-e2e\n");

    const init = Bun.spawn([BINARY, "init", "--yes", "--non-interactive"], {
      cwd: project,
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [initOut, initErr, initCode] = await Promise.all([
      new Response(init.stdout).text(),
      new Response(init.stderr).text(),
      init.exited,
    ]);
    if (initCode !== 0) console.error(initOut + initErr);
    expect(initCode).toBe(0);
    // The wizard prints a plan, a diff and a self-check result -- and never the
    // secret it is migrating.
    expect(initOut).not.toContain("super-secret-e2e");

    expect(await Bun.file(join(project, ".env")).text()).toBe("APP_KEY=kerstel://e2e-demo/APP_KEY\n");

    const rewritten = JSON.parse(await Bun.file(join(project, "package.json")).text()) as {
      scripts: Record<string, string>;
    };
    expect(rewritten.scripts.printkey).toBe(`kerstel exec -- ${printScript}`);

    // Run it exactly as npm would: the script text through a shell, in the
    // project directory, with the binary's directory on PATH and the .env
    // reference in the environment.
    const run = Bun.spawn(["sh", "-c", rewritten.scripts.printkey as string], {
      cwd: project,
      env: env({
        APP_KEY: "kerstel://e2e-demo/APP_KEY",
        PATH: `${dirname(BINARY)}:${process.env.PATH ?? ""}`,
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    if (code !== 0) console.error(stdout + stderr);

    expect(code).toBe(0);
    expect(stdout).toBe("super-secret-e2e");
  },
);
