import { afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { launcherSource } from "../src/init/launcher";
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
    // Keeps `doctor` off github.com: port 9 refuses at once, so it reports
    // "could not check for updates" instead of waiting on the network.
    KERSTEL_RELEASES_URL: "http://127.0.0.1:9",
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

/** Polls until `condition` holds, up to `timeoutMs`. Returns whether it did. */
async function eventually(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(25);
  }
}

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

  const socket = join(home, "kerstel.sock");

  const proc = Bun.spawn(["node", "--require", preload, app], {
    env: env({
      // This is exactly what a committed .env would contain.
      OPENAI_API_KEY: "kerstel://global/OPENAI_API_KEY",
      KERSTEL_SOCKET: socket,
      // The path, as `kerstel exec` sets it. The value stays in the 0600 file.
      KERSTEL_TOKEN_FILE: join(home, "session.token"),
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

  const doctor = await kerstel(["doctor", "--verbose"]);
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

test("the daemon that resolve starts does not inherit BUN_OPTIONS", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-scrub-"));
  expect((await kerstel(["set", "global/SCRUB", "--value", "scrubbed"])).code).toBe(0);

  // A preload that records which process ran it. The compiled binary is a Bun
  // runtime, so BUN_OPTIONS reaches the one-shot `resolve` (that is what
  // `doctor` warns about); the daemon it spawns must not see it.
  const marker = join(home, "preload-ran.log");
  const preload = join(home, "preload.js");
  await Bun.write(
    preload,
    `require("node:fs").appendFileSync(${JSON.stringify(marker)}, process.argv.join(" ") + "\\n");`,
  );

  expect((await kerstel(["daemon", "status"])).code).toBe(1);
  const resolved = await kerstel(["resolve", "kerstel://global/SCRUB"], { BUN_OPTIONS: `--preload ${preload}` });
  expect(resolved.code).toBe(0);
  expect(resolved.stdout.trim()).toBe("scrubbed");
  expect((await kerstel(["daemon", "status"])).code).toBe(0);

  const ran = existsSync(marker) ? await Bun.file(marker).text() : "";
  expect(ran).toContain("resolve");
  expect(ran).not.toContain("daemon serve");
});

test("a foreground daemon serve re-executes itself without BUN_OPTIONS", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-serve-scrub-"));
  expect((await kerstel(["set", "global/FG", "--value", "foreground"])).code).toBe(0);

  const marker = join(home, "preload-ran.log");
  const preload = join(home, "preload.js");
  await Bun.write(
    preload,
    `require("node:fs").appendFileSync(${JSON.stringify(marker)}, process.argv.join(" ") + "\\n");`,
  );

  // `daemon serve` blocks in the foreground, so it is not awaited until it has
  // been asked to stop. The preload runs in this outer process (recorded once);
  // the process that actually opens the vault is its re-executed child.
  const serve = Bun.spawn([BINARY, "daemon", "serve"], {
    env: env({ BUN_OPTIONS: `--preload ${preload}` }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 10_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    await Bun.sleep(100);
    up = (await kerstel(["daemon", "status"])).code === 0;
  }
  expect(up).toBe(true);

  const resolved = await kerstel(["resolve", "kerstel://global/FG"]);
  expect(resolved.stdout.trim()).toBe("foreground");

  expect((await kerstel(["daemon", "stop"])).code).toBe(0);
  expect(await serve.exited).toBe(0);

  const ran = existsSync(marker) ? await Bun.file(marker).text() : "";
  const serveLines = ran.split("\n").filter((line) => line.includes("daemon serve"));
  expect(serveLines.length).toBe(1);
});

test("the session token is minted per daemon lifetime and gone while none runs", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-token-"));
  const tokenFile = join(home, "session.token");
  expect((await kerstel(["set", "global/T", "--value", "rotated"])).code).toBe(0);

  expect((await kerstel(["daemon", "start"])).code).toBe(0);
  const first = (await Bun.file(tokenFile).text()).trim();
  expect(first.length).toBeGreaterThan(20);

  expect((await kerstel(["daemon", "stop"])).code).toBe(0);
  // `daemon stop` waits for the socket to stop answering, which is deliberately
  // not the same as the daemon process having finished exiting; the token is
  // removed on the way out, just after. Wait for the exit rather than assuming
  // a speed: a busy CI runner loses that race where a laptop wins it.
  expect(await eventually(() => !existsSync(tokenFile))).toBe(true);

  expect((await kerstel(["daemon", "start"])).code).toBe(0);
  const second = (await Bun.file(tokenFile).text()).trim();
  expect(second).not.toBe(first);

  // A hooked child given only the PATH keeps working across the rotation,
  // because its worker reads the file when it needs it.
  const project = mkdtempSync(join(tmpdir(), "kerstel-project-token-"));
  const app = join(project, "app.cjs");
  // Compares in memory and prints a verdict, never the resolved value: the
  // same shape as `init`'s own self-check probe.
  await Bun.write(app, `process.stdout.write(process.env.T === "rotated" ? "OK" : "MISMATCH");`);
  const run = () =>
    Bun.spawn(["node", "--require", join(home, "hook", "preload.cjs"), app], {
      env: env({
        T: "kerstel://global/T",
        KERSTEL_SOCKET: join(home, "kerstel.sock"),
        KERSTEL_TOKEN_FILE: tokenFile,
        KERSTEL_HOOK_DIR: join(home, "hook"),
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
  const before = run();
  expect(await new Response(before.stdout).text()).toBe("OK");

  expect((await kerstel(["daemon", "stop"])).code).toBe(0);
  expect((await kerstel(["daemon", "start"])).code).toBe(0);
  const after = run();
  expect(await new Response(after.stdout).text()).toBe("OK");
  // The child's own environment carried a path, never a token.
  expect(env({ KERSTEL_TOKEN_FILE: tokenFile })).not.toHaveProperty("KERSTEL_TOKEN");
});

test("a project's committed .env cannot configure Kerstel itself", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-projenv-"));
  expect((await kerstel(["set", "global/P", "--value", "in-the-real-home"])).code).toBe(0);

  // A cloned repository, whose .env Kerstel's own model says to commit. The
  // compiled binary is a Bun runtime and loads this file on startup.
  const project = mkdtempSync(join(tmpdir(), "kerstel-hostile-project-"));
  writeFileSync(
    join(project, ".env"),
    [
      // Through a variable of its own, because Bun expands `$ATTACK` while
      // this repo's parser does not: the check must not depend on the two
      // parsers agreeing. A daemon that never relocks.
      "ATTACK=9999999999",
      "KERSTEL_IDLE_MS=$ATTACK",
      "P=kerstel://global/P",
      "",
    ].join("\n"),
  );
  // KERSTEL_HOME is deliberately NOT in that file: naming it would make this
  // binary fall back to the real ~/.kerstel, and no test may touch a
  // developer's own vault. The unit tests cover that it would be dropped.

  // Run from inside the project, so the binary loads its .env on startup.
  const proc = Bun.spawn([BINARY, "ls"], {
    cwd: project,
    env: {
      ...(process.env as Record<string, string>),
      KERSTEL_HOME: home,
      KERSTEL_KEYCHAIN_BACKEND: "file",
      KERSTEL_RELEASES_URL: "http://127.0.0.1:9",
      NODE_OPTIONS: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(code).toBe(0);
  // The real home answered.
  expect(stdout).toContain("kerstel://global/P");
  // The injected setting was dropped, and the file named.
  expect(stderr).toContain("KERSTEL_IDLE_MS");
  expect(stderr).toContain(".env");
  // Only what the file names: the caller's other settings are untouched.
  expect(stderr).not.toContain("KERSTEL_HOME");
  expect(stderr).not.toContain("KERSTEL_KEYCHAIN_BACKEND");
});

test("the vault file holds no plaintext after a full round trip", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-enc-"));
  await kerstel(["set", "global/CANARY", "--value", "PLAINTEXT_CANARY_E2E"]);

  const raw = await Bun.file(join(home, "vault.db")).arrayBuffer();
  expect(Buffer.from(raw).includes(Buffer.from("PLAINTEXT_CANARY_E2E"))).toBe(false);
});

test("the compiled binary reports its version", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-version-"));
  const pkg = (await Bun.file(join(REPO, "packages/cli/package.json")).json()) as { version: string };
  const result = await kerstel(["--version"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`${pkg.version}\n`);
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
    expect(rewritten.scripts.printkey).toBe(`node .kerstel/exec.cjs -- ${printScript}`);

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

test("the binary uninstalls: the project gets its values back and Kerstel is gone", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-uninstall-"));
  const binDir = mkdtempSync(join(tmpdir(), "kerstel-e2e-uninstall-bin-"));
  const copy = join(binDir, "kerstel");
  copyFileSync(BINARY, copy);
  chmodSync(copy, 0o755);

  const project = mkdtempSync(join(tmpdir(), "kerstel-e2e-uninstall-project-"));
  const originalEnv = "# local secrets\nAPP_KEY=super-secret-uninstall\nPORT=3000\n";
  const originalPkg = `${JSON.stringify({ name: "e2e-uninstall", scripts: { start: "node app.js" } }, null, 2)}\n`;
  await Bun.write(join(project, "package.json"), originalPkg);
  await Bun.write(join(project, "package-lock.json"), "{}\n");
  await Bun.write(join(project, ".env"), originalEnv);

  const run = async (args: string[]) => {
    const proc = Bun.spawn([copy, ...args], { cwd: project, env: env(), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) console.error(stdout + stderr);
    return { stdout, code };
  };

  expect((await run(["init", "--yes", "--non-interactive", "--keep", "PORT"])).code).toBe(0);
  expect(await Bun.file(join(project, ".env")).text()).toContain("kerstel://e2e-uninstall/APP_KEY");

  const result = await run(["uninstall", "--yes"]);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("super-secret-uninstall");

  expect(await Bun.file(join(project, ".env")).text()).toBe(originalEnv);
  expect(await Bun.file(join(project, "package.json")).text()).toBe(originalPkg);
  expect(existsSync(home)).toBe(false);
  expect(existsSync(copy)).toBe(false);
});

test("a wired compound script runs every command hooked, with its leading assignment intact", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-compound-"));
  expect((await kerstel(["set", "global/COMPOUND_KEY", "--value", "sk-compound"])).code).toBe(0);

  // What `init` writes for `MARK=one node a.cjs && node b.cjs`: one wrapper
  // per command, each after that command's own assignments. The reference sits
  // in the project's .env, exactly as it would in a committed file.
  const project = mkdtempSync(join(tmpdir(), "kerstel-compound-"));
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify(
      { name: "compound", scripts: { both: "MARK=one node .kerstel/exec.cjs -- node a.cjs && node .kerstel/exec.cjs -- node b.cjs" } },
      null,
      2,
    ),
  );
  writeFileSync(join(project, ".env"), "COMPOUND_KEY=kerstel://global/COMPOUND_KEY\n");
  mkdirSync(join(project, ".kerstel"));
  writeFileSync(join(project, ".kerstel", "exec.cjs"), launcherSource());
  writeFileSync(join(project, "a.cjs"), 'process.stdout.write(`${process.env.MARK}:${process.env.COMPOUND_KEY}\\n`);');
  writeFileSync(join(project, "b.cjs"), 'process.stdout.write(`${process.env.MARK}:${process.env.COMPOUND_KEY}\\n`);');

  // `npm run` finds `kerstel` on PATH, as it does on a developer's machine.
  const proc = Bun.spawn(["npm", "run", "--silent", "both"], {
    cwd: project,
    env: env({ PATH: `${dirname(BINARY)}:${process.env.PATH ?? ""}` }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) console.error(stderr);
  expect(code).toBe(0);
  expect(stdout).toBe("one:sk-compound\nundefined:sk-compound\n");
});

test("the binary's init passes its self-check in a project with nothing to wire", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-nolauncher-"));
  const project = mkdtempSync(join(tmpdir(), "kerstel-nolauncher-"));
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "lifecycle-only", scripts: { postinstall: "true" } }));
  writeFileSync(join(project, ".env"), "API_KEY=sk-e2e-nolauncher\n");
  const proc = Bun.spawn([BINARY, "init", "--yes", "--non-interactive"], {
    cwd: project,
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) console.error(stdout + stderr);
  expect(code).toBe(0);
  expect(stdout).toContain("Self-check passed");
  expect(existsSync(join(project, ".kerstel"))).toBe(false);
});
