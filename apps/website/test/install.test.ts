import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../src/static/install.sh");
const ASSETS = ["kerstel-darwin-arm64", "kerstel-darwin-x64", "kerstel-linux-x64", "kerstel-linux-arm64"];

// Each test spawns bash, curl, and the shimmed tools; the first one on a cold
// CI runner can take longer than bun's 5-second default.
setDefaultTimeout(20_000);

let work: string;
let release: string;
let shims: string;
let installDir: string;

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** A stub binary that names its own asset, so a test can tell which one was installed. */
function fakeBinary(asset: string): string {
  return `#!/bin/sh\n# ${asset}\necho 0.1.0\n`;
}

function writeRelease(overrides: Record<string, string> = {}): void {
  let sums = "";
  for (const asset of ASSETS) {
    const body = fakeBinary(asset);
    writeFileSync(join(release, asset), body);
    sums += `${overrides[asset] ?? sha256(body)}  ${asset}\n`;
  }
  writeFileSync(join(release, "SHA256SUMS"), sums);
}

function shim(name: string, body: string): void {
  const path = join(shims, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

async function install(env: Record<string, string>, pathPrefix = "") {
  const proc = Bun.spawn(["bash", SCRIPT], {
    env: {
      HOME: work,
      SHELL: "/bin/zsh",
      PATH: `${pathPrefix}${shims}:/usr/bin:/bin`,
      KERSTEL_INSTALL_DIR: installDir,
      KERSTEL_DOWNLOAD_BASE: `file://${release}`,
      FAKE_OS: "Darwin",
      FAKE_ARCH: "arm64",
      FAKE_TRANSLATED: "0",
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

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "kerstel-install-"));
  release = join(work, "release");
  shims = join(work, "shims");
  installDir = join(work, "bin");
  mkdirSync(release);
  mkdirSync(shims);
  shim("uname", 'case "$1" in -s) echo "$FAKE_OS" ;; -m) echo "$FAKE_ARCH" ;; esac');
  shim("sysctl", 'echo "$FAKE_TRANSLATED"');
  shim("ldd", 'echo "ldd (GNU libc) 2.39"');
  writeRelease();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

test("installs the matching binary and reports its version", async () => {
  const result = await install({});
  expect(result.code).toBe(0);
  expect(readFileSync(join(installDir, "kerstel"), "utf8")).toBe(fakeBinary("kerstel-darwin-arm64"));
  expect(result.stdout).toContain("Installed kerstel 0.1.0 to ~/bin/kerstel");
});

test("maps Linux x86_64 to linux-x64", async () => {
  const result = await install({ FAKE_OS: "Linux", FAKE_ARCH: "x86_64" });
  expect(result.code).toBe(0);
  expect(readFileSync(join(installDir, "kerstel"), "utf8")).toBe(fakeBinary("kerstel-linux-x64"));
});

test("a shell under Rosetta gets the arm64 binary", async () => {
  const result = await install({ FAKE_ARCH: "x86_64", FAKE_TRANSLATED: "1" });
  expect(result.code).toBe(0);
  expect(readFileSync(join(installDir, "kerstel"), "utf8")).toBe(fakeBinary("kerstel-darwin-arm64"));
});

test("re-running upgrades an existing copy in place", async () => {
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, "kerstel"), "old");
  const result = await install({});
  expect(result.code).toBe(0);
  expect(readFileSync(join(installDir, "kerstel"), "utf8")).toBe(fakeBinary("kerstel-darwin-arm64"));
});

test("a checksum mismatch installs nothing", async () => {
  writeRelease({ "kerstel-darwin-arm64": "0".repeat(64) });
  const result = await install({});
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("checksum mismatch");
  expect(existsSync(join(installDir, "kerstel"))).toBe(false);
});

test("an unsupported platform is refused with a build-from-source link", async () => {
  const result = await install({ FAKE_OS: "FreeBSD", FAKE_ARCH: "amd64" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("not supported yet");
  expect(result.stderr).toContain("#build-from-source");
  expect(existsSync(join(installDir, "kerstel"))).toBe(false);
});

test("a musl libc is refused even though its ldd --version exits 1", async () => {
  shim("ldd", 'echo "musl libc (x86_64)" >&2; exit 1');
  const result = await install({ FAKE_OS: "Linux", FAKE_ARCH: "x86_64" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("musl");
  expect(result.stderr).toContain("not supported yet");
  expect(existsSync(join(installDir, "kerstel"))).toBe(false);
});

test("prints a PATH hint only when the install directory is not on PATH", async () => {
  const missing = await install({});
  expect(missing.stdout).toContain("is not on your PATH");
  expect(missing.stdout).toContain(".zshrc");

  const present = await install({}, `${installDir}:`);
  expect(present.stdout).not.toContain("is not on your PATH");
});

test("a failure after staging leaves no staged file behind", async () => {
  // chmod runs between the staging copy and the rename, so failing it strands
  // the staged file unless cleanup() removes it.
  shim("chmod", "exit 1");
  const result = await install({});
  expect(result.code).not.toBe(0);
  expect(existsSync(join(installDir, "kerstel"))).toBe(false);
  expect(readdirSync(installDir).filter((name) => name.startsWith(".kerstel-install."))).toEqual([]);
});

test("creates ks as a link to kerstel", async () => {
  const result = await install({});
  expect(result.code).toBe(0);
  expect(readlinkSync(join(installDir, "ks"))).toBe("kerstel");
  expect(result.stdout).toContain("Shortcut: ks");
});

test("a re-run keeps the ks link", async () => {
  await install({});
  const again = await install({});
  expect(again.code).toBe(0);
  expect(readlinkSync(join(installDir, "ks"))).toBe("kerstel");
});

test("another ks on PATH is left alone", async () => {
  shim("ks", "echo someone else's ks");
  const result = await install({});
  expect(result.code).toBe(0);
  expect(existsSync(join(installDir, "ks"))).toBe(false);
  expect(result.stdout).toContain("ks is already taken by");
  expect(result.stdout).toContain("so use kerstel");
});

test("a regular file named ks in the install directory is left alone", async () => {
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, "ks"), "mine");
  const result = await install({});
  expect(result.code).toBe(0);
  expect(readFileSync(join(installDir, "ks"), "utf8")).toBe("mine");
});

test("a failed ln gracefully degrades to kerstel", async () => {
  shim("ln", "exit 1");
  const result = await install({});
  expect(result.code).toBe(0);
  expect(existsSync(join(installDir, "kerstel"))).toBe(true);
  expect(existsSync(join(installDir, "ks"))).toBe(false);
  expect(result.stdout).toContain("could not create");
  expect(result.stdout).toContain("so use kerstel");
});

test("piped output is plain: no colour, no progress bar, every line once", async () => {
  const result = await install({});
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("\x1b[");
  expect(result.stdout).not.toContain("%");
  expect(result.stdout).toContain("Downloading kerstel for macOS (Apple Silicon)");
  expect(result.stdout).toContain("Checksum verified");
  expect(result.stdout).toContain("What Kerstel does");
  expect(result.stdout).toContain("1. cd into a project and run:  ks init");
  expect(result.stdout).toContain("3. Check everything any time:  ks doctor");
});

test("the next steps say kerstel when the ks shortcut was skipped", async () => {
  shim("ks", "echo someone else's ks");
  const result = await install({});
  expect(result.stdout).toContain("1. cd into a project and run:  kerstel init");
});

test("NO_COLOR keeps a terminal's output plain", async () => {
  const result = await install({ NO_COLOR: "1" });
  expect(result.stdout).not.toContain("\x1b[");
});

// The progress bar only draws on a terminal, so this test gives the installer
// one through `script`. The fake release is tiny, so the bar jumps to 100%,
// but the bar, the size, and the redraw all have to be there.
test.if(process.platform === "darwin" || process.platform === "linux")(
  "on a terminal the download draws a progress bar that ends at 100%",
  async () => {
    const env = {
      HOME: work,
      // util-linux `script -c` runs the command through $SHELL, and Ubuntu has
      // no /bin/zsh; /bin/sh exists everywhere.
      SHELL: "/bin/sh",
      PATH: `${shims}:/usr/bin:/bin`,
      KERSTEL_INSTALL_DIR: installDir,
      KERSTEL_DOWNLOAD_BASE: `file://${release}`,
      FAKE_OS: "Darwin",
      FAKE_ARCH: "arm64",
      FAKE_TRANSLATED: "0",
      TERM: "xterm-256color",
    };
    // Same shape as packages/cli/test/e2e-tty.test.ts: `script` reads terminal
    // modes off its own stdin, and Bun's piped stdin is a socket it refuses, so
    // the pipe goes through `cat` first. The installer never reads stdin, so it
    // is closed straight away; `cat` then exits once `script` does.
    const inner = `bash '${SCRIPT}'`;
    const scripted =
      process.platform === "darwin" ? `script -q /dev/null ${inner}` : `script -qec '${inner}' /dev/null`;
    const proc = Bun.spawn(["sh", "-c", `cat | ${scripted}`], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`exit ${code}\nstderr:\n${stderr}\nstdout:\n${stdout}`);
    expect(stdout).toContain("\x1b[");
    expect(stdout).toMatch(/█{30}(\x1b\[0m)? 100%/);
    expect(stdout).toContain("KB");
    expect(existsSync(join(installDir, "kerstel"))).toBe(true);
  },
);

test("a pinned KERSTEL_VERSION is named in the download line", async () => {
  const result = await install({ KERSTEL_VERSION: "0.1.0", KERSTEL_DOWNLOAD_BASE: `file://${release}` });
  expect(result.stdout).toContain("Downloading kerstel 0.1.0 for macOS (Apple Silicon)");
});

test("an http:// KERSTEL_DOWNLOAD_BASE is refused before anything is downloaded", async () => {
  writeRelease();
  const result = await install({ KERSTEL_DOWNLOAD_BASE: "http://mirror.example.com/kerstel" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("KERSTEL_DOWNLOAD_BASE must be an https:// URL");
  expect(existsSync(join(installDir, "kerstel"))).toBe(false);
});

test("a loopback http:// KERSTEL_DOWNLOAD_BASE is allowed, for local mirrors and tests", async () => {
  writeRelease();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => new Response(Bun.file(join(release, new URL(req.url).pathname.split("/").pop()!))),
  });
  try {
    const result = await install({ KERSTEL_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}` });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(existsSync(join(installDir, "kerstel"))).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("a KERSTEL_VERSION that is not a version is refused before it reaches a URL", async () => {
  writeRelease();
  const result = await install({ KERSTEL_VERSION: "0.1.0/../../evil", KERSTEL_DOWNLOAD_BASE: "" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("KERSTEL_VERSION must be a version like 0.1.0");
  expect(existsSync(join(installDir, "kerstel"))).toBe(false);
});

test("a pre-release KERSTEL_VERSION, as the release rehearsal uses, is accepted", async () => {
  writeRelease();
  const result = await install({ KERSTEL_VERSION: "v0.1.0-rc.1" });
  expect(result.code).toBe(0);
});

test("every curl call is pinned to the base URL's scheme, redirects included", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const calls = script.split("\n").filter((line) => /^\s*[^#]*\bcurl -/.test(line));
  expect(calls.length).toBeGreaterThan(0);
  for (const line of calls) {
    expect(line).toContain('--proto "$CURL_PROTO"');
    expect(line).toContain('--proto-redir "$CURL_PROTO"');
  }
});

test("an http:// base that only starts with a loopback name is refused", async () => {
  writeRelease();
  for (const base of ["http://localhost:1@evil.example/rel", "http://127.0.0.1.evil.example/rel"]) {
    const result = await install({ KERSTEL_DOWNLOAD_BASE: base });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("KERSTEL_DOWNLOAD_BASE must be an https:// URL");
  }
  expect(existsSync(join(installDir, "kerstel"))).toBe(false);
});
