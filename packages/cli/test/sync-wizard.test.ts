import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../server/src/app";
import { openDatabase } from "../../server/src/db";
import { formatPin } from "../../server/src/pin";
import { syncCommand } from "../src/commands/sync";
import type { CliContext } from "../src/context";
import { ScriptedPrompter, type Choice } from "../src/init/prompts";
import type { Fetch } from "../src/sync/http";
import { readInstallRecord, writeInstallRecord, type InstallRecord } from "../src/sync/install-record";
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
  readonly defaults = new Map<string, string>();
  readonly texts = new Map<string, { secret?: boolean; initial?: string }>();
  override async select<T extends string>(question: string, choices: Choice<T>[], d: T): Promise<T> {
    this.choices.set(question, choices);
    this.defaults.set(question, d);
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
      releaseFound: async () => true,
      // Never the real `ssh -G`.
      sshHostname: async () => null,
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
    // enableSync's own hint, once.
    expect(out.split(`sync add-device`).length - 1).toBe(1);
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

  test("addresses with a port set the server's port, and mixed ports are asked again", async () => {
    const s = server();
    const host = fakeHost({ detected: facts(), value: s.value });
    const d = device();
    const { code, out, prompter } = await wizard(
      d,
      ["ssh", "ali@homebox", "docker", "self", "192.168.1.20:9443, homebox.lan", "192.168.1.20:9443, homebox.lan:9443"],
      { hostFor: host.hostFor },
    );
    expect(code).toBe(0);
    expect(out).toContain(
      "These addresses name different ports (9443, 8787). The server listens on one, so give each address the same port, or none for 8787.",
    );
    expect(prompter.asked.filter((q) => q.startsWith("Address your devices use"))).toHaveLength(2);
    const args = host.installs()[0]!.args;
    expect(flag(args, "--port")).toBe("9443");
    expect(flags(args, "--url")).toEqual(["https://192.168.1.20:9443", "https://homebox.lan:9443"]);
    expect(flags(args, "--name")).toEqual(["192.168.1.20", "homebox.lan"]);

    // A bare name gets 8787.
    const bare = fakeHost({ detected: facts(), value: s.value });
    expect((await wizard(device(), ["ssh", "ali@homebox", "docker", "self", "homebox.lan"], { hostFor: bare.hostFor })).code).toBe(0);
    expect(flag(bare.installs()[0]!.args, "--port")).toBe("8787");
    expect(flags(bare.installs()[0]!.args, "--url")).toEqual(["https://homebox.lan:8787"]);
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
    const byValue = await wizard(a, ["existing", s.value, "yes"]);
    // Today's setup: the summary, then the question before uploading.
    expect(byValue.prompter.asked.at(-1)).toBe("Upload the vault?");
    expect(byValue.out).toContain(`  Certificate  pinned (`);
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
    const byUrl = await wizard(b, ["existing", "http://127.0.0.1:8787/", TOKEN, "yes"], { fetch });
    expect(byUrl.code).toBe(0);
    expect(byUrl.prompter.asked[2]).toBe("Enroll token (leave empty if the server has none)");
    expect(byUrl.prompter.texts.get("Enroll token (leave empty if the server has none)")!.secret).toBe(true);
    expect(syncedTo(b)!.servers).toEqual(["http://127.0.0.1:8787"]);

    // The token from the environment, with no question.
    const c = device();
    process.env.KERSTEL_SYNC_ENROLL_TOKEN = TOKEN;
    const fromEnv = await wizard(c, ["existing", "http://127.0.0.1:8787", "yes"], { fetch });
    expect(fromEnv.code).toBe(0);
    expect(fromEnv.prompter.asked).toEqual(["Where should the sync server run?", "Server address, or paste a server value", "Upload the vault?"]);
    db.close();

    // An answer that is neither stops with 1, and is not repeated.
    const d = device();
    const bad = await wizard(d, ["existing", "not a server at all"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("That is not a server address or a server value.");
    expect(bad.out).not.toContain("not a server at all");
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
    const second = await wizard(d, ["ssh", "ali@homebox", ""], { hostFor: host.hostFor });
    expect(second.code).toBe(0);
    expect(second.out).toContain("Found the server this device started setting up. Continuing.");
    // Only the address is asked again, starting from the last one.
    expect(second.prompter.asked.slice(2)).toEqual(["Address your devices use"]);
    expect(second.prompter.texts.get("Address your devices use")!.initial).toBe("192.168.1.20");
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

  test("a finished manual record is replaced only on a yes, with a new install ID", async () => {
    const d = device();
    const earlier: InstallRecord = {
      installId: "first-install",
      route: "manual",
      host: null,
      runtime: "docker",
      reach: "self",
      addresses: ["https://192.168.1.20:8787"],
      version: VERSION,
      started: true,
      finished: true,
    };
    writeInstallRecord(earlier);
    const no = await wizard(d, ["manual", "no"]);
    expect(no.code).toBe(1);
    expect(no.out).toContain(`This device looks after the server on 192.168.1.20. A new server replaces that.`);
    expect(readInstallRecord()).toEqual(earlier);

    const s = server();
    const yes = await wizard(d, ["manual", "yes", "docker", "self", "192.168.1.30", s.value]);
    expect(yes.code).toBe(0);
    expect(yes.out).not.toContain("'first-install'");
    expect(readInstallRecord()!.installId).not.toBe("first-install");
    expect(readInstallRecord()).toMatchObject({ route: "manual", finished: true });
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
    expect((await wizard(d, ["existing", s.value, "yes"])).code).toBe(0);
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
      await wizard(device(), ["existing", s.value, "yes"]),
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
    const refused = await wizard(device(), ["existing", encodeServerValue({ urls: [s.listener.url], pin: s.listener.pin, token: wrong }), "yes"]);
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

  test("a version with no release stops before any change", async () => {
    const host = fakeHost({ detected: facts() });
    const d = device();
    delete process.env.KERSTEL_RELEASES_URL;
    const checked: string[] = [];
    for (const route of ["ssh", "manual", "local"]) {
      const { code, out } = await wizard(d, [route], {
        hostFor: host.hostFor,
        version: "0.4.0-dev",
        releaseFound: async (url) => (checked.push(url), false),
      });
      expect(code).toBe(1);
      expect(out).toContain(
        "No kerstel-server release v0.4.0-dev was found, so the server can't be installed from this build. Install a released Kerstel, or set KERSTEL_RELEASES_URL to a mirror.",
      );
    }
    expect(checked).toEqual(Array(3).fill("https://github.com/alilibx/kerstel/releases/download/v0.4.0-dev/kerstel-server.sh"));
    expect(host.calls).toEqual([]);
    expect(readInstallRecord()).toBeNull();
  });

  test("a mirror is checked and used, and an unreachable one does not block", async () => {
    // A new home sets KERSTEL_RELEASES_URL to a loopback mirror.
    const s = server();
    const host = fakeHost({ detected: facts(), value: s.value });
    const d = device();
    const checked: string[] = [];
    const run = await wizard(d, ["ssh", "ali@homebox", "docker", "self", "192.168.1.20"], {
      hostFor: host.hostFor,
      version: "0.4.0-dev",
      releaseFound: async (url) => (checked.push(url), null),
    });
    expect(run.code).toBe(0);
    expect(checked).toEqual(["http://127.0.0.1:9/releases/download/v0.4.0-dev/kerstel-server.sh"]);
    const args = host.installs()[0]!.args;
    expect(flag(args, "--version")).toBe("0.4.0-dev");
    expect(flag(args, "--releases-url")).toBe("http://127.0.0.1:9");
  });

  test("an unfinished install is resumed when detect cannot see it", async () => {
    const s = server();
    const d = device();
    const broken = fakeHost({ detected: facts(), install: () => ({ code: 1, lines: [], value: null }) });
    await wizard(d, ["ssh", "ali@homebox", "docker", "self", "192.168.1.20"], { hostFor: broken.hostFor });
    const firstId = readInstallRecord()!.installId;

    // Docker needs a sudo password, which detect never asks for: it reports nothing installed.
    const host = fakeHost({ detected: facts(), value: s.value });
    const second = await wizard(d, ["ssh", "ali@homebox", ""], { hostFor: host.hostFor });
    expect(second.code).toBe(0);
    expect(second.out).toContain("Continuing the setup this device started on ali@homebox.");
    expect(flag(host.installs()[0]!.args, "--install-id")).toBe(firstId);
    expect(flag(host.installs()[0]!.args, "--runtime")).toBe("docker");
    expect(readInstallRecord()).toMatchObject({ installId: firstId, finished: true });
  });

  test("Docker that detect could not check stops before any change", async () => {
    const d = device();
    const host = fakeHost({ detected: facts({ installed: "unknown" }) });
    const { code, out } = await wizard(d, ["ssh", "ali@homebox"], { hostFor: host.hostFor });
    expect(code).toBe(1);
    expect(out).toContain(
      `Could not check Docker on ali@homebox for a Kerstel server, so nothing was changed there. Check that Docker runs there and that sudo works, then run ${CLI} sync setup again.`,
    );
    expect(host.installs()).toEqual([]);
    expect(readInstallRecord()).toBeNull();
  });

  test("an installer that finds another device's server says so", async () => {
    const d = device();
    const host = fakeHost({ detected: facts(), install: () => ({ code: 3, lines: [], value: null }) });
    const { code, out } = await wizard(d, ["ssh", "ali@homebox", "docker", "self", "192.168.1.20"], { hostFor: host.hostFor });
    expect(code).toBe(1);
    expect(out).toContain(
      `ali@homebox already runs a Kerstel server. If another device syncs with it, run ${CLI} sync add-device there instead.`,
    );
    expect(out).not.toContain("The install stopped.");
    expect(readInstallRecord()).toBeNull();
  });

  test("a rerun after a failed sync can change the address", async () => {
    const s = server();
    const d = device();
    // The server is up, but this device can't sync: the token in its value is not the server's.
    const wrong = encodeServerValue({ urls: [s.listener.url], pin: s.listener.pin, token: "a-wrong-token-for-the-test" });
    const first = fakeHost({ detected: facts(), value: wrong });
    expect((await wizard(d, ["ssh", "ali@homebox", "docker", "self", "192.168.1.20"], { hostFor: first.hostFor })).code).toBe(1);
    const id = readInstallRecord()!.installId;
    expect(readInstallRecord()).toMatchObject({ started: true, finished: false });

    const host = fakeHost({ detected: facts({ installed: "docker", installId: id }), value: s.value });
    const second = await wizard(d, ["ssh", "ali@homebox", "homebox.lan"], { hostFor: host.hostFor });
    expect(second.code).toBe(0);
    const args = host.installs()[0]!.args;
    expect(flag(args, "--install-id")).toBe(id);
    expect(flags(args, "--url")).toEqual(["https://homebox.lan:8787"]);
    expect(flags(args, "--name")).toEqual(["homebox.lan"]);
  });

  test("a rerun after a failed sync through a domain offers to change how devices reach it", async () => {
    const s = server();
    const d = device();
    const wrong = encodeServerValue({ urls: [s.listener.url], pin: s.listener.pin, token: "a-wrong-token-for-the-test" });
    const detected = facts({ ipv4: ["203.0.113.5"] });
    const first = fakeHost({ detected, value: wrong });
    const resolveAll = async () => ["203.0.113.5"];
    await wizard(d, ["ssh", "ali@homebox", "docker", "domain", "sync.example.com"], { hostFor: first.hostFor, resolveAll });
    const id = readInstallRecord()!.installId;

    const host = fakeHost({ detected: facts({ ipv4: ["203.0.113.5"], installed: "docker", installId: id }), value: s.value });
    const second = await wizard(d, ["ssh", "ali@homebox", "change", "self", "203.0.113.5"], { hostFor: host.hostFor, resolveAll });
    expect(second.code).toBe(0);
    expect(second.prompter.choices.get("Reach it the same way?")!.map((c) => c.label)).toEqual([
      `Yes, keep ${s.listener.url.replace("https://", "")}`,
      "Change how devices reach it",
    ]);
    const args = host.installs()[0]!.args;
    expect(flag(args, "--install-id")).toBe(id);
    expect(flag(args, "--reach")).toBe("self");
    expect(flags(args, "--url")).toEqual(["https://203.0.113.5:8787"]);

    // A domain install that never started keeps its domain without asking.
    const e = device();
    const broken = fakeHost({ detected, install: () => ({ code: 1, lines: [], value: null }) });
    await wizard(e, ["ssh", "ali@homebox", "docker", "domain", "sync.example.com"], { hostFor: broken.hostFor, resolveAll });
    const again = fakeHost({ detected, value: s.value });
    const third = await wizard(e, ["ssh", "ali@homebox"], { hostFor: again.hostFor });
    expect(third.code).toBe(0);
    expect(flags(again.installs()[0]!.args, "--url")).toEqual(["https://sync.example.com"]);
  });

  test("an unfinished install elsewhere is replaced only when the person says so", async () => {
    const d = device();
    const broken = fakeHost({ detected: facts(), install: () => ({ code: 1, lines: [], value: null }) });
    await wizard(d, ["ssh", "ali@homebox", "docker", "self", "192.168.1.20"], { hostFor: broken.hostFor });
    const oldId = readInstallRecord()!.installId;

    const other = fakeHost({ detected: facts() });
    const stopped = await wizard(d, ["ssh", "ali@nas", "no"], { hostFor: other.hostFor });
    expect(stopped.code).toBe(1);
    expect(stopped.out).toContain(
      `ali@homebox may still run the server this device started setting up. Run ${CLI} sync server remove first, or continue to set up a new one.`,
    );
    expect(stopped.prompter.choices.get("Set up a new server?")!.map((c) => c.value)).toEqual(["no", "yes"]);
    expect(other.installs()).toEqual([]);
    expect(readInstallRecord()!.installId).toBe(oldId);

    const s = server();
    const nas = fakeHost({ detected: facts(), value: s.value });
    const replaced = await wizard(d, ["ssh", "ali@nas", "yes", "docker", "self", "192.168.1.30"], { hostFor: nas.hostFor });
    expect(replaced.code).toBe(0);
    expect(flag(nas.installs()[0]!.args, "--install-id")).not.toBe(oldId);
    expect(readInstallRecord()).toMatchObject({ host: "ali@nas", finished: true });

    // The manual route asks too.
    const e = device();
    await wizard(e, ["local", "docker", "self", "192.168.1.20"], { hostFor: broken.hostFor });
    const manual = await wizard(e, ["manual", "no"]);
    expect(manual.code).toBe(1);
    expect(manual.out).toContain("This machine may still run the server this device started setting up.");
  });

  /** A record of a server this device set up on ali@homebox. */
  const homebox = (o: Partial<InstallRecord> = {}): InstallRecord => ({
    installId: "first-install",
    route: "ssh",
    host: "ali@homebox",
    runtime: "docker",
    reach: "self",
    addresses: ["https://192.168.1.20:8787"],
    version: VERSION,
    started: true,
    finished: true,
    ...o,
  });

  test("finished record, sync off, rerun with Docker invisible reuses the ID", async () => {
    const d = device();
    writeInstallRecord(homebox());
    const s = server();
    // Docker needs a sudo password, which detect never asks for: it reports nothing installed.
    const host = fakeHost({ detected: facts(), value: s.value });
    const run = await wizard(d, ["ssh", "ali@homebox", ""], { hostFor: host.hostFor });
    expect(run.code).toBe(0);
    expect(run.out).toContain("Continuing with the server this device set up on ali@homebox.");
    expect(run.prompter.asked.slice(2)).toEqual(["Address your devices use"]);
    const args = host.installs()[0]!.args;
    expect(flag(args, "--install-id")).toBe("first-install");
    expect(flag(args, "--runtime")).toBe("docker");
    expect(readInstallRecord()).toMatchObject({ installId: "first-install", host: "ali@homebox", finished: true });

    // A finished domain install keeps its domain without asking how devices reach it.
    const e = device();
    writeInstallRecord(homebox({ reach: "domain", addresses: ["https://sync.example.com"] }));
    const again = fakeHost({ detected: facts(), value: s.value });
    const second = await wizard(e, ["ssh", "ali@homebox"], { hostFor: again.hostFor });
    expect(second.code).toBe(0);
    expect(flag(again.installs()[0]!.args, "--install-id")).toBe("first-install");
    expect(flags(again.installs()[0]!.args, "--url")).toEqual(["https://sync.example.com"]);
  });

  test("exit 3 keeps the earlier record", async () => {
    for (const earlier of [homebox(), homebox({ started: undefined, finished: false })]) {
      const d = device();
      writeInstallRecord(earlier);
      const nas = fakeHost({ detected: facts(), install: () => ({ code: 3, lines: [], value: null }) });
      const run = await wizard(d, ["ssh", "ali@nas", "yes", "docker", "self", "192.168.1.30"], { hostFor: nas.hostFor });
      expect(run.code).toBe(1);
      expect(run.out).toContain(`ali@nas already runs a Kerstel server. If another device syncs with it, run ${CLI} sync add-device there instead.`);
      expect(nas.installs()).toHaveLength(1);
      expect(readInstallRecord()).toEqual(earlier);
    }
  });

  test("exit 4 says Docker could not be checked, and keeps the earlier record", async () => {
    for (const earlier of [null, homebox()]) {
      const d = device();
      if (earlier) writeInstallRecord(earlier);
      const nas = fakeHost({ detected: facts(), install: () => ({ code: 4, lines: [], value: null }) });
      const answers = [...["ssh", "ali@nas"], ...(earlier ? ["yes"] : []), "docker", "self", "192.168.1.30"];
      const run = await wizard(d, answers, { hostFor: nas.hostFor });
      expect(run.code).toBe(1);
      expect(run.out).toContain(`Could not check Docker on ali@nas for a Kerstel server, so nothing was changed there.`);
      expect(run.out).not.toContain("The install stopped.");
      expect(nas.installs()).toHaveLength(1);
      expect(readInstallRecord()).toEqual(earlier);
    }
  });

  test("a record for another host is not replaced without a yes", async () => {
    const d = device();
    const earlier = homebox();
    writeInstallRecord(earlier);
    const nas = fakeHost({ detected: facts() });
    const run = await wizard(d, ["ssh", "ali@nas", "no"], { hostFor: nas.hostFor });
    expect(run.code).toBe(1);
    expect(run.out).toContain(
      `This device looks after the server on ali@homebox. A new server replaces that. Run ${CLI} sync server remove first, or continue to set up a new one.`,
    );
    expect(run.prompter.defaults.get("Set up a new server?")).toBe("no");
    expect(nas.installs()).toEqual([]);
    expect(readInstallRecord()).toEqual(earlier);

    // This machine, and a command run by hand, ask too.
    const local = await wizard(d, ["local", "no"], { hostFor: nas.hostFor });
    expect(local.code).toBe(1);
    expect(local.prompter.asked).toContain("Set up a new server?");
    const manual = await wizard(d, ["manual", "no"]);
    expect(manual.code).toBe(1);
    expect(manual.prompter.asked).toContain("Set up a new server?");
    expect(nas.installs()).toEqual([]);
    expect(readInstallRecord()).toEqual(earlier);
  });

  test("sync already on finishes a started setup whose addresses it syncs with", async () => {
    const s = server();
    const d = device();
    expect((await wizard(d, ["existing", s.value, "yes"])).code).toBe(0);
    writeInstallRecord(homebox({ addresses: [s.listener.url], finished: false }));
    expect((await wizard(d, [])).code).toBe(0);
    expect(readInstallRecord()!.finished).toBe(true);

    // Another server's addresses, or a setup that never got a value, stay unfinished.
    for (const r of [homebox({ finished: false }), homebox({ addresses: [s.listener.url], started: undefined, finished: false })]) {
      writeInstallRecord(r);
      expect((await wizard(d, [])).code).toBe(0);
      expect(readInstallRecord()).toEqual(r);
    }
  });

  test("an existing server at an https address is asked for its pin", async () => {
    const s = server();
    const d = device();
    const pin = formatPin(s.listener.pin);
    const run = await wizard(d, ["existing", s.listener.url, "sha256/nope", pin, TOKEN, "yes"]);
    expect(run.code).toBe(0);
    const question = "Certificate pin (leave empty if the server has a CA certificate)";
    expect(run.prompter.asked.filter((q) => q === question)).toHaveLength(2);
    expect(run.prompter.texts.get(question)!.secret).toBe(false);
    expect(run.out).toContain("That is not a certificate pin.");
    expect(run.out).toContain(`  Certificate  pinned (${pin})`);
    expect(syncedTo(d)!.pin).toEqual(s.listener.pin);
    expect(run.out.includes(TOKEN)).toBe(false);

    // An empty answer is no pin.
    const db = openDatabase(":memory:");
    const app = createApp({ db, version: "test", enrollToken: TOKEN });
    const fetch: Fetch = (request) => app.fetch(request, "127.0.0.1");
    const e = device();
    const plain = await wizard(e, ["existing", "https://sync.example.com", "", TOKEN, "yes"], { fetch });
    expect(plain.code).toBe(0);
    expect(syncedTo(e)!.pin).toBeNull();
    db.close();
  });

  test("a host with only private addresses that ssh reaches at a public one defaults to that name", async () => {
    const s = server();
    const host = fakeHost({ detected: facts({ ipv4: ["10.0.0.5"] }), value: s.value });
    const d = device();
    const looked: string[] = [];
    const resolveAll = async (name: string) => (name === "vps.example.com" || name === "sync.example.com" ? ["203.0.113.9"] : []);
    const run = await wizard(d, ["ssh", "vps", "docker", "self", ""], {
      hostFor: host.hostFor,
      sshHostname: async (target) => (looked.push(target), "vps.example.com"),
      resolveAll,
    });
    expect(run.code).toBe(0);
    expect(looked).toEqual(["vps"]);
    expect(run.prompter.texts.get("Address your devices use (found vps.example.com)")!.initial).toBe("vps.example.com");
    expect(flags(host.installs()[0]!.args, "--url")).toEqual(["https://vps.example.com:8787"]);
    expect(run.out).not.toContain("No name for this host resolves here");

    // A domain that points at the address ssh reaches counts as pointing at the host.
    const t = server();
    const domainHost = fakeHost({ detected: facts({ ipv4: ["10.0.0.5"] }), value: t.value });
    const e = device();
    const domain = await wizard(e, ["ssh", "vps", "docker", "domain", "sync.example.com"], {
      hostFor: domainHost.hostFor,
      sshHostname: async () => "vps.example.com",
      resolveAll,
    });
    expect(domain.code).toBe(0);
    expect(domain.out).not.toContain("does not point at");

    // On this machine, ssh is never asked.
    const f = device();
    const local = fakeHost({ detected: facts({ ipv4: ["10.0.0.5"] }), value: server().value });
    const here = await wizard(f, ["local", "docker", "self", ""], {
      hostFor: local.hostFor,
      sshHostname: async () => {
        throw new Error("no ssh for this machine");
      },
    });
    expect(here.code).toBe(0);
    expect(flags(local.installs()[0]!.args, "--url")).toEqual(["https://10.0.0.5:8787"]);
  });

  test("setup with no arguments on a terminal runs the wizard", async () => {
    const s = server();
    const d = device();
    const prompter = new ScriptedPrompter(["existing", s.value, "yes"]);
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
