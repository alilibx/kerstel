import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { localHost, type SpawnFn, sshHost } from "../src/sync/remote";

const UPLOAD = "umask 077; mkdir -p ~/.kerstel-server && cat > ~/.kerstel-server/kerstel-server.sh";

const dirs: string[] = [];
const savedPath = process.env.PATH;
const savedConfig = process.env.KERSTEL_TEST_SSH_CONFIG;

beforeEach(() => {
  delete process.env.KERSTEL_TEST_SSH_CONFIG;
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedConfig === undefined) delete process.env.KERSTEL_TEST_SSH_CONFIG;
  else process.env.KERSTEL_TEST_SSH_CONFIG = savedConfig;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kerstel-remote-"));
  dirs.push(d);
  return d;
}

/**
 * Puts a fake `ssh` first on PATH. Each call logs its argv (one per line) and,
 * without `-t`, its stdin, then runs the remote command (the last argument)
 * locally with `sh -c`, in a temp HOME, as the far side's login shell would.
 * The real ssh is never run.
 */
function fakeSsh() {
  const dir = tmp();
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(
    join(bin, "ssh"),
    `#!/bin/sh
dir='${dir}'
n=$(cat "$dir/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$dir/count"
tty=no
for a in "$@"; do printf '%s\\n' "$a"; [ "$a" = "-t" ] && tty=yes; done > "$dir/call-$n.argv"
for last in "$@"; do :; done
HOME="$dir/home"; export HOME; cd "$HOME" || exit 1
if [ "$tty" = yes ]; then exec sh -c "$last"; fi
cat > "$dir/call-$n.stdin"
exec sh -c "$last" < "$dir/call-$n.stdin"
`,
  );
  chmodSync(join(bin, "ssh"), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
  const count = () => (existsSync(join(dir, "count")) ? Number(readFileSync(join(dir, "count"), "utf8")) : 0);
  return {
    home,
    calls(): Array<{ argv: string[]; stdin: string | null }> {
      const out = [];
      for (let n = 1; n <= count(); n++) {
        const argv = readFileSync(join(dir, `call-${n}.argv`), "utf8").split("\n").slice(0, -1);
        const stdinFile = join(dir, `call-${n}.stdin`);
        out.push({ argv, stdin: existsSync(stdinFile) ? readFileSync(stdinFile, "utf8") : null });
      }
      return out;
    },
  };
}

function recorder() {
  const writes: string[] = [];
  return { writes, write: (s: string) => void writes.push(s), text: () => writes.join("") };
}

function fakeValue(): string {
  return `ks-server1-${randomBytes(24).toString("base64url")}`;
}

/** A spawn whose upload succeeds silently and whose run yields scripted chunks on stdout. */
function chunkedSpawn(chunks: string[], code = 0): SpawnFn {
  const stream = (parts: string[]) =>
    new ReadableStream<Uint8Array>({
      async start(c) {
        for (const p of parts) {
          c.enqueue(new TextEncoder().encode(p));
          await Bun.sleep(1);
        }
        c.close();
      },
    });
  return (argv) =>
    argv.at(-1) === UPLOAD
      ? { stdout: stream([]), stderr: stream([]), exited: Promise.resolve(0) }
      : { stdout: stream(chunks), stderr: stream([]), exited: Promise.resolve(code) };
}

describe("sshHost", () => {
  test("uploads, then runs", async () => {
    const ssh = fakeSsh();
    const script = "#!/bin/sh\nprintf 'ran:%s\\n' \"$@\"\n";
    const out = recorder();
    const host = sshHost("box", { script, write: out.write });
    expect(host.label).toBe("box");

    const first = await host.run(["detect"]);
    const second = await host.run(["install", "--x"], { interactive: true });

    expect(first).toEqual({ code: 0, lines: ["ran:detect"], value: null });
    expect(second).toEqual({ code: 0, lines: ["ran:install", "ran:--x"], value: null });
    const calls = ssh.calls();
    expect(calls.map((c) => c.argv)).toEqual([
      ["-o", "BatchMode=no", "box", UPLOAD],
      ["-T", "box", "sh ~/.kerstel-server/kerstel-server.sh 'detect'"],
      ["-t", "box", "sh ~/.kerstel-server/kerstel-server.sh 'install' '--x'"],
    ]);
    // The upload carries the script on stdin; a plain run gets an empty one.
    expect(calls[0]!.stdin).toBe(script);
    expect(calls[1]!.stdin).toBe("");
    expect(readFileSync(join(ssh.home, ".kerstel-server/kerstel-server.sh"), "utf8")).toBe(script);
    expect(out.text()).toBe("ran:detect\nran:install\nran:--x\n");
  });

  test("an argument survives the far side's shell exactly", async () => {
    fakeSsh();
    const odd = [`it's "quoted"`, "$HOME", "`id`", "a b;c", "*", ""];
    const host = sshHost("box", { script: "#!/bin/sh\nfor a; do printf 'arg:%s\\n' \"$a\"; done\n", write: () => {} });
    const run = await host.run(odd);
    expect(run.lines).toEqual(odd.map((a) => `arg:${a}`));
  });

  test("an argument with a line break is refused", async () => {
    fakeSsh();
    const host = sshHost("box", { script: "#!/bin/sh\n", write: () => {} });
    await expect(host.run(["a\nb"])).rejects.toThrow();
  });

  test("a target that ssh would read as an option is refused", () => {
    expect(() => sshHost("-oProxyCommand=touch x")).toThrow();
  });

  test("ssh argv never carries a token or a value", async () => {
    const ssh = fakeSsh();
    const token = randomBytes(32).toString("base64url");
    writeFileSync(join(ssh.home, "token"), token);
    // The host makes the value from its own token file, as the installer does.
    const script = `#!/bin/sh\nprintf 'Server value (paste it only into Kerstel): ks-server1-%s\\n' "$(cat ~/token)"\n`;
    const host = sshHost("box", { script, write: () => {} });
    const run = await host.run(["install", "--install-id", "abc"], { interactive: true });

    expect(run.code).toBe(0);
    expect(run.value === `ks-server1-${token}`).toBe(true);
    const argv = ssh.calls().flatMap((c) => c.argv);
    expect(argv.length > 0).toBe(true);
    expect(argv.some((a) => a.includes(token))).toBe(false);
    expect(argv.some((a) => a.includes("ks-server1-"))).toBe(false);
  });

  test("output passes through and only the value is held back", async () => {
    fakeSsh();
    const value = fakeValue();
    const script = [
      "#!/bin/sh",
      "printf '[sudo] password for ali: '",
      "sleep 0.3",
      "echo",
      "echo 'Installing kerstel-server.'",
      "echo 'a warning' >&2",
      `printf 'Server value (paste it only into Kerstel): %s\\n' '${value}'`,
      "echo 'Done.'",
    ].join("\n");
    const out = recorder();
    const host = sshHost("box", { script, write: out.write });
    const run = await host.run(["install"], { interactive: true });

    expect(run.value === value).toBe(true);
    // The prompt has no newline, and still reaches the terminal before the rest.
    expect(out.writes[0]).toBe("[sudo] password for ali: ");
    const shown = out.text();
    expect(shown.includes(value)).toBe(false);
    expect(shown.includes("ks-server1-")).toBe(false);
    expect(shown.includes("Server value")).toBe(false);
    for (const line of ["Installing kerstel-server.\n", "a warning\n", "Done.\n"]) {
      expect(shown.includes(line)).toBe(true);
    }
    expect(run.lines.some((l) => l.includes("ks-server1-"))).toBe(false);
    expect(run.lines).toContain("[sudo] password for ali: ");
    expect(run.lines).toContain("Installing kerstel-server.");
    expect(run.lines).toContain("a warning");
    expect(run.lines).toContain("Done.");
  });

  test("a value split across chunks is still held back", async () => {
    const value = fakeValue();
    const line = `Server value (paste it only into Kerstel): ${value}\r\n`;
    const chunks = ["before\r\nServer val", line.slice(10, 50), line.slice(50, 70), line.slice(70), "after"];
    const out = recorder();
    const host = sshHost("box", { spawn: chunkedSpawn(chunks), script: "", write: out.write });
    const run = await host.run(["install"]);

    expect(run.value === value).toBe(true);
    expect(run.lines).toEqual(["before", "after"]);
    expect(out.text()).toBe("before\r\nafter");
  });

  test("a partial line that is not a value is shown at once", async () => {
    const out = recorder();
    const host = sshHost("box", { spawn: chunkedSpawn(["Password: ", "x\n", "ks-ser", "ious\n"]), script: "", write: out.write });
    const run = await host.run(["detect"]);
    expect(run.value).toBeNull();
    expect(out.writes.slice(0, 2)).toEqual(["Password: ", "x\n"]);
    expect(out.text()).toBe("Password: x\nks-serious\n");
    expect(run.lines).toEqual(["Password: x", "ks-serious"]);
  });

  test("a failed run reports its code", async () => {
    fakeSsh();
    const host = sshHost("box", { script: "#!/bin/sh\necho 'it broke' >&2\nexit 3\n", write: () => {} });
    const run = await host.run(["install"]);
    expect(run.code).toBe(3);
    expect(run.lines).toEqual(["it broke"]);
    expect(run.value).toBeNull();
  });

  test("a failed upload reports its code and is retried on the next run", async () => {
    const ssh = fakeSsh();
    // A file where the directory belongs makes the upload fail once.
    writeFileSync(join(ssh.home, ".kerstel-server"), "");
    const host = sshHost("box", { script: "#!/bin/sh\necho ok\n", write: () => {} });
    const failed = await host.run(["detect"]);
    expect(failed.code).not.toBe(0);
    expect(ssh.calls()).toHaveLength(1);

    rmSync(join(ssh.home, ".kerstel-server"));
    const ok = await host.run(["detect"]);
    expect(ok).toEqual({ code: 0, lines: ["ok"], value: null });
    expect(ssh.calls().map((c) => c.argv.at(-1))).toEqual([
      UPLOAD,
      UPLOAD,
      "sh ~/.kerstel-server/kerstel-server.sh 'detect'",
    ]);
  });

  test("KERSTEL_TEST_SSH_CONFIG adds -F to every ssh call", async () => {
    const ssh = fakeSsh();
    process.env.KERSTEL_TEST_SSH_CONFIG = "/tmp/kerstel-test-ssh-config";
    const host = sshHost("box", { script: "#!/bin/sh\n", write: () => {} });
    await host.run(["detect"]);
    for (const call of ssh.calls()) expect(call.argv.slice(0, 2)).toEqual(["-F", "/tmp/kerstel-test-ssh-config"]);
    expect(ssh.calls()).toHaveLength(2);
  });
});

describe("localHost", () => {
  test("runs the script here with its arguments", async () => {
    const out = recorder();
    const value = fakeValue();
    const script = `#!/bin/sh\nfor a; do printf 'arg:%s\\n' "$a"; done\nprintf 'Server value (paste it only into Kerstel): %s\\n' '${value}'\n`;
    const host = localHost({ script, write: out.write });
    const run = await host.run(["install", "it's"]);
    expect(run.code).toBe(0);
    expect(run.lines).toEqual(["arg:install", "arg:it's"]);
    expect(run.value === value).toBe(true);
    expect(out.text()).toBe("arg:install\narg:it's\n");
  });

  test("localHost removes its temp copy", async () => {
    const script = `#!/bin/sh\nprintf 'path:%s\\n' "$0"\nprintf 'mode:%s\\n' "$(ls -l "$0" | cut -c1-10)"\nexit 4\n`;
    const host = localHost({ script, write: () => {} });
    const run = await host.run([]);
    expect(run.code).toBe(4);
    const path = run.lines.find((l) => l.startsWith("path:"))!.slice(5);
    expect(run.lines).toContain("mode:-rwx------");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });
});
