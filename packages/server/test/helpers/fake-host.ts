/**
 * A fake server host for the installer tests: a temp HOME, a temp root for
 * the files the installer writes outside HOME (KERSTEL_INSTALL_ROOT), and a
 * PATH that holds only fake `docker`, `systemctl`, `launchctl`, `sudo`,
 * `tailscale`, `curl`, `uname`, `hostname` and `ip` (or `ifconfig`), plus logging shims for
 * the few real tools the script uses. Nothing real is ever reached: no Docker,
 * systemd, launchd, sudo, Tailscale or network.
 *
 * Each fake is a tiny sh wrapper that runs this file with Bun. It logs its
 * argv, then acts on state under the host's dir, which it finds in
 * FAKE_HOST_DIR. The wrappers and shims are written once per test process
 * and linked into each host: macOS checks every new executable on its first
 * run, which costs about 125 ms a file. Starting a container or a
 * service runs the real `packages/server/src/index.ts` in the background on a
 * free loopback port, against the temp data dir, and `docker exec … value`
 * runs the real `value` command, so the server value the installer prints is
 * real. A health check (`curl …/v1/health` to 127.0.0.1) reaches the real
 * server behind the host port the installer asked for.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_ENTRY = join(import.meta.dir, "../../src/index.ts");
const SCRIPT = join(import.meta.dir, "../../install/kerstel-server.sh");
const FAKES = ["docker", "systemctl", "launchctl", "sudo", "tailscale", "curl", "uname", "hostname", "ip"] as const;
/** Fakes linked into a host only when its config asks for them. */
const OPTIONAL_FAKES = ["id", "sleep", "ifconfig"] as const;
type Fake = (typeof FAKES)[number] | (typeof OPTIONAL_FAKES)[number];
/** The real tools the script may run, each behind a shim that logs its argv. */
const REAL_TOOLS = [
  "awk", "cat", "chmod", "cmp", "cp", "dirname", "grep", "head", "id", "mkdir", "mktemp", "mv", "rm",
  "rmdir", "sed", "sha256sum", "shasum", "sleep", "tee", "tr",
];
export const RELEASES_URL = "https://releases.example.test/kerstel";
const IMAGE_ENV = ["KERSTEL_SERVER_DB=/data/kerstel-server.db", "KERSTEL_SERVER_LISTEN=0.0.0.0:8787"];
const SERVICE = "kerstel-server.service";
const LAUNCHD = "system/dev.kerstel.server";

export interface HostConfig {
  os: "Linux" | "Darwin";
  arch: string;
  hostname: string;
  ipv4: string[];
  /** What `ip -o -4 addr show` prints, in place of one ethN line per `ipv4`. */
  ipLines: string[] | null;
  /** The host has `ifconfig`, which prints this, and no `ip`. */
  ifconfigLines: string[] | null;
  /** Whether the `docker` command exists. */
  docker: boolean;
  /** Docker answers only through sudo. */
  dockerNeedsSudo: boolean;
  /** The Docker daemon does not answer, even through sudo. */
  dockerDown: boolean;
  /** `sudo -n` fails: sudo would ask for a password. */
  sudoNeedsPassword: boolean;
  systemd: boolean;
  /** This host's tailnet name, or null when Tailscale is not running. */
  tailscale: string | null;
  tailscaleNeedsSudo: boolean;
  tailscaleHttpsOff: boolean;
  /** `id -u` answers 0: the script runs as root. */
  root: boolean;
  /** Nothing answers a health check, as when a firewall drops it. */
  healthDown: boolean;
  /** `sleep` waits a tenth of a second, so a test of a 30-second wait is quick. */
  quickSleep: boolean;
}

interface Container {
  image: string;
  labels: Record<string, string>;
  env: string[];
  ports: string[];
  volumes: string[];
  restart: string | null;
  pid: number | null;
}

