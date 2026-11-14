import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installerScript, installerSha256, manualCommand, manualCommandFor } from "../src/sync/installer";

const REPO_SCRIPT = join(import.meta.dir, "../../server/install/kerstel-server.sh");
const dirs: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kerstel-installer-"));
  dirs.push(d);
  return d;
}

describe("the embedded installer", () => {
  test("the embedded script is the repository's", () => {
    const text = readFileSync(REPO_SCRIPT, "utf8");
    expect(installerScript()).toBe(text);
    expect(installerSha256()).toBe(createHash("sha256").update(readFileSync(REPO_SCRIPT)).digest("hex"));
  });
});

describe("the manual command", () => {
  /** Runs `command` in a temp dir where `sh` is a fake that records its arguments, with TMPDIR inside it. */
  async function run(served: string, hash: string, args: string[]) {
    const dir = tmp();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(served) });
    servers.push(server);
    const bin = join(dir, "bin");
    const scratch = join(dir, "scratch");
    mkdirSync(bin);
    mkdirSync(scratch);
    writeFileSync(join(bin, "sh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/ran"\n`);
    chmodSync(join(bin, "sh"), 0o755);
    const command = manualCommandFor({
      url: `http://127.0.0.1:${server.port}/releases/download/v1.2.3/kerstel-server.sh`,
      sha256: hash,
      args,
    });
    // Async: a sync spawn would block the event loop that serves the mirror.
    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: scratch },
      stdout: "ignore",
      stderr: "ignore",
    });
    const exit = await proc.exited;
    const ran = existsSync(join(dir, "ran")) ? readFileSync(join(dir, "ran"), "utf8").split("\n") : null;
    return { exit, ran, left: readdirSync(scratch) };
  }

  const script = "#!/bin/sh\necho harmless\n";
  const hash = createHash("sha256").update(script).digest("hex");

  test("the manual command checks the hash before running", async () => {
    const good = await run(script, hash, ["install", "--x"]);
    expect(good.exit).toBe(0);
    expect(good.ran!.slice(1)).toEqual(["install", "--x", ""]);

    const bad = await run(script + "# changed\n", hash, ["install"]);
    expect(bad.exit).not.toBe(0);
    expect(bad.ran).toBeNull();
  });

  test("the private file is gone after a run, whether or not the check passed", async () => {
    const good = await run(script, hash, []);
    expect(good.left).toEqual([]);
    const bad = await run("tampered", hash, []);
    expect(bad.exit).not.toBe(0);
    expect(bad.left).toEqual([]);
  });

  test("arguments are quoted", async () => {
    const odd = "it's a value; $(touch pwned)";
    const result = await run(script, hash, [odd, "two words"]);
    expect(result.exit).toBe(0);
    expect(result.ran!.slice(1)).toEqual([odd, "two words", ""]);
  });

  test("an argument with a line break is refused", () => {
    expect(() => manualCommandFor({ url: "https://x.test/a", sha256: hash, args: ["a\nb"] })).toThrow();
  });

  test("manualCommand names the release asset and the embedded hash", () => {
    const command = manualCommand({ version: "0.4.0", args: ["install"], releasesUrl: "https://example.test/o/r/" });
    expect(command).toBe(
      `(f=$(mktemp) && trap 'rm -f "$f"' EXIT` +
        ` && curl -fsSL https://example.test/o/r/releases/download/v0.4.0/kerstel-server.sh -o "$f"` +
        ` && (sha256sum 2>/dev/null || shasum -a 256) < "$f" | grep -q '^${installerSha256()} '` +
        ` && sh "$f" 'install')`,
    );
  });

  test("manualCommand refuses a plain-HTTP mirror", () => {
    expect(() => manualCommand({ version: "0.4.0", args: [], releasesUrl: "http://example.test" })).toThrow();
  });
});

test("an empty KERSTEL_RELEASES_URL counts as unset", async () => {
  const { installerReleaseUrl } = await import("../src/sync/installer");
  const saved = process.env.KERSTEL_RELEASES_URL;
  process.env.KERSTEL_RELEASES_URL = "";
  try {
    expect(installerReleaseUrl("0.4.0")).toBe("https://github.com/alilibx/kerstel/releases/download/v0.4.0/kerstel-server.sh");
  } finally {
    if (saved === undefined) delete process.env.KERSTEL_RELEASES_URL;
    else process.env.KERSTEL_RELEASES_URL = saved;
  }
});
