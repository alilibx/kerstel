import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../server/src/app";
import { openDatabase } from "../../server/src/db";
import { syncCommand } from "../src/commands/sync";
import type { CliContext } from "../src/context";
import { ScriptedPrompter, type Choice } from "../src/init/prompts";
import type { Fetch } from "../src/sync/http";
import { readInstallRecord, writeInstallRecord } from "../src/sync/install-record";
import type { Host, InstallerRun } from "../src/sync/remote";
import { encodeServerValue } from "../src/sync/server-value";
import { loadSync } from "../src/sync/state";
import type { SyncTimer } from "../src/sync/timer";
import { runWizard, type WizardDeps } from "../src/sync/wizard";
import { cliName } from "../src/ui/cli-name";
import { VERSION } from "../src/version";
import { generateDataKey } from "../src/vault/crypto";
import { openVault, type Vault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";
import { startTlsServer, type TlsServer } from "./helpers/tls-server";

/** Task 8: `ks sync setup` with no arguments on a terminal. No real ssh, docker or sudo runs here. */

const TOKEN = "wizard-enroll-token-for-the-tests-only";
const SECRET = "db-secret-value-in-the-vault";
const CLI = cliName();

const dirs: string[] = [];
const listeners: TlsServer[] = [];
afterEach(() => {
  restoreEnv();
  delete process.env.KERSTEL_SYNC_ENROLL_TOKEN;
  while (listeners.length > 0) listeners.pop()!.stop();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function device() {
  const home = isolateEnv({ prefix: "wizard" });
  dirs.push(home);
  delete process.env.KERSTEL_SYNC_ENROLL_TOKEN;
  const file = join(home, "vault.db");
  const key = generateDataKey();
  const open = (): Vault => openVault(key, file);
  const d = {
    home,
    key,
    open,
    context: async () => ({ vault: open(), dataKey: key }) as unknown as CliContext,
    with<T>(use: (vault: Vault) => T): T {
      const v = open();
      try {
        return use(v);
      } finally {
        v.close();
      }
    },
  };
  d.with((v) => v.setSecret({ scope: "app", key: "DB" }, SECRET));
  return d;
}
type Device = ReturnType<typeof device>;

/** `kerstel-server --tls self`, wanting `TOKEN`, and the value its installer would print. */
function server() {
  const listener = startTlsServer({ enrollToken: TOKEN });
  listeners.push(listener);
  return { listener, value: encodeServerValue({ urls: [listener.url], pin: listener.pin, token: TOKEN }) };
}

/** What `kerstel-server.sh detect` prints. */
function facts(o: { os?: string; arch?: string; docker?: boolean; tailscale?: string; ipv4?: string[]; installed?: string; installId?: string } = {}): string[] {
  const lines = [
    `os=${o.os ?? "linux"}`,
    `arch=${o.arch ?? "arm64"}`,
    `docker=${o.docker === false ? "no" : "yes"}`,
    "systemd=yes",
    `tailscale=${o.tailscale ?? "no"}`,
    "hostname=homebox",
    ...(o.ipv4 ?? ["192.168.1.20"]).map((ip) => `ipv4=${ip}`),
    `installed=${o.installed ?? "no"}`,
  ];
  if (o.installId) lines.push(`install-id=${o.installId}`);
  return lines;
}

interface Call {
  route: "ssh" | "local";
  target: string | null;
  args: string[];
  interactive: boolean;
}

/** A host whose installer answers from a script: `detect` prints `detected`, `install` prints `value`. */
function fakeHost(o: { detected: string[]; value?: string; install?: () => InstallerRun }) {
  const calls: Call[] = [];
  const hostFor = (route: "ssh" | "local", target: string | null): Host => ({
    label: route === "ssh" ? target! : "this machine",
    async run(args, opts = {}) {
      calls.push({ route, target, args, interactive: opts.interactive === true });
      if (args[0] === "detect") return { code: 0, lines: o.detected, value: null };
      if (args[0] === "install") return o.install ? o.install() : { code: 0, lines: [], value: o.value ?? null };
      return { code: 1, lines: [], value: null };
    },
  });
  return { calls, hostFor, installs: () => calls.filter((c) => c.args[0] === "install") };
}

/** A ScriptedPrompter that also keeps every select's choices and every text's options. */
class Recorder extends ScriptedPrompter {
  readonly choices = new Map<string, Choice<string>[]>();
  readonly texts = new Map<string, { secret?: boolean; initial?: string }>();
  override async select<T extends string>(question: string, choices: Choice<T>[], d: T): Promise<T> {
    this.choices.set(question, choices);
    return super.select(question, choices, d);
  }
  override async text(question: string, options: { secret?: boolean; initial?: string } = {}): Promise<string> {
    this.texts.set(question, options);
    return super.text(question, options);
  }
}

const fakeTimer: SyncTimer = {
  status: () => ({ state: "installed", kind: "launchd", current: true }),
  ensure: () => "unchanged",
  remove: () => true,
};

/** Runs the wizard on `d`, keeping everything it prints on stdout and stderr. */
async function wizard(d: Device, answers: string[], deps: Partial<WizardDeps> = {}) {
  const prompter = new Recorder(answers);
  const printed: string[] = [];
  const realLog = console.log;
  const realErr = process.stderr.write;
  console.log = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
  process.stderr.write = ((chunk: string | Uint8Array) => {
    printed.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runWizard(await d.context(), {
      prompter,
      interactive: true,
      deviceName: "laptop",
      timer: fakeTimer,
      resolves: async () => false,
      resolveAll: async () => [],
      hostFor: () => {
        throw new Error("this test runs no host");
      },
      ...deps,
    });
    return { code, out: printed.join("\n"), prompter };
  } finally {
    console.log = realLog;
    process.stderr.write = realErr;
  }
}

/** The value after `flag` in an installer argv, or every value when `all`. */
const flag = (args: string[], name: string): string | undefined => args[args.indexOf(name) + 1];
const flags = (args: string[], name: string): string[] => args.flatMap((a, i) => (a === name ? [args[i + 1]!] : []));

const syncedTo = (d: Device) => d.with((v) => loadSync(v, d.key));

describe("the setup wizard", () => {
  test("over SSH with Docker, the default path ends synced", async () => {
    const s = server();
    const host = fakeHost({ detected: facts(), value: s.value });
    const d = device();
    const { code, out, prompter } = await wizard(d, ["ssh", "ali@homebox", "docker", "self", "192.168.1.20"], { hostFor: host.hostFor });

    expect(code).toBe(0);
    expect(prompter.asked).toEqual([
      "Where should the sync server run?",
      'SSH host (as you\'d type it after "ssh")',
      "Run the server with",
      "How will your other devices reach it?",
      "Address your devices use (found 192.168.1.20)",
    ]);
    expect(prompter.choices.get("Where should the sync server run?")!.map((c) => [c.value, c.label])).toEqual([
      ["ssh", "On another machine, over SSH"],
      ["manual", "On another machine, I'll run a command there myself"],
      ["local", "On this machine"],
      ["existing", "I already have a server"],
    ]);
    expect(prompter.choices.get("Run the server with")!.map((c) => c.label)).toEqual([
      `Docker (ghcr.io/alilibx/kerstel-server:${VERSION})`,
      "A service, no Docker (systemd, checksum-verified binary)",
    ]);
    expect(prompter.texts.get("Address your devices use (found 192.168.1.20)")!.initial).toBe("192.168.1.20");
    expect(out).toContain("Connecting with your SSH setup… Linux arm64, Docker found.");

    // Detection runs without a terminal; the install gets one, for sudo.
    expect(host.calls.map((c) => [c.route, c.target, c.args[0], c.interactive])).toEqual([
      ["ssh", "ali@homebox", "detect", false],
      ["ssh", "ali@homebox", "install", true],
    ]);
    const args = host.installs()[0]!.args;
    const record = readInstallRecord()!;
    expect(flag(args, "--version")).toBe(VERSION);
    expect(flag(args, "--install-id")).toBe(record.installId);
    expect(flag(args, "--runtime")).toBe("docker");
    expect(flag(args, "--reach")).toBe("self");
    expect(flag(args, "--port")).toBe("8787");
    expect(flags(args, "--name")).toEqual(["192.168.1.20"]);
    expect(flags(args, "--url")).toEqual(["https://192.168.1.20:8787"]);

    expect(out).toContain("Server running on ali@homebox, restarts on reboot");
    expect(out).toContain("Synced 1 secret.");
    expect(out).toContain(`Add your other devices with:  ${CLI} sync add-device`);
    expect(record).toMatchObject({ route: "ssh", host: "ali@homebox", runtime: "docker", reach: "self", version: VERSION, finished: true });
    const config = syncedTo(d)!;
    expect(config.servers).toEqual([s.listener.url]);
    expect(config.pin).toEqual(s.listener.pin);
  });

  test("an empty address answer keeps the addresses found", async () => {
    const s = server();
    const host = fakeHost({ detected: facts({ ipv4: ["192.168.1.20", "169.254.3.4"] }), value: s.value });
    const d = device();
    const { code } = await wizard(d, ["ssh", "ali@homebox", "docker", "self", ""], {
      hostFor: host.hostFor,
      resolves: async (name) => name === "homebox.local",
    });
    expect(code).toBe(0);
    const args = host.installs()[0]!.args;
    // The link-local address is never offered.
    expect(flags(args, "--url")).toEqual(["https://homebox.local:8787", "https://192.168.1.20:8787"]);
    expect(flags(args, "--name")).toEqual(["homebox.local", "192.168.1.20"]);
  });

  test("with no address found it asks with no default and refuses an empty answer", async () => {
    const s = server();
    const host = fakeHost({ detected: facts({ ipv4: ["169.254.3.4"] }), value: s.value });
    const d = device();
    const { code, prompter } = await wizard(d, ["ssh", "ali@homebox", "docker", "self", "", "10.0.0.5, box.lan"], {
      hostFor: host.hostFor,
    });
    expect(code).toBe(0);
    expect(prompter.asked.slice(4)).toEqual(["Address your devices use", "Address your devices use"]);
    expect(prompter.texts.get("Address your devices use")!.initial).toBeUndefined();
    expect(flags(host.installs()[0]!.args, "--url")).toEqual(["https://10.0.0.5:8787", "https://box.lan:8787"]);
  });

  test("without Docker it uses a service and says so", async () => {
    const s = server();
    const host = fakeHost({ detected: facts({ docker: false }), value: s.value });
    const d = device();
    const { code, out, prompter } = await wizard(d, ["ssh", "ali@homebox", "self", "192.168.1.20"], { hostFor: host.hostFor });
    expect(code).toBe(0);
    expect(prompter.asked).not.toContain("Run the server with");
    expect(out).toContain("Connecting with your SSH setup… Linux arm64, no Docker.");
    expect(out).toContain("No Docker on ali@homebox, so the server runs as a service.");
    expect(flag(host.installs()[0]!.args, "--runtime")).toBe("service");
    expect(readInstallRecord()!.runtime).toBe("service");
  });

  test("a Linux host with neither Docker nor systemd stops before any change", async () => {
    const host = fakeHost({ detected: facts({ docker: false }).map((l) => (l === "systemd=yes" ? "systemd=no" : l)) });
    const d = device();
    const { code, out } = await wizard(d, ["ssh", "ali@homebox"], { hostFor: host.hostFor });
    expect(code).toBe(1);
    expect(out).toContain("ali@homebox has neither Docker nor systemd, so kerstel-server cannot run there.");
    expect(host.installs()).toEqual([]);
    expect(readInstallRecord()).toBeNull();
  });

  test("on macOS the service is launchd", async () => {
    const s = server();
    const host = fakeHost({ detected: facts({ os: "darwin" }), value: s.value });
    const d = device();
    const { code, out, prompter } = await wizard(d, ["local", "service", "self", ""], { hostFor: host.hostFor });
    expect(code).toBe(0);
    expect(host.calls.map((c) => [c.route, c.target])).toEqual([
      ["local", null],
      ["local", null],
    ]);
    expect(out).toContain("macOS arm64, Docker found.");
    expect(prompter.choices.get("Run the server with")![1]!.label).toBe("A service, no Docker (launchd, checksum-verified binary)");
    expect(readInstallRecord()).toMatchObject({ route: "local", host: null, runtime: "service", finished: true });
  });

  test("Tailscale is offered only when detected", async () => {
    const plain = fakeHost({ detected: facts(), value: server().value });
    const without = await wizard(device(), ["ssh", "ali@homebox", "docker", "self", "192.168.1.20"], { hostFor: plain.hostFor });
    expect(without.code).toBe(0);
    expect(without.prompter.choices.get("How will your other devices reach it?")!.map((c) => c.value)).toEqual(["self", "domain"]);

    const s = server();
    const host = fakeHost({ detected: facts({ tailscale: "homebox.tail1234.ts.net." }), value: s.value });
    const d = device();
    const { code, out, prompter } = await wizard(d, ["ssh", "ali@homebox", "docker", "tailscale"], { hostFor: host.hostFor });
    expect(code).toBe(0);
    expect(prompter.choices.get("How will your other devices reach it?")!.map((c) => [c.value, c.label])).toEqual([
      ["self", "Its own certificate, pinned by your devices (no domain needed)"],
      ["domain", "My domain, with a Let's Encrypt certificate"],
      ["tailscale", "Tailscale (homebox.tail1234.ts.net, found on this host)"],
    ]);
    expect(out).toContain("Every device that syncs must be on your tailnet.");
    // No address question: the tailnet name is the address.
    expect(prompter.asked).toHaveLength(4);
    const args = host.installs()[0]!.args;
    expect(flag(args, "--reach")).toBe("tailscale");
    expect(flag(args, "--port")).toBe("8787");
    expect(flags(args, "--url")).toEqual(["https://homebox.tail1234.ts.net"]);
    expect(flags(args, "--name")).toEqual([]);
  });

  test("a domain that doesn't resolve to the host asks before going on", async () => {
    const detected = facts({ ipv4: ["203.0.113.5"] });
    const elsewhere = async () => ["198.51.100.7"];

    const stopped = fakeHost({ detected });
    const a = device();
    const first = await wizard(a, ["ssh", "ali@homebox", "docker", "domain", "sync.example.com", "stop"], {
      hostFor: stopped.hostFor,
      resolveAll: elsewhere,
    });
    expect(first.code).toBe(1);
    expect(first.prompter.asked.slice(4)).toEqual(["Domain", "Continue anyway?"]);
    expect(first.out).toContain("sync.example.com does not point at ali@homebox yet. Let's Encrypt needs it to.");
    expect(stopped.installs()).toEqual([]);
    expect(readInstallRecord()).toBeNull();

    const s = server();
    const goOn = fakeHost({ detected, value: s.value });
    const b = device();
    const second = await wizard(b, ["ssh", "ali@homebox", "docker", "domain", "sync.example.com", "continue"], {
      hostFor: goOn.hostFor,
      resolveAll: elsewhere,
    });
    expect(second.code).toBe(0);
    const args = goOn.installs()[0]!.args;
    expect(flag(args, "--reach")).toBe("domain");
    expect(flag(args, "--domain")).toBe("sync.example.com");
    expect(flag(args, "--port")).toBe("443");
    expect(flags(args, "--url")).toEqual(["https://sync.example.com"]);

    // A domain that does point at the host goes on without asking.
    const t = server();
    const pointed = fakeHost({ detected, value: t.value });
    const c = device();
    const third = await wizard(c, ["ssh", "ali@homebox", "docker", "domain", "sync.example.com"], {
      hostFor: pointed.hostFor,
      resolveAll: async (name) => (name === "sync.example.com" ? ["203.0.113.5"] : []),
    });
    expect(third.code).toBe(0);
    expect(third.out).not.toContain("does not point at");
  });

  test("the manual route prints a command and takes the pasted value", async () => {
    const s = server();
    const d = device();
    const { code, out, prompter } = await wizard(d, ["manual", "docker", "self", "192.168.1.20", s.value]);
    expect(code).toBe(0);
    expect(prompter.asked).toEqual([
      "Where should the sync server run?",
      "Run the server with",
      "How will your other devices reach it?",
      "Address your devices use",
      "Paste the server value it printed",
    ]);
    expect(prompter.texts.get("Paste the server value it printed")!.secret).toBe(true);
    const record = readInstallRecord()!;
    expect(record).toMatchObject({ route: "manual", host: null, runtime: "docker", reach: "self", finished: true });
    // The command, as printed to paste: the installer for this version, then its arguments.
    expect(out).toContain(`/releases/download/v${VERSION}/kerstel-server.sh`);
    expect(out).toContain(`sh "$f" 'install' '--version' '${VERSION}' '--install-id' '${record.installId}'`);
    expect(out).toContain("'--url' 'https://192.168.1.20:8787'");
    expect(out).toContain("Run this on the server.");
    expect(syncedTo(d)!.servers).toEqual([s.listener.url]);
  });

  test("a mistyped pasted value is asked for again", async () => {
    const s = server();
    const d = device();
    const { code, out, prompter } = await wizard(d, ["manual", "service", "domain", "sync.example.com", "ks-server1-nope", s.value]);
    expect(code).toBe(0);
    expect(out).toContain("That is not a server value, or it was cut short.");
    expect(prompter.asked.filter((q) => q === "Paste the server value it printed")).toHaveLength(2);
  });

  test("an existing server by URL or value", async () => {
    // A server value: its URLs, pin and token.
    const s = server();
    const a = device();
    const byValue = await wizard(a, ["existing", s.value]);
    expect(byValue.code).toBe(0);
    expect(byValue.prompter.texts.get("Server address, or paste a server value")!.secret).toBe(true);
    expect(syncedTo(a)!.servers).toEqual([s.listener.url]);
    expect(syncedTo(a)!.pin).toEqual(s.listener.pin);
    expect(readInstallRecord()).toBeNull();

    // A URL, and the token at a hidden prompt.
    const db = openDatabase(":memory:");
    const app = createApp({ db, version: "test", enrollToken: TOKEN });
    const fetch: Fetch = (request) => app.fetch(request, "127.0.0.1");
    const b = device();
    const byUrl = await wizard(b, ["existing", "http://127.0.0.1:8787/", TOKEN], { fetch });
    expect(byUrl.code).toBe(0);
    expect(byUrl.prompter.asked[2]).toBe("Enroll token (leave empty if the server has none)");
    expect(byUrl.prompter.texts.get("Enroll token (leave empty if the server has none)")!.secret).toBe(true);
    expect(syncedTo(b)!.servers).toEqual(["http://127.0.0.1:8787"]);

    // The token from the environment, with no question.
    const c = device();
    process.env.KERSTEL_SYNC_ENROLL_TOKEN = TOKEN;
    const fromEnv = await wizard(c, ["existing", "http://127.0.0.1:8787"], { fetch });
    expect(fromEnv.code).toBe(0);
    expect(fromEnv.prompter.asked).toHaveLength(2);
    db.close();
  });

  test("a rerun resumes an unfinished install", async () => {
    const s = server();
    const d = device();
    const broken = fakeHost({ detected: facts(), install: () => ({ code: 1, lines: [], value: null }) });
    const first = await wizard(d, ["ssh", "ali@homebox", "docker", "self", "192.168.1.20"], { hostFor: broken.hostFor });
    expect(first.code).toBe(1);
    const firstId = flag(broken.installs()[0]!.args, "--install-id")!;
    expect(readInstallRecord()).toMatchObject({ installId: firstId, finished: false });

    // The host now runs the server the first run started.
    const host = fakeHost({ detected: facts({ installed: "docker", installId: firstId }), value: s.value });
    const second = await wizard(d, ["ssh", "ali@homebox"], { hostFor: host.hostFor });
    expect(second.code).toBe(0);
    expect(second.out).toContain("Found the server this device started setting up. Continuing.");
    expect(second.prompter.asked).toHaveLength(2);
    const args = host.installs()[0]!.args;
    expect(flag(args, "--install-id")).toBe(firstId);
    expect(flag(args, "--runtime")).toBe("docker");
    expect(flags(args, "--url")).toEqual(["https://192.168.1.20:8787"]);
    expect(readInstallRecord()).toMatchObject({ installId: firstId, finished: true });
    expect(syncedTo(d)).not.toBeNull();
  });

  test("a rerun of the manual route prints the same install ID", async () => {
    const d = device();
    const first = await wizard(d, ["manual", "docker", "self", "192.168.1.20", ""]);
    expect(first.code).toBe(1);
    expect(first.out).toContain(`The install stopped. Run ${CLI} sync setup again to continue.`);
    const id = readInstallRecord()!.installId;
    const s = server();
    const second = await wizard(d, ["manual", "docker", "self", "192.168.1.20", s.value]);
    expect(second.code).toBe(0);
    expect(second.out).toContain(`'--install-id' '${id}'`);
    expect(readInstallRecord()).toMatchObject({ installId: id, finished: true });
  });

  test("a host with someone else's server is left alone", async () => {
    const d = device();
    const host = fakeHost({ detected: facts({ installed: "docker", installId: "someone-else" }) });
    const { code, out, prompter } = await wizard(d, ["ssh", "ali@homebox", "stop"], { hostFor: host.hostFor });
    expect(code).toBe(1);
    expect(out).toContain(
      `ali@homebox already runs a Kerstel server. If another device syncs with it, run ${CLI} sync add-device there instead.`,
    );
    const offered = [...prompter.choices.values()].at(-1)!;
    expect(offered.map((c) => [c.value, c.label])).toEqual([["stop", "Stop without changes"]]);
    expect(host.installs()).toEqual([]);
    expect(readInstallRecord()).toBeNull();
    expect(syncedTo(d)).toBeNull();

    // A record of another install on this device changes nothing.
    writeInstallRecord({
      installId: "mine",
      route: "ssh",
      host: "ali@homebox",
      runtime: "docker",
      reach: "self",
      addresses: ["https://192.168.1.20:8787"],
      version: VERSION,
      finished: false,
    });
    const again = await wizard(d, ["ssh", "ali@homebox", "stop"], { hostFor: host.hostFor });
    expect(again.code).toBe(1);
    expect(host.installs()).toEqual([]);
  });

  test("a failed install leaves the record unfinished and says to rerun", async () => {
    const d = device();
    const host = fakeHost({ detected: facts(), install: () => ({ code: 1, lines: ["kerstel-server.sh: Docker does not answer."], value: null }) });
    const { code, out } = await wizard(d, ["ssh", "ali@homebox", "docker", "self", "192.168.1.20"], { hostFor: host.hostFor });
    expect(code).toBe(1);
    expect(out).toContain(`The install stopped. Run ${CLI} sync setup again to continue.`);
    expect(out).not.toContain("Server running on");
    expect(readInstallRecord()).toMatchObject({ finished: false, route: "ssh", host: "ali@homebox" });
    expect(syncedTo(d)).toBeNull();
  });

  test("a failed sync after the install leaves the record unfinished", async () => {
    const s = server();
    const d = device();
    const wrong = encodeServerValue({ urls: [s.listener.url], pin: s.listener.pin, token: "a-wrong-token-for-the-test" });
    const host = fakeHost({ detected: facts(), value: wrong });
    const { code, out } = await wizard(d, ["ssh", "ali@homebox", "docker", "self", "192.168.1.20"], { hostFor: host.hostFor });
    expect(code).toBe(1);
    expect(out).toContain("Server running on ali@homebox, restarts on reboot");
    expect(out).toContain(`Run ${CLI} sync setup again to continue.`);
    expect(readInstallRecord()!.finished).toBe(false);
  });

  test("sync already on says so", async () => {
    const s = server();
    const d = device();
    expect((await wizard(d, ["existing", s.value])).code).toBe(0);
    const { code, out, prompter } = await wizard(d, []);
    expect(code).toBe(0);
    expect(prompter.asked).toEqual([]);
    expect(out).toContain(
      `Sync is already on for this vault. Run ${CLI} sync server to see the server, or ${CLI} sync add-device to add a device.`,
    );
  });

  test("the token is never printed", async () => {
    const s = server();
    const host = fakeHost({ detected: facts(), value: s.value });
    const runs = [
      await wizard(device(), ["ssh", "ali@homebox", "docker", "self", "192.168.1.20"], { hostFor: host.hostFor }),
      await wizard(device(), ["manual", "docker", "self", "192.168.1.20", s.value]),
      await wizard(device(), ["existing", s.value]),
    ];
    for (const run of runs) {
      expect(run.code).toBe(0);
      expect(run.out.includes(TOKEN)).toBe(false);
      expect(run.out.includes(s.value)).toBe(false);
      expect(run.out.includes("ks-server1-")).toBe(false);
      expect(run.out.includes(SECRET)).toBe(false);
    }
    // Neither is ever an installer argument.
    for (const call of host.calls) {
      expect(call.args.some((a) => a.includes(TOKEN) || a.includes("ks-server1-"))).toBe(false);
    }
    // A server that refuses the token does not echo it.
    const wrong = "a-wrong-token-for-the-test";
    const refused = await wizard(device(), ["existing", encodeServerValue({ urls: [s.listener.url], pin: s.listener.pin, token: wrong })]);
    expect(refused.code).toBe(1);
    expect(refused.out.includes(wrong)).toBe(false);
  });

  test("an unsupported host stops before any change", async () => {
    const host = fakeHost({ detected: facts({ os: "freebsd", arch: "x64" }) });
    const d = device();
    const { code, out } = await wizard(d, ["ssh", "ali@homebox"], { hostFor: host.hostFor });
    expect(code).toBe(1);
    expect(out).toContain("Linux x64, Linux arm64, macOS x64 and macOS arm64");
    expect(host.installs()).toEqual([]);
    expect(readInstallRecord()).toBeNull();
  });

  test("a dev build needs a release mirror for the installer", async () => {
    const host = fakeHost({ detected: facts() });
    const d = device();
    delete process.env.KERSTEL_RELEASES_URL;
    for (const route of ["ssh", "manual", "local"]) {
      const { code, out } = await wizard(d, [route], { hostFor: host.hostFor, version: "0.4.0-dev" });
      expect(code).toBe(1);
      expect(out).toContain("The server installer needs a released Kerstel, or KERSTEL_RELEASES_URL pointing at a mirror.");
    }
    expect(host.calls).toEqual([]);
    expect(readInstallRecord()).toBeNull();

    // With a mirror, it installs that version from it.
    const s = server();
    const ok = fakeHost({ detected: facts(), value: s.value });
    // A new home sets KERSTEL_RELEASES_URL to a loopback mirror.
    const e = device();
    const run = await wizard(e, ["ssh", "ali@homebox", "docker", "self", "192.168.1.20"], { hostFor: ok.hostFor, version: "0.4.0-dev" });
    expect(run.code).toBe(0);
    const args = ok.installs()[0]!.args;
    expect(flag(args, "--version")).toBe("0.4.0-dev");
    expect(flag(args, "--releases-url")).toBe("http://127.0.0.1:9");
  });

  test("setup with no arguments on a terminal runs the wizard", async () => {
    const s = server();
    const d = device();
    const prompter = new ScriptedPrompter(["existing", s.value]);
    const printed: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
    try {
      const deps: WizardDeps = { prompter, interactive: true, context: d.context, timer: fakeTimer, deviceName: "laptop" };
      expect(await syncCommand(["setup"], deps)).toBe(0);
    } finally {
      console.log = realLog;
    }
    expect(prompter.asked[0]).toBe("Where should the sync server run?");
    expect(syncedTo(d)!.servers).toEqual([s.listener.url]);
  });
});
