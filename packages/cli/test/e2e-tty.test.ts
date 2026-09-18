import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const BINARY = join(REPO, "dist", process.platform === "win32" ? "kerstel.exe" : "kerstel");
const dirs: string[] = [];
/** Every KERSTEL_HOME a test ran the binary under, whose daemon afterAll stops. */
const homes: string[] = [];

beforeAll(async () => {
  // `bun run build` in packages/cli runs `build:hook` (packages/hook/build.ts)
  // before compiling the CLI -- mirrors packages/cli/test/e2e.test.ts, so the
  // binary this test drives embeds a freshly built hook, not a stale one.
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

afterAll(async () => {
  // Here rather than at the end of the test body, so a failed assertion
  // cannot skip it and leave a detached daemon running in CI.
  for (const home of homes) {
    const stop = Bun.spawn([BINARY, "daemon", "stop"], {
      env: { ...process.env, KERSTEL_HOME: home, KERSTEL_KEYCHAIN_BACKEND: "file" },
      stdout: "ignore",
      stderr: "ignore",
    });
    await stop.exited;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Single-quotes `s` for a POSIX shell, escaping any single quotes it contains. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs argv inside a real pseudo-terminal (`script`), pressing Enter each
 * time one of `prompts` appears in what the child has printed so far.
 *
 * The terminal is given a fixed, real size (`stty cols 100 rows 40`) before
 * the binary starts: without that, clack sees a 0-column terminal and wraps
 * every line of output to one character.
 *
 * `script` reads window size and terminal modes off its own stdin with
 * `tcgetattr`, which errors ("Operation not supported on socket") when that
 * fd is the socket Bun's `stdin: "pipe"` hands it directly. Routing our pipe
 * through `cat` first gives `script` a real anonymous pipe instead -- the
 * same fd type an interactive shell pipeline would give it -- which
 * `tcgetattr` tolerates.
 */
async function inTerminal(argv: string[], cwd: string, env: Record<string, string>, prompts: string[]) {
  const inner = `stty cols 100 rows 40; exec ${argv.map(shQuote).join(" ")}`;
  const scripted =
    process.platform === "darwin"
      ? `script -q /dev/null sh -c ${shQuote(inner)}`
      : `script -qec ${shQuote(inner)} /dev/null`;
  const proc = Bun.spawn(["sh", "-c", `cat | ${scripted}`], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let seen = "";
  let next = 0;
  const decoder = new TextDecoder();
  const timer = setTimeout(() => proc.kill(), 30_000);
  for await (const chunk of proc.stdout) {
    seen += decoder.decode(chunk);
    while (next < prompts.length && seen.includes(prompts[next]!)) {
      await Bun.sleep(150);
      proc.stdin.write("\r");
      proc.stdin.flush();
      next += 1;
      // No more input is expected once every prompt has been answered.
      // Closing our end sends `cat` EOF, so the whole pipeline can exit
      // instead of hanging on a reader that will never see more data.
      if (next === prompts.length) {
        await Bun.sleep(50);
        proc.stdin.end();
      }
    }
  }
  clearTimeout(timer);
  return { code: await proc.exited, output: seen };
}

test.if(process.platform === "darwin" || process.platform === "linux")(
  "init in a real terminal: Enter accepts the suggestions and applies them",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "kerstel-tty-home-"));
    const root = mkdtempSync(join(tmpdir(), "kerstel-tty-app-"));
    dirs.push(home, root);
    homes.push(home);
    writeFileSync(join(root, "package.json"), '{\n  "name": "tty-app",\n  "scripts": {\n    "dev": "node app.js"\n  }\n}\n');
    writeFileSync(join(root, ".env"), "PORT=3000\nDB_PASSWORD=correct-horse-battery\n");

    const { code, output } = await inTerminal(
      [BINARY, "init"],
      root,
      { KERSTEL_HOME: home, KERSTEL_KEYCHAIN_BACKEND: "file" },
      ["Look right?", "Apply these changes?"],
    );

    expect(code).toBe(0);
    expect(output).not.toContain("correct-horse-battery");
    expect(output).toContain("Look right?");
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("PORT=3000\nDB_PASSWORD=kerstel://tty-app/DB_PASSWORD\n");
    expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"dev": "kerstel exec -- node app.js"');
  },
  60_000,
);