interface State {
  images: string[];
  containers: Record<string, Container>;
  volumes: string[];
  /** Each volume's labels, when it was created with some. */
  volumeLabels: Record<string, Record<string, string>>;
  /** For each running server's PID: the host port the installer asked for, and the loopback port it really listens on. */
  listening: Record<string, { port: number | null; real: number }>;
  serve: string[];
  systemd: { pid: number | null; enabled: boolean; reloads: number };
  launchd: { pid: number | null; loaded: boolean; disabled: boolean };
  /** Every process the fakes started, for cleanup. */
  pids: number[];
}

export interface Call {
  tool: string;
  argv: string[];
  sudo: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const emptyState = (): State => ({
  images: [],
  containers: {},
  volumes: [],
  volumeLabels: {},
  listening: {},
  serve: [],
  systemd: { pid: null, enabled: false, reloads: 0 },
  launchd: { pid: null, loaded: false, disabled: false },
  pids: [],
});

export class FakeHost {
  readonly dir: string;
  readonly home: string;
  readonly root: string;
  readonly bin: string;

  constructor(config: Partial<HostConfig> = {}) {
    this.dir = mkdtempSync(join(tmpdir(), "kerstel-fake-host-"));
    this.home = join(this.dir, "home");
    this.root = join(this.dir, "root");
    this.bin = join(this.dir, "bin");
    for (const d of [this.home, this.root, this.bin, join(this.dir, "tmp"), join(this.dir, "volumes"), join(this.dir, "releases")]) {
      mkdirSync(d, { recursive: true });
    }
    const full: HostConfig = {
      os: "Linux",
      arch: "x86_64",
      hostname: "box",
      ipv4: ["192.168.1.20"],
      ipLines: null,
      ifconfigLines: null,
      docker: true,
      dockerNeedsSudo: false,
      dockerDown: false,
      sudoNeedsPassword: false,
      systemd: true,
      tailscale: null,
      tailscaleNeedsSudo: false,
      tailscaleHttpsOff: false,
      root: false,
      healthDown: false,
      quickSleep: false,
      ...config,
    };
    writeFileSync(join(this.dir, "config.json"), JSON.stringify(full));
    writeFileSync(join(this.dir, "state.json"), JSON.stringify(emptyState()));
    if (full.systemd) mkdirSync(join(this.root, "run/systemd/system"), { recursive: true });
    const tools = sharedTools();
    for (const tool of FAKES) {
      if (tool === "docker" && !full.docker) continue;
      if (tool === "ip" && full.ifconfigLines !== null) continue;
      symlinkSync(join(tools, "fakes", tool), join(this.bin, tool));
    }
    if (full.root) symlinkSync(join(tools, "fakes", "id"), join(this.bin, "id"));
    if (full.quickSleep) symlinkSync(join(tools, "fakes", "sleep"), join(this.bin, "sleep"));
    if (full.ifconfigLines !== null) symlinkSync(join(tools, "fakes", "ifconfig"), join(this.bin, "ifconfig"));
  }

