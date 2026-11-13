import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { parseServerValue } from "../src/server-value";
import { readSelfSignedPin } from "../src/tls";
import { FakeHost, RELEASES_URL, type HostConfig, type RunResult } from "./helpers/fake-host";

const VERSION = "0.4.0";
const ID = "install-a";
const IMAGE = `ghcr.io/alilibx/kerstel-server:${VERSION}`;
const TAILNET = "box.tail1234.ts.net";
const SLOW = 60_000;

const hosts: FakeHost[] = [];
function host(config: Partial<HostConfig> = {}): FakeHost {
  const h = new FakeHost(config);
  h.publishRelease(VERSION);
  hosts.push(h);
  return h;
}
afterAll(() => {
  for (const h of hosts) h.cleanup();
});

function install(h: FakeHost, args: string[], o: { id?: string; runtime?: "docker" | "service" } = {}): Promise<RunResult> {
  return h.run([
    "install",
    "--version",
    VERSION,
    "--install-id",
    o.id ?? ID,
    "--runtime",
    o.runtime ?? "docker",
    "--releases-url",
    RELEASES_URL,
    ...args,
  ]);
}

/** Fails with the script's stderr, never a token: the script prints none there. */
function expectOk(r: RunResult): void {
  expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: expect.any(String) });
}

const VALUE_LINE = /^Server value \(paste it only into Kerstel\): (ks-server1-\S+)$/;

function valueOf(r: RunResult): { text: string; urls: string[]; pin: Buffer | null; token: string } {
  const lines = r.stdout.split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  const match = VALUE_LINE.exec(lines[0]!);
  if (!match) throw new Error("no server value line");
  const parsed = parseServerValue(match[1]!);
  if (typeof parsed === "string") throw new Error(`server value is ${parsed}`);
  return { text: match[1]!, ...parsed };
}

const read = (file: string): string => readFileSync(file, "utf8");
const lines = (r: RunResult): string[] => r.stdout.split("\n").filter(Boolean);
const dockerCalls = (h: FakeHost, command: string) => h.calls("docker").filter((c) => c.argv[0] === command);

/** The value after each `flag` in argv. */
function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((a, i) => (a === flag && i + 1 < argv.length ? [argv[i + 1]!] : []));
}

describe("detect", () => {
  test("detect reports the host", async () => {
    const linux = host({ tailscale: TAILNET, ipv4: ["192.168.1.20", "203.0.113.7"] });
    const r = await linux.run(["detect"]);
    expectOk(r);
    expect(lines(r)).toEqual([
      "os=linux",
      "arch=x64",
      "docker=yes",
      "systemd=yes",
      `tailscale=${TAILNET}`,
      "hostname=box",
      "ipv4=192.168.1.20",
      "ipv4=203.0.113.7",
      "installed=no",
    ]);

    const mac = host({ os: "Darwin", arch: "arm64", docker: false, systemd: false, hostname: "studio.local", ipv4: ["10.0.0.5"] });
    expect(lines(await mac.run(["detect"]))).toEqual([
      "os=darwin",
      "arch=arm64",
      "docker=no",
      "systemd=no",
      "tailscale=no",
      "hostname=studio",
      "ipv4=10.0.0.5",
      "installed=no",
    ]);
  });
});

