import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installerScript, quote } from "./installer";

/** One run of the installer: its exit code, every output line but the value, and the value. */
export interface InstallerRun {
  code: number;
  lines: string[];
  value: string | null;
}

/** Where the installer runs: a host over SSH, or this machine. */
export interface Host {
  label: string;
  run(args: string[], o?: { interactive?: boolean }): Promise<InstallerRun>;
}

export type SpawnFn = (
  argv: string[],
  o: { stdin: "inherit" | string },
) => { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> };

export interface HostDeps {
  spawn?: SpawnFn;
  /** Where the session's output is copied. Defaults to stderr. */
  write?: (text: string) => void;
  /** The installer text. Defaults to the embedded `kerstel-server.sh`. */
  script?: string;
}

const defaultSpawn: SpawnFn = (argv, o) => {
  const proc = Bun.spawn(argv, {
    // Passed explicitly so a PATH set at runtime is the one searched.
    env: process.env,
    stdin: o.stdin === "inherit" ? "inherit" : new Blob([o.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited };
};

const defaultWrite = (text: string) => void process.stderr.write(text);

const VALUE = /ks-server1-[A-Za-z0-9_-]+/;
const VALUE_START = "ks-server1-";
const VALUE_LINE_START = "Server value (paste it only into Kerstel): ks-server1-";

/** The length of the longest end of `text` that a value line could still grow from. */
function heldLength(text: string): number {
  if (text.includes(VALUE_START)) return text.length;
  for (let n = Math.min(text.length, VALUE_LINE_START.length); n > 0; n--) {
    const end = text.slice(-n);
    if (VALUE_LINE_START.startsWith(end) || VALUE_START.startsWith(end)) return n;
  }
  return 0;
}

/**
 * Copies a session's output to the terminal as it arrives, except a line
 * holding a server value: that line is captured and never shown. Only a
 * partial line that could still turn into a value line is held back, so a
 * prompt with no newline (`[sudo] password for ali: `) shows at once.
 */
class OutputCopy {
  readonly lines: string[] = [];
  value: string | null = null;

  constructor(private readonly write: (text: string) => void) {}

  async copy(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let line = "";
    let shown = 0;
    const finish = (text: string, ending: string) => {
      const match = VALUE.exec(text);
      if (match) {
        this.value = match[0];
        return;
      }
      if (text.length > shown || ending) this.write(text.slice(shown) + ending);
      this.lines.push(text.replace(/\r$/, ""));
    };
    for await (const chunk of stream) {
      const parts = (line + decoder.decode(chunk, { stream: true })).split("\n");
      line = parts.pop()!;
      for (const text of parts) {
        finish(text, "\n");
        shown = 0;
      }
      const upTo = line.length - heldLength(line);
      if (upTo > shown) {
        this.write(line.slice(shown, upTo));
        shown = upTo;
      }
    }
    line += decoder.decode();
    if (line) finish(line, "");
  }
}

async function runCopying(
  spawn: SpawnFn,
  write: (text: string) => void,
  argv: string[],
  stdin: "inherit" | string,
): Promise<InstallerRun> {
  const proc = spawn(argv, { stdin });
  const out = new OutputCopy(write);
  const [code] = await Promise.all([proc.exited, out.copy(proc.stdout), out.copy(proc.stderr)]);
  return { code, lines: out.lines, value: out.value };
}

function checkArgs(args: string[]): void {
  if (args.some((arg) => /[\r\n]/.test(arg))) {
    throw new Error("An installer argument cannot contain a line break.");
  }
}

const REMOTE_SCRIPT = "~/.kerstel-server/kerstel-server.sh";

/**
 * The installer on a host over the system `ssh`, so the user's keys, agent,
 * `~/.ssh/config` and known-hosts checks apply. The first run uploads the
 * script through stdin; each run then executes it. The command `ssh` sends is
 * one string the far side's login shell parses, so every argument is quoted.
 * The script path stays bare: it is fixed, and `~` must expand.
 */
export function sshHost(target: string, deps: HostDeps = {}): Host {
  // `-oProxyCommand=…` as a host would be an option, and run a command here.
  if (!target || target.startsWith("-")) throw new Error(`Not an SSH host: ${target}`);
  const spawn = deps.spawn ?? defaultSpawn;
  const write = deps.write ?? defaultWrite;
  const ssh = (...rest: string[]) => {
    // Test-only: the end-to-end test points ssh at its own sshd through a config file.
    const config = process.env.KERSTEL_TEST_SSH_CONFIG;
    return ["ssh", ...(config ? ["-F", config] : []), ...rest];
  };
  let uploaded = false;

  return {
    label: target,
    async run(args, o = {}) {
      checkArgs(args);
      if (!uploaded) {
        const upload = await runCopying(
          spawn,
          write,
          ssh("-o", "BatchMode=no", target, `umask 077; mkdir -p ~/.kerstel-server && cat > ${REMOTE_SCRIPT}`),
          deps.script ?? installerScript(),
        );
        if (upload.code !== 0) return upload;
        uploaded = true;
      }
      // `-t` gives the session a terminal, so `sudo` can prompt; stdin then carries the answers.
      const command = [`sh ${REMOTE_SCRIPT}`, ...args.map(quote)].join(" ");
      return o.interactive
        ? runCopying(spawn, write, ssh("-t", target, command), "inherit")
        : runCopying(spawn, write, ssh("-T", target, command), "");
    },
  };
}

/** The installer on this machine, from a private temp copy deleted after each run. */
export function localHost(deps: HostDeps = {}): Host {
  const spawn = deps.spawn ?? defaultSpawn;
  const write = deps.write ?? defaultWrite;
  return {
    label: "this machine",
    async run(args, o = {}) {
      checkArgs(args);
      const dir = mkdtempSync(join(tmpdir(), "kerstel-server-"));
      try {
        const file = join(dir, "kerstel-server.sh");
        writeFileSync(file, deps.script ?? installerScript(), { mode: 0o700 });
        chmodSync(file, 0o700);
        return await runCopying(spawn, write, ["sh", file, ...args], o.interactive ? "inherit" : "");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