  /**
   * Runs `sh kerstel-server.sh <args>` on this host. KERSTEL_TEST_SH names
   * another shell to run it with, such as /bin/dash.
   */
  async run(args: string[], o: { env?: Record<string, string> } = {}): Promise<RunResult> {
    const proc = Bun.spawn([process.env.KERSTEL_TEST_SH || "/bin/sh", SCRIPT, ...args], {
      cwd: this.home,
      env: {
        HOME: this.home,
        PATH: `${this.bin}:${join(sharedTools(), "real")}`,
        FAKE_HOST_DIR: this.dir,
        TMPDIR: join(this.dir, "tmp"),
        KERSTEL_INSTALL_ROOT: this.root,
        LANG: "C",
        ...o.env,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  }

  /** Lays out `<releases>/releases/download/v<version>/` with the four binaries and SHA256SUMS. */
  publishRelease(version: string, o: { wrongSums?: boolean } = {}): void {
    const dir = join(this.dir, "releases", `v${version}`);
    mkdirSync(dir, { recursive: true });
    const sums: string[] = [];
    for (const platform of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
      const name = `kerstel-server-${platform}`;
      // The "binary" runs the server from source. Its marker line tells versions apart.
      const text = `#!/bin/sh\n# kerstel-server ${version} ${platform} (fake release)\nexec ${q(process.execPath)} ${q(SERVER_ENTRY)} "$@"\n`;
      writeFileSync(join(dir, name), text, { mode: 0o755 });
      const hash = createHash("sha256").update(o.wrongSums ? `${text}tampered` : text).digest("hex");
      sums.push(`${hash}  ${name}`);
    }
    writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  }

  state(): State {
    return readState(this.dir);
  }

  /** Changes the host's state, as something other than the installer would. */
  seed(change: (state: State) => void): void {
    const state = readState(this.dir);
    change(state);
    writeFileSync(join(this.dir, "state.json"), JSON.stringify(state));
  }

  /** Every fake's argv, in order. */
  calls(tool?: string): Call[] {
    const file = join(this.dir, "argv.log");
    if (!existsSync(file)) return [];
    const calls = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call);
    return tool ? calls.filter((c) => c.tool === tool) : calls;
  }

  /** Every logged argv, fakes, background servers and real tools alike, as text. */
  allArgvText(): string {
    const read = (name: string) => (existsSync(join(this.dir, name)) ? readFileSync(join(this.dir, name), "utf8") : "");
    return read("argv.log") + read("real-argv.log");
  }

  /** Where the Docker volume's /data lives. */
  volumeDir(name = "kerstel-server"): string {
    return join(this.dir, "volumes", name);
  }

  get serverHome(): string {
    return join(this.home, ".kerstel-server");
  }

  get unitPath(): string {
    return join(this.root, "etc/systemd/system/kerstel-server.service");
  }

  get plistPath(): string {
    return join(this.root, "Library/LaunchDaemons/dev.kerstel.server.plist");
  }

  /** The PIDs of the servers running now. */
  livePids(): number[] {
    return [...new Set(this.state().pids)].filter(alive);
  }

  cleanup(): void {
    for (const pid of this.state().pids) stop(pid);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const q = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

let tools: string | null = null;

/**
 * The fake wrappers (`fakes/`) and the logging shims for real tools
 * (`real/`), made once per test process and removed when it exits.
 */
function sharedTools(): string {
  if (tools) return tools;
  const dir = mkdtempSync(join(tmpdir(), "kerstel-fake-tools-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "fakes"));
  mkdirSync(join(dir, "real"));
  for (const tool of [...FAKES, ...OPTIONAL_FAKES]) {
    const wrapper = `#!/bin/sh\nexec ${q(process.execPath)} ${q(import.meta.path)} "$FAKE_HOST_DIR" ${tool} "$@"\n`;
    writeFileSync(join(dir, "fakes", tool), wrapper, { mode: 0o755 });
  }
  for (const tool of REAL_TOOLS) {
    const found = Bun.which(tool, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    if (!found) continue;
    const shim = `#!/bin/sh\nprintf '%s %s\\n' ${q(tool)} "$*" >> "$FAKE_HOST_DIR/real-argv.log"\nexec ${q(found)} "$@"\n`;
    writeFileSync(join(dir, "real", tool), shim, { mode: 0o755 });
  }
  tools = dir;
  return dir;
}

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stop(pid: number | null): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

function readState(dir: string): State {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// The fakes, run as `bun fake-host.ts <dir> <tool> <args…>`

class Exit {
  constructor(readonly code: number) {}
}

function fail(code: number, message: string): never {
  process.stderr.write(`${message}\n`);
  throw new Exit(code);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

class Tools {
  readonly config: HostConfig;
  state: State;
  readonly sudo = process.env.FAKE_SUDO === "1";

  constructor(readonly dir: string) {
    this.config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    this.state = readState(dir);
  }

  save(): void {
    writeFileSync(join(this.dir, "state.json"), JSON.stringify(this.state));
  }

  log(tool: string, argv: string[]): void {
    appendFileSync(join(this.dir, "argv.log"), `${JSON.stringify({ tool, argv, sudo: this.sudo })}\n`);
  }

  /**
   * Starts a server in the background on a free loopback port, never 80, 443
   * or 8787. `port` is the host port it stands for, which a health check names.
   */
  async spawnServer(argv: string[], env: Record<string, string>, logFile: string, port: number | null): Promise<number> {
    const real = await freePort();
    const sandboxed: Record<string, string> = { ...env, KERSTEL_SERVER_LISTEN: `127.0.0.1:${real}` };
    if (sandboxed.KERSTEL_SERVER_DOMAIN) {
      // A dead loopback directory: the server makes its token, then fails to reach the CA.
      sandboxed.KERSTEL_SERVER_ACME_DIRECTORY = "http://127.0.0.1:9/directory";
      sandboxed.KERSTEL_SERVER_ACME_HTTP = "127.0.0.1:0";
    }
    this.log("spawned", argv);
    const result = Bun.spawnSync(["/bin/sh", "-c", '"$@" >>"$0" 2>&1 </dev/null & echo $!', logFile, ...argv], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...sandboxed },
      stdout: "pipe",
      stderr: "inherit",
    });
    const pid = Number(result.stdout.toString().trim());
    this.state.pids.push(pid);
    this.state.listening[String(pid)] = { port, real };
    return pid;
  }

  async run(tool: Fake, argv: string[]): Promise<number> {
    this.log(tool, argv);
    try {
      switch (tool) {
        case "docker":
          return await this.docker(argv);
        case "systemctl":
          return await this.systemctl(argv);
        case "launchctl":
          return await this.launchctl(argv);
        case "sudo":
          return this.sudoRun(argv);
        case "tailscale":
          return this.tailscale(argv);
        case "curl":
          return await this.curl(argv);
        case "id":
          // Only linked for a host whose config says root.
          process.stdout.write(argv.includes("-un") || argv.includes("-n") ? "root\n" : "0\n");
          return 0;
        case "sleep":
          await Bun.sleep(100);
          return 0;
        case "uname":
          process.stdout.write(`${argv.includes("-m") ? this.config.arch : this.config.os}\n`);
          return 0;
        case "hostname":
          process.stdout.write(`${this.config.hostname}\n`);
          return 0;
        case "ip":
          process.stdout.write(
            (
              this.config.ipLines ?? [
                "1: lo    inet 127.0.0.1/8 scope host lo",
                ...this.config.ipv4.map((ip, i) => `${i + 2}: eth${i}    inet ${ip}/24 brd x scope global eth${i}`),
              ]
            )
              .map((l) => `${l}\n`)
              .join(""),
          );
          return 0;
        case "ifconfig":
          // Only linked for a host whose config gives its output.
          process.stdout.write((this.config.ifconfigLines ?? []).map((l) => `${l}\n`).join(""));
          return 0;
      }
    } catch (error) {
      if (error instanceof Exit) return error.code;
      throw error;
    } finally {
      this.save();
    }
  }

  sudoRun(argv: string[]): number {
    const flags: string[] = [];
    while (argv[0]?.startsWith("-")) {
      flags.push(argv[0]);
      argv = argv.slice(1);
    }
    if (this.config.sudoNeedsPassword && flags.includes("-n")) fail(1, "sudo: a password is required");
    if (argv[0] === "true") return 0;
    const result = Bun.spawnSync(argv, { env: { ...process.env, FAKE_SUDO: "1" }, stdio: ["inherit", "inherit", "inherit"] });
    // The child changed the state; keep its copy.
    this.state = readState(this.dir);
    return result.exitCode ?? 1;
  }

  // -- docker ---------------------------------------------------------------

  containerEnv(c: Container): Record<string, string> {
    const env: Record<string, string> = {};
    for (const kv of [...IMAGE_ENV, ...c.env]) {
      const at = kv.indexOf("=");
      env[kv.slice(0, at)] = kv.slice(at + 1).replace(/^\/data(?=\/|$)/, this.volumeOf(c));
    }
    return env;
  }

  volumeOf(c: Container): string {
    const name = c.volumes.find((v) => v.endsWith(":/data"))?.split(":")[0] ?? "anonymous";
    return join(this.dir, "volumes", name);
  }

  async startContainer(name: string): Promise<void> {
    const c = this.state.containers[name]!;
    if (alive(c.pid)) return;
    // `-p 8787:8787` or `-p 127.0.0.1:8787:8787`: the host port is the one before the container's.
    const published = c.ports.map((p) => p.split(":")).find((parts) => parts.at(-1) === "8787");
    const port = published ? Number(published.at(-2)) : null;
    c.pid = await this.spawnServer([process.execPath, SERVER_ENTRY], this.containerEnv(c), join(this.dir, `${name}.log`), port);
  }

  format(template: string, c: Container): string {
    return template.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, expr: string) => {
      const label = /^index \.Config\.Labels "([^"]+)"$/.exec(expr);
      if (label) return c.labels[label[1]!] ?? "";
      if (expr === ".Config.Image" || expr === ".Image") return c.image;
      if (expr === ".State.Running") return String(alive(c.pid));
      throw new Error(`fake docker: no template ${expr}`);
    });
  }

  async docker(argv: string[]): Promise<number> {
    if (this.config.dockerDown) fail(1, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
    if (this.config.dockerNeedsSudo && !this.sudo) {
      fail(1, "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock");
    }
    const [command, ...rest] = argv;
    const s = this.state;
    const container = (name: string | undefined): Container => {
      const c = name ? s.containers[name] : undefined;
      if (!c) fail(1, `Error response from daemon: No such container: ${name}`);
      return c;
    };
    switch (command) {
      case "info":
        process.stdout.write("Server Version: fake\n");
        return 0;
      case "image": {
        const image = rest[rest.length - 1]!;
        if (rest[0] !== "inspect") throw new Error(`fake docker: image ${rest[0]}`);
        if (!s.images.includes(image)) fail(1, `Error response from daemon: No such image: ${image}`);
        process.stdout.write("[{}]\n");
        return 0;
      }
      case "ps": {
        // Only `ps -a --format <template>`: one line per container.
        const at = rest.indexOf("--format");
        if (!rest.includes("-a") || at < 0) throw new Error(`fake docker: ps ${rest.join(" ")}`);
        for (const c of Object.values(s.containers)) process.stdout.write(`${this.format(rest[at + 1]!, c)}\n`);
        return 0;
      }
      case "pull":
        if (!s.images.includes(rest[0]!)) s.images.push(rest[0]!);
        process.stdout.write(`Pulled ${rest[0]}\n`);
        return 0;
      case "container":
      case "inspect": {
        const args = command === "container" ? rest.slice(1) : rest;
        if (command === "container" && rest[0] !== "inspect") throw new Error(`fake docker: container ${rest[0]}`);
        const at = args.indexOf("--format");
        const c = container(args[args.length - 1]);
        process.stdout.write(at >= 0 ? `${this.format(args[at + 1]!, c)}\n` : "[{}]\n");
        return 0;
      }
      case "run": {
        const c: Container = { image: "", labels: {}, env: [], ports: [], volumes: [], restart: null, pid: null };
        let name = "";
        let i = 0;
        for (; i < rest.length; i++) {
          const arg = rest[i]!;
          if (arg === "-d") continue;
          if (!arg.startsWith("-")) break;
          const value = rest[++i]!;
          if (arg === "--name") name = value;
          else if (arg === "--label") {
            const at = value.indexOf("=");
            c.labels[value.slice(0, at)] = value.slice(at + 1);
          } else if (arg === "-e") c.env.push(value);
          else if (arg === "-p") c.ports.push(value);
          else if (arg === "-v") c.volumes.push(value);
          else if (arg === "--restart") c.restart = value;
          else throw new Error(`fake docker: run ${arg}`);
        }
        c.image = rest[i]!;
        if (s.containers[name]) fail(125, `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`);
        if (!s.images.includes(c.image)) fail(125, `Unable to find image '${c.image}' locally`);
        for (const v of c.volumes) {
          const vol = v.split(":")[0]!;
          if (!s.volumes.includes(vol)) s.volumes.push(vol);
          mkdirSync(join(this.dir, "volumes", vol), { recursive: true });
        }
        s.containers[name] = c;
        await this.startContainer(name);
        process.stdout.write("0123456789abcdef\n");
        return 0;
      }
      case "start":
        container(rest[0]);
        await this.startContainer(rest[0]!);
        return 0;
      case "stop": {
        const c = container(rest[0]);
        stop(c.pid);
        c.pid = null;
        return 0;
      }
      case "rm": {
        const name = rest[rest.length - 1]!;
        const c = container(name);
        if (alive(c.pid) && !rest.includes("-f")) fail(1, "You cannot remove a running container. Stop the container before attempting removal or force remove");
        stop(c.pid);
        delete s.containers[name];
        return 0;
      }
      case "exec": {
        const c = container(rest[0]);
        if (!alive(c.pid)) fail(1, `Error response from daemon: container ${rest[0]} is not running`);
        if (rest[1] !== "/usr/local/bin/kerstel-server") fail(127, `exec: "${rest[1]}": executable file not found in $PATH`);
        const result = Bun.spawnSync([process.execPath, SERVER_ENTRY, ...rest.slice(2)], {
          env: { PATH: process.env.PATH ?? "", ...this.containerEnv(c) },
          stdio: ["ignore", "inherit", "inherit"],
        });
        return result.exitCode ?? 1;
      }
      case "volume": {
        const name = rest[rest.length - 1]!;
        if (rest[0] === "create") {
          const labels: Record<string, string> = {};
          for (let i = 1; i < rest.length - 1; i++) {
            if (rest[i] !== "--label") throw new Error(`fake docker: volume create ${rest[i]}`);
            const value = rest[++i]!;
            labels[value.slice(0, value.indexOf("="))] = value.slice(value.indexOf("=") + 1);
          }
          if (!s.volumes.includes(name)) {
            s.volumes.push(name);
            s.volumeLabels[name] = labels;
            mkdirSync(join(this.dir, "volumes", name), { recursive: true });
          }
          process.stdout.write(`${name}\n`);
          return 0;
        }
        if (!s.volumes.includes(name)) fail(1, `Error response from daemon: get ${name}: no such volume`);
        if (rest[0] === "inspect") {
          const at = rest.indexOf("--format");
          if (at >= 0) {
            const label = /^\{\{index \.Labels "([^"]+)"\}\}$/.exec(rest[at + 1]!);
            if (!label) throw new Error(`fake docker: volume inspect --format ${rest[at + 1]}`);
            const labels = s.volumeLabels[name];
            // Docker prints <no value> for a volume with no labels at all.
            process.stdout.write(`${labels === undefined || Object.keys(labels).length === 0 ? "<no value>" : (labels[label[1]!] ?? "")}\n`);
          }
          return 0;
        }
        if (rest[0] !== "rm") throw new Error(`fake docker: volume ${rest[0]}`);
        if (Object.values(s.containers).some((c) => c.volumes.some((v) => v.startsWith(`${name}:`)))) {
          fail(1, `Error response from daemon: remove ${name}: volume is in use`);
        }
        s.volumes = s.volumes.filter((v) => v !== name);
        delete s.volumeLabels[name];
        rmSync(join(this.dir, "volumes", name), { recursive: true, force: true });
        return 0;
      }
      case "logs":
        process.stdout.write(existsSync(join(this.dir, `${rest[0]}.log`)) ? readFileSync(join(this.dir, `${rest[0]}.log`), "utf8") : "");
        return 0;
      default:
        throw new Error(`fake docker: ${command}`);
    }
  }

  // -- systemd and launchd --------------------------------------------------

  unit(): { exec: string; env: Record<string, string> } {
    const file = join(this.dir, "root/etc/systemd/system", SERVICE);
    if (!existsSync(file)) fail(5, `Failed to start ${SERVICE}: Unit ${SERVICE} not found.`);
    const unquote = (text: string) =>
      text.startsWith('"') ? text.slice(1, -1).replace(/\\(.)/g, "$1").replace(/%%/g, "%") : text;
    let exec = "";
    const env: Record<string, string> = {};
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.startsWith("ExecStart=")) exec = unquote(line.slice("ExecStart=".length));
      if (line.startsWith("Environment=")) {
        const kv = unquote(line.slice("Environment=".length));
        env[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
      }
    }
    return { exec, env };
  }

  async systemctl(argv: string[]): Promise<number> {
    const words = argv.filter((a) => !a.startsWith("-"));
    const [command] = words;
    const unitName = words[1];
    const sd = this.state.systemd;
    const privileged = !["is-active", "is-enabled", "status"].includes(command!);
    if (privileged && !this.sudo) fail(1, "Failed: Interactive authentication required.");
    if (unitName !== undefined && unitName !== SERVICE) throw new Error(`fake systemctl: unit ${unitName}`);
    const start = async () => {
      const { exec, env } = this.unit();
      if (!alive(sd.pid)) sd.pid = await this.spawnServer([exec], env, join(this.dir, "systemd.log"), listenPort(env));
    };
    switch (command) {
      case "daemon-reload":
        sd.reloads++;
        return 0;
      case "enable":
        this.unit();
        sd.enabled = true;
        if (argv.includes("--now")) await start();
        return 0;
      case "disable":
        sd.enabled = false;
        if (argv.includes("--now")) {
          stop(sd.pid);
          sd.pid = null;
        }
        return 0;
      case "start":
        await start();
        return 0;
      case "restart":
        stop(sd.pid);
        sd.pid = null;
        await start();
        return 0;
      case "stop":
        stop(sd.pid);
        sd.pid = null;
        return 0;
      case "is-active":
        if (!argv.includes("--quiet")) process.stdout.write(alive(sd.pid) ? "active\n" : "inactive\n");
        return alive(sd.pid) ? 0 : 3;
      case "is-enabled":
        return sd.enabled ? 0 : 1;
      default:
        throw new Error(`fake systemctl: ${command}`);
    }
  }

  plist(): { exec: string; env: Record<string, string>; user: string } {
    const file = join(this.dir, "root/Library/LaunchDaemons/dev.kerstel.server.plist");
    if (!existsSync(file)) fail(5, "Bootstrap failed: 2: No such file or directory");
    const xml = readFileSync(file, "utf8");
    const unescape = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const exec = unescape(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(xml)![1]!);
    const user = unescape(/<key>UserName<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)![1]!);
    const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml)![1]!;
    const env: Record<string, string> = {};
    for (const m of envBlock.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) env[unescape(m[1]!)] = unescape(m[2]!);
    return { exec, env, user };
  }

  async launchctl(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    const ld = this.state.launchd;
    if (command !== "print" && !this.sudo) fail(1, "Operation not permitted while System Integrity Protection is engaged");
    const start = async () => {
      const { exec, env } = this.plist();
      ld.pid = await this.spawnServer([exec], env, join(this.dir, "launchd.log"), listenPort(env));
    };
    switch (command) {
      case "print":
        if (rest[0] !== LAUNCHD || !ld.loaded) fail(113, `Could not find service "dev.kerstel.server" in domain for system`);
        process.stdout.write(`${LAUNCHD} = {\n\tstate = ${alive(ld.pid) ? "running" : "not running"}\n}\n`);
        return 0;
      case "enable":
        ld.disabled = false;
        return 0;
      case "disable":
        ld.disabled = true;
        return 0;
      case "bootstrap":
        if (ld.loaded) fail(5, "Bootstrap failed: 5: Input/output error");
        if (ld.disabled) fail(5, "Bootstrap failed: 5: Input/output error (service is disabled)");
        ld.loaded = true;
        await start();
        return 0;
      case "bootout":
        if (!ld.loaded) fail(3, "Boot-out failed: 3: No such process");
        stop(ld.pid);
        ld.pid = null;
        ld.loaded = false;
        return 0;
      case "kickstart":
        if (!ld.loaded) fail(113, "Could not find service");
        stop(ld.pid);
        await start();
        return 0;
      default:
        throw new Error(`fake launchctl: ${command}`);
    }
  }

  // -- tailscale and curl ---------------------------------------------------

  tailscale(argv: string[]): number {
    if (argv[0] === "status") {
      if (!this.config.tailscale) fail(1, "Tailscale is stopped.");
      process.stdout.write(`${JSON.stringify({ BackendState: "Running", Self: { DNSName: `${this.config.tailscale}.` } }, null, 2)}\n`);
      return 0;
    }
    if (argv[0] === "serve") {
      if (this.config.tailscaleNeedsSudo && !this.sudo) fail(1, "Access denied: serve config denied");
      if (this.config.tailscaleHttpsOff && argv.includes("--bg")) {
        fail(1, "HTTPS cert support is not enabled/configured for your tailnet.");
      }
      this.state.serve.push(argv.slice(1).join(" "));
      return 0;
    }
    throw new Error(`fake tailscale: ${argv[0]}`);
  }

  async curl(argv: string[]): Promise<number> {
    let out: string | null = null;
    let url: string | null = null;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "-o") out = argv[++i]!;
      else if (arg === "--proto" || arg === "--proto-redir" || arg === "--max-time") i++;
      else if (!arg.startsWith("-")) url = arg;
    }
    const health = url ? /^(https?):\/\/127\.0\.0\.1:(\d+)\/v1\/health$/.exec(url) : null;
    if (health) return this.health(health[1]!, Number(health[2]));
    const prefix = `${RELEASES_URL}/releases/download/`;
    if (!url || !out || !url.startsWith(prefix)) fail(6, `curl: (6) Could not resolve host: ${url}`);
    const file = join(this.dir, "releases", url.slice(prefix.length));
    if (!existsSync(file)) fail(22, "curl: (22) The requested URL returned error: 404");
    copyFileSync(file, out);
    chmodSync(out, 0o644);
    return 0;
  }

  /** A health check to 127.0.0.1:`port`, answered by the server standing for that host port, through its real one. */
  async health(scheme: string, port: number): Promise<number> {
    const pid = Object.keys(this.state.listening).find((p) => this.state.listening[p]!.port === port && alive(Number(p)));
    if (this.config.healthDown || pid === undefined) fail(7, `curl: (7) Failed to connect to 127.0.0.1 port ${port}`);
    try {
      const response = await fetch(`${scheme}://127.0.0.1:${this.state.listening[pid]!.real}/v1/health`, {
        tls: { rejectUnauthorized: false },
        signal: AbortSignal.timeout(2000),
      } as RequestInit);
      return response.ok ? 0 : 22;
    } catch {
      return 35;
    }
  }
}

/** The port in a service's KERSTEL_SERVER_LISTEN, which a health check names. */
function listenPort(env: Record<string, string>): number | null {
  const port = /:(\d+)$/.exec(env.KERSTEL_SERVER_LISTEN ?? "");
  return port ? Number(port[1]) : null;
}

if (import.meta.main) {
  const [dir, tool, ...argv] = process.argv.slice(2);
  const code = await new Tools(dir!).run(tool as Fake, argv);
  process.exit(code);
}