describe("install with Docker", () => {
  test(
    "install with Docker starts one container with the settings for each reach",
    async () => {
      const common = (argv: string[]) => {
        expect(flagValues(argv, "--name")).toEqual(["kerstel-server"]);
        expect(flagValues(argv, "--restart")).toEqual(["unless-stopped"]);
        expect(flagValues(argv, "-v")).toEqual(["kerstel-server:/data"]);
        expect(flagValues(argv, "--label")).toContain(`dev.kerstel.install-id=${ID}`);
        expect(flagValues(argv, "-e")).toContain("KERSTEL_SERVER_ENROLL_TOKEN_FILE=/data/enroll-token");
        expect(argv[argv.length - 1]).toBe(IMAGE);
      };

      // self: its own certificate, pinned.
      const self = host();
      const r1 = await install(self, ["--reach", "self", "--name", "box.local", "--name", "192.168.1.20"]);
      expectOk(r1);
      const runs1 = dockerCalls(self, "run");
      expect(runs1).toHaveLength(1);
      common(runs1[0]!.argv);
      expect(flagValues(runs1[0]!.argv, "-p")).toEqual(["8787:8787"]);
      expect(flagValues(runs1[0]!.argv, "-e")).toEqual([
        "KERSTEL_SERVER_ENROLL_TOKEN_FILE=/data/enroll-token",
        "KERSTEL_SERVER_TLS=self",
        "KERSTEL_SERVER_TLS_NAMES=box.local,192.168.1.20",
      ]);
      expect(dockerCalls(self, "pull").map((c) => c.argv)).toEqual([["pull", IMAGE]]);
      const v1 = valueOf(r1);
      expect(v1.urls).toEqual(["https://box.local:8787", "https://192.168.1.20:8787"]);
      expect(v1.token).toBe(read(join(self.volumeDir(), "enroll-token")).trim());
      expect(v1.pin).toEqual(readSelfSignedPin(join(self.volumeDir(), "kerstel-server.db")));
      expect(self.livePids()).toHaveLength(1);

      // domain: Let's Encrypt on 80 and 443.
      const domain = host();
      const r2 = await install(domain, ["--reach", "domain", "--domain", "sync.example.com"]);
      expectOk(r2);
      const runs2 = dockerCalls(domain, "run");
      expect(runs2).toHaveLength(1);
      common(runs2[0]!.argv);
      expect(flagValues(runs2[0]!.argv, "-p")).toEqual(["80:80", "443:443"]);
      expect(flagValues(runs2[0]!.argv, "-e")).toEqual([
        "KERSTEL_SERVER_ENROLL_TOKEN_FILE=/data/enroll-token",
        "KERSTEL_SERVER_DOMAIN=sync.example.com",
        "KERSTEL_SERVER_LISTEN=0.0.0.0:443",
      ]);
      const v2 = valueOf(r2);
      expect(v2.urls).toEqual(["https://sync.example.com"]);
      expect(v2.pin).toBeNull();
      expect(v2.token).toBe(read(join(domain.volumeDir(), "enroll-token")).trim());

      // tailscale: loopback only, served on the tailnet.
      const tail = host({ tailscale: TAILNET });
      const r3 = await install(tail, ["--reach", "tailscale"]);
      expectOk(r3);
      const runs3 = dockerCalls(tail, "run");
      expect(runs3).toHaveLength(1);
      common(runs3[0]!.argv);
      expect(flagValues(runs3[0]!.argv, "-p")).toEqual(["127.0.0.1:8787:8787"]);
      expect(flagValues(runs3[0]!.argv, "-e")).toEqual(["KERSTEL_SERVER_ENROLL_TOKEN_FILE=/data/enroll-token"]);
      expect(tail.calls("tailscale").filter((c) => c.argv[0] === "serve").map((c) => c.argv)).toEqual([["serve", "--bg", "8787"]]);
      const v3 = valueOf(r3);
      expect(v3.urls).toEqual([`https://${TAILNET}`]);
      expect(v3.pin).toBeNull();
    },
    SLOW,
  );

  test(
    "Docker and tailscale serve go through sudo, after saying why",
    async () => {
      const h = host({ dockerNeedsSudo: true, tailscale: TAILNET, tailscaleNeedsSudo: true });
      const r = await install(h, ["--reach", "tailscale"]);
      expectOk(r);
      expect(r.stderr).toContain("kerstel-server.sh: Running Docker needs sudo, because your user cannot reach the Docker daemon.");
      expect(r.stderr).toContain(
        "kerstel-server.sh: Changing what Tailscale serves needs sudo, because your user is not a Tailscale operator.",
      );
      const sudo = h.calls("sudo").map((c) => c.argv);
      expect(sudo).toContainEqual(["docker", "run", ...dockerCalls(h, "run")[0]!.argv.slice(1)]);
      expect(sudo).toContainEqual(["tailscale", "serve", "--bg", "8787"]);
      // Each line asking for sudo comes before the first sudo call it explains.
      expect(h.calls()[0]!.tool).not.toBe("sudo");
      valueOf(r);
    },
    SLOW,
  );

  test(
    "Tailscale without HTTPS certificates says how to turn them on",
    async () => {
      const h = host({ tailscale: TAILNET, tailscaleHttpsOff: true });
      const r = await install(h, ["--reach", "tailscale"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Turn on MagicDNS and HTTPS Certificates under DNS in the Tailscale admin console");
      const last = r.stderr.trimEnd().split("\n").pop();
      expect(last).toBe(
        "kerstel-server.sh: Left in place: the container kerstel-server and its volume kerstel-server. Run the same command again to continue.",
      );
      expect(r.stdout).not.toContain("ks-server1-");
    },
    SLOW,
  );

  test("--runtime docker without Docker is an error", async () => {
    const h = host({ docker: false });
    const r = await install(h, ["--reach", "self", "--name", "box.local"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("kerstel-server.sh: Docker is not installed on this host.");
    expect(r.stderr.trimEnd().split("\n").pop()).toBe("kerstel-server.sh: Nothing on this host was changed.");
  });

  test("bad options are usage errors and change nothing", async () => {
    const h = host();
    for (const extra of [
      ["--reach", "self", "--name", "box.local", "--releases-url", "http://mirror.example.com"],
      ["--reach", "domain"],
      ["--reach", "self"],
      ["--reach", "self", "--name", "box.local", "--port", "70000"],
      ["--reach", "elsewhere"],
    ]) {
      const r = await install(h, extra);
      expect(r.code).toBe(2);
      expect(r.stderr.trimEnd().split("\n").pop()).toBe("kerstel-server.sh: Nothing on this host was changed.");
    }
    expect(h.calls("docker")).toEqual([]);
  });
});

describe("reruns", () => {
  test(
    "install twice starts one server",
    async () => {
      const h = host();
      const args = ["--reach", "self", "--name", "box.local"];
      const first = await install(h, args);
      expectOk(first);
      const [pid] = h.livePids();
      const second = await install(h, args);
      expectOk(second);
      expect(second.stderr).toContain("already runs");
      expect(dockerCalls(h, "run")).toHaveLength(1);
      expect(h.livePids()).toEqual([pid!]);
      expect(valueOf(second).token).toBe(valueOf(first).token);

      // Changed settings replace the container, still only one, with the same data.
      const third = await install(h, [...args, "--port", "9443"]);
      expectOk(third);
      expect(dockerCalls(h, "run")).toHaveLength(2);
      expect(Object.keys(h.state().containers)).toEqual(["kerstel-server"]);
      expect(h.livePids()).toHaveLength(1);
      expect(valueOf(third).token).toBe(valueOf(first).token);
      expect(lines(await h.run(["detect"]))).toEqual(expect.arrayContaining(["installed=docker", `install-id=${ID}`]));

      const service = host();
      expectOk(await install(service, args, { runtime: "service" }));
      const again = await install(service, args, { runtime: "service" });
      expectOk(again);
      expect(again.stderr).toContain("kerstel-server is already running.");
      expect(service.calls("systemctl").filter((c) => c.argv[0] === "restart")).toHaveLength(1);
      expect(service.livePids()).toHaveLength(1);
      expect(lines(await service.run(["detect"]))).toEqual(expect.arrayContaining(["installed=service", `install-id=${ID}`]));
    },
    SLOW,
  );

  test(
    "another install ID is left alone",
    async () => {
      const h = host();
      expectOk(await install(h, ["--reach", "self", "--name", "box.local"]));
      const [pid] = h.livePids();
      for (const runtime of ["docker", "service"] as const) {
        const r = await install(h, ["--reach", "self", "--name", "box.local"], { id: "install-b", runtime });
        expect(r.code).toBe(3);
        expect(r.stderr).toContain("kerstel-server.sh: this host already runs a Kerstel server that another device set up.\n");
        expect(r.stdout).toBe("");
      }
      expect(dockerCalls(h, "run")).toHaveLength(1);
      expect(h.state().containers["kerstel-server"]!.labels["dev.kerstel.install-id"]).toBe(ID);
      expect(h.livePids()).toEqual([pid!]);
      expect(existsSync(h.serverHome)).toBe(false);

      const service = host();
      expectOk(await install(service, ["--reach", "self", "--name", "box.local"], { runtime: "service" }));
      const r = await install(service, ["--reach", "self", "--name", "box.local"], { id: "install-b" });
      expect(r.code).toBe(3);
      expect(dockerCalls(service, "run")).toEqual([]);
      expect(read(join(service.serverHome, "install-id")).trim()).toBe(ID);
    },
    SLOW,
  );
});

describe("the service", () => {
  test("the service install verifies the checksum", async () => {
    const h = new FakeHost();
    hosts.push(h);
    h.publishRelease(VERSION, { wrongSums: true });
    const r = await install(h, ["--reach", "self", "--name", "box.local"], { runtime: "service" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("kerstel-server.sh: The checksum of kerstel-server-linux-x64 does not match SHA256SUMS.");
    expect(r.stderr.trimEnd().split("\n").pop()).toBe("kerstel-server.sh: Nothing on this host was changed.");
    expect(existsSync(h.serverHome)).toBe(false);
    expect(existsSync(h.unitPath)).toBe(false);
    expect(h.calls("systemctl")).toEqual([]);
    expect(h.calls("sudo")).toEqual([]);
  });

  test(
    "the systemd unit runs as the user",
    async () => {
      const h = host();
      const r = await install(h, ["--reach", "self", "--name", "box.local"], { runtime: "service" });
      expectOk(r);
      const kh = h.serverHome;
      const unit = read(h.unitPath);
      expect(unit).toContain(`\nUser=${userInfo().username}\n`);
      expect(unit).toContain(`\nExecStart="${kh}/bin/kerstel-server"\n`);
      expect(unit).toContain(`\nEnvironment="KERSTEL_SERVER_DB=${kh}/kerstel-server.db"\n`);
      expect(unit).toContain(`\nEnvironment="KERSTEL_SERVER_ENROLL_TOKEN_FILE=${kh}/enroll-token"\n`);
      expect(unit).toContain('\nEnvironment="KERSTEL_SERVER_LISTEN=0.0.0.0:8787"\n');
      expect(unit).toContain('\nEnvironment="KERSTEL_SERVER_TLS=self"\n');
      expect(unit).toContain('\nEnvironment="KERSTEL_SERVER_TLS_NAMES=box.local"\n');
      expect(unit).toContain("\nWantedBy=multi-user.target\n");
      expect(unit).not.toContain("AmbientCapabilities");
      expect(read(join(kh, "install-id")).trim()).toBe(ID);
      expect(read(join(kh, "bin/kerstel-server"))).toContain(`kerstel-server ${VERSION} linux-x64`);

      // sudo is asked for once, after a line saying why, and systemctl runs only through it.
      expect(r.stderr).toContain(
        `kerstel-server.sh: Installing the service needs sudo once, because ${h.unitPath} belongs to root and systemd starts it.`,
      );
      expect(h.calls("systemctl").every((c) => c.sudo)).toBe(true);
      expect(h.calls("systemctl").map((c) => c.argv)).toEqual([
        ["daemon-reload"],
        ["enable", "--quiet", "kerstel-server.service"],
        ["restart", "kerstel-server.service"],
      ]);
      const value = valueOf(r);
      expect(value.pin).toEqual(readSelfSignedPin(join(kh, "kerstel-server.db")));
      expect(value.token).toBe(read(join(kh, "enroll-token")).trim());

      const domain = host();
      expectOk(await install(domain, ["--reach", "domain", "--domain", "sync.example.com"], { runtime: "service" }));
      const domainUnit = read(domain.unitPath);
      expect(domainUnit).toContain("\nAmbientCapabilities=CAP_NET_BIND_SERVICE\n");
      expect(domainUnit).toContain('\nEnvironment="KERSTEL_SERVER_DOMAIN=sync.example.com"\n');
    },
    SLOW,
  );

  test(
    "the launchd plist runs as the user",
    async () => {
      const h = host({ os: "Darwin", arch: "arm64", docker: false, systemd: false });
      const r = await install(h, ["--reach", "self", "--name", "studio.local"], { runtime: "service" });
      expectOk(r);
      const plist = read(h.plistPath);
      expect(plist).toContain(`<key>UserName</key>\n  <string>${userInfo().username}</string>`);
      expect(plist).toContain("<string>dev.kerstel.server</string>");
      expect(plist).toContain(`<string>${h.serverHome}/bin/kerstel-server</string>`);
      expect(read(join(h.serverHome, "bin/kerstel-server"))).toContain("darwin-arm64");
      expect(h.calls("launchctl").filter((c) => c.argv[0] !== "print").every((c) => c.sudo)).toBe(true);
      expect(h.calls("launchctl").map((c) => c.argv[0])).toContain("bootstrap");
      valueOf(r);
    },
    SLOW,
  );
});

describe("secrets", () => {
  test(
    "the token never reaches argv",
    async () => {
      const docker = host({ tailscale: TAILNET });
      const d = await install(docker, ["--reach", "tailscale"]);
      expectOk(d);
      const again = await docker.run(["value", "--url", "https://a.example:8787"]);
      expectOk(again);

      const service = host();
      const s = await install(service, ["--reach", "self", "--name", "box.local"], { runtime: "service" });
      expectOk(s);
      expectOk(await service.run(["info"]));

      for (const [h, values, token] of [
        [docker, [valueOf(d).text, valueOf(again).text], read(join(docker.volumeDir(), "enroll-token")).trim()],
        [service, [valueOf(s).text], read(join(service.serverHome, "enroll-token")).trim()],
      ] as const) {
        expect(token).toHaveLength(43);
        const argv = h.allArgvText();
        expect(argv.length).toBeGreaterThan(0);
        expect(argv.includes(token)).toBe(false);
        for (const value of values) expect(argv.includes(value)).toBe(false);
        // The background servers' argv are logged too.
        expect(h.calls("spawned").length).toBeGreaterThan(0);
      }
    },
    SLOW,
  );

  test(
    "the value line is printed",
    async () => {
      const h = host();
      const r = await install(h, ["--reach", "self", "--name", "box.local", "--url", "https://box.local:8787"]);
      expectOk(r);
      expect(r.stdout).toMatch(/^Server value \(paste it only into Kerstel\): ks-server1-[A-Za-z0-9_-]+\n$/);
      expect(r.stderr).not.toContain("ks-server1-");
      const first = valueOf(r);
      expect(first.urls).toEqual(["https://box.local:8787"]);

      const again = await h.run(["value", "--url", "https://box.local:8787", "--url", "https://192.168.1.20:8787"]);
      expectOk(again);
      const second = valueOf(again);
      expect(second.urls).toEqual(["https://box.local:8787", "https://192.168.1.20:8787"]);
      expect(second.token).toBe(first.token);
      expect(second.pin).toEqual(first.pin);

      const none = await host().run(["value", "--url", "https://box.local:8787"]);
      expect(none.code).toBe(1);
      expect(none.stderr).toContain("kerstel-server.sh: No Kerstel server is installed on this host.");
    },
    SLOW,
  );
});

describe("stop, remove and update", () => {
  test(
    "stop keeps data, remove keeps data unless asked",
    async () => {
      const h = host();
      const first = valueOf(await install(h, ["--reach", "self", "--name", "box.local"]));
      const info = lines(await h.run(["info"]));
      expect(info).toEqual(expect.arrayContaining(["installed=docker", `install-id=${ID}`, "running=yes", "version=0.3.0-dev"]));
      expect(info.find((l) => l.startsWith("pin="))).toMatch(/^pin=sha256\//);

      expectOk(await h.run(["stop"]));
      expect(h.state().containers["kerstel-server"]).toBeDefined();
      expect(h.livePids()).toEqual([]);
      expect(lines(await h.run(["info"]))).toEqual(expect.arrayContaining(["running=no", `version=${VERSION}`]));
      expect(existsSync(join(h.volumeDir(), "enroll-token"))).toBe(true);

      expectOk(await h.run(["remove"]));
      expect(h.state().containers).toEqual({});
      expect(existsSync(join(h.volumeDir(), "enroll-token"))).toBe(true);
      expect(lines(await h.run(["detect"]))).toContain("installed=no");

      // The kept data comes back with the next install.
      expect(valueOf(await install(h, ["--reach", "self", "--name", "box.local"])).token).toBe(first.token);
      const removed = await h.run(["remove", "--delete-data"]);
      expectOk(removed);
      expect(existsSync(h.volumeDir())).toBe(false);
      expect(h.state().volumes).toEqual([]);

      const s = host();
      expectOk(await install(s, ["--reach", "self", "--name", "box.local"], { runtime: "service" }));
      const kh = s.serverHome;
      expectOk(await s.run(["stop"]));
      expect(s.calls("systemctl").pop()).toEqual({ tool: "systemctl", argv: ["disable", "--now", "--quiet", "kerstel-server.service"], sudo: true });
      expect(s.livePids()).toEqual([]);
      expect(lines(await s.run(["info"]))).toContain("running=no");
      expect(existsSync(join(kh, "enroll-token"))).toBe(true);

      expectOk(await s.run(["remove"]));
      expect(existsSync(s.unitPath)).toBe(false);
      expect(existsSync(join(kh, "bin/kerstel-server"))).toBe(false);
      expect(existsSync(join(kh, "install-id"))).toBe(false);
      expect(existsSync(join(kh, "enroll-token"))).toBe(true);
      expect(existsSync(join(kh, "kerstel-server.db"))).toBe(true);
      expect(lines(await s.run(["detect"]))).toContain("installed=no");

      expectOk(await s.run(["remove", "--delete-data"]));
      expect(existsSync(join(kh, "enroll-token"))).toBe(false);
      expect(existsSync(join(kh, "kerstel-server.db"))).toBe(false);
    },
    SLOW,
  );

  test(
    "update keeps the install ID and settings",
    async () => {
      const next = "0.4.1";
      const h = host();
      const before = valueOf(await install(h, ["--reach", "self", "--name", "box.local", "--port", "9443"]));
      const old = h.state().containers["kerstel-server"]!;
      const r = await h.run(["update", "--version", next]);
      expectOk(r);
      const now = h.state().containers["kerstel-server"]!;
      expect(now.image).toBe(`ghcr.io/alilibx/kerstel-server:${next}`);
      expect(now.labels).toEqual(old.labels);
      expect(now.env).toEqual(old.env);
      expect(now.ports).toEqual(["9443:8787"]);
      expect(now.volumes).toEqual(old.volumes);
      expect(h.livePids()).toHaveLength(1);
      const after = valueOf(await h.run(["value", "--url", "https://box.local:9443"]));
      expect(after.token).toBe(before.token);
      expect(after.pin).toEqual(before.pin);

      const s = host();
      expectOk(await install(s, ["--reach", "self", "--name", "box.local"], { runtime: "service" }));
      const unit = read(s.unitPath);
      const settings = read(join(s.serverHome, "settings"));
      s.publishRelease(next);
      expectOk(await s.run(["update", "--version", next, "--releases-url", RELEASES_URL]));
      expect(read(join(s.serverHome, "bin/kerstel-server"))).toContain(`kerstel-server ${next} linux-x64`);
      expect(read(join(s.serverHome, "install-id")).trim()).toBe(ID);
      expect(read(join(s.serverHome, "settings"))).toBe(settings);
      expect(read(s.unitPath)).toBe(unit);
      expect(s.calls("systemctl").filter((c) => c.argv[0] === "restart")).toHaveLength(2);
      expect(s.livePids()).toHaveLength(1);
    },
    SLOW,
  );
});

test.skipIf(!Bun.which("shellcheck"))("shellcheck passes", () => {
  const result = Bun.spawnSync(["shellcheck", join(import.meta.dir, "../install/kerstel-server.sh")]);
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
