import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../server/src/app";
import { openDatabase } from "../../server/src/db";
import { formatPin } from "../../server/src/pin";
import { syncCommand } from "../src/commands/sync";
import { hidingReport, syncServerCommand, type SyncServerDeps } from "../src/commands/sync-server";
import type { CliContext } from "../src/context";
import { ScriptedPrompter, type Choice } from "../src/init/prompts";
import type { Fetch } from "../src/sync/http";
import { readInstallRecord, writeInstallRecord, type InstallRecord } from "../src/sync/install-record";
import { manualCommand } from "../src/sync/installer";
import type { Host, InstallerRun } from "../src/sync/remote";
import { loadSync } from "../src/sync/state";
import type { SyncTimer } from "../src/sync/timer";
import { cliName } from "../src/ui/cli-name";
import { VERSION } from "../src/version";
import { generateDataKey } from "../src/vault/crypto";
import { openVault, type Vault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";
import { startTlsServer, type TlsServer } from "./helpers/tls-server";

/** Task 9: `ks sync server`. No real ssh, docker or sudo runs here. */

const CLI = cliName();
const SECRET = "db-secret-value-in-the-vault";
const MANAGE_LINE = `Managed from another device. To manage it from here: ${CLI} sync server manage <ssh-host>`;
/** What `isolateEnv` sets KERSTEL_RELEASES_URL to: the installer gets it as `--releases-url`. */
const RELEASES = "http://127.0.0.1:9";

const dirs: string[] = [];
const listeners: TlsServer[] = [];
afterEach(() => {
  restoreEnv();
  while (listeners.length > 0) listeners.pop()!.stop();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const fakeTimer: SyncTimer = {
  status: () => ({ state: "installed", kind: "launchd", current: true }),
  ensure: () => "unchanged",
  remove: () => true,
};

function device() {
  const home = isolateEnv({ prefix: "sync-server" });
  dirs.push(home);
  const file = join(home, "vault.db");
  const key = generateDataKey();
  const open = (): Vault => openVault(key, file);
  const d = {
    home,
    key,
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

/** `kerstel-server --tls self` on 127.0.0.1. */
function listener(o: Parameters<typeof startTlsServer>[0] = {}): TlsServer {
  const l = startTlsServer(o);
  listeners.push(l);
  return l;
}

/** Prints nothing from `work`, and returns what it printed on stdout and stderr. */
async function captured<T>(work: () => Promise<T>): Promise<{ result: T; out: string }> {
  const printed: string[] = [];
  const realLog = console.log;
  const realErr = process.stderr.write;
  console.log = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
  process.stderr.write = ((chunk: string | Uint8Array) => {
    printed.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await work(), out: printed.join("\n") };
  } finally {
    console.log = realLog;
    process.stderr.write = realErr;
  }
}

/** Turns sync on for `d` against a pinned listener. */
async function pinnedSync(d: Device, l: TlsServer): Promise<void> {
  const { result } = await captured(() =>
    syncCommand(["setup", l.url, "--pin", formatPin(l.pin), "--yes"], { context: d.context, interactive: false, timer: fakeTimer, deviceName: "laptop" }),
  );
  expect(result).toBe(0);
}

/** An unpinned server in-process, reached at any http:// address through `fetch`. */
function plainServer() {
  const db = openDatabase(":memory:");
  const app = createApp({ db, version: "test" });
  const fetch: Fetch = (request) => app.fetch(request, "127.0.0.1");
  return { fetch };
}

async function plainSync(d: Device, fetch: Fetch, url = "http://127.0.0.1:8787"): Promise<void> {
  const { result } = await captured(() =>
    syncCommand(["setup", url, "--yes"], { context: d.context, interactive: false, timer: fakeTimer, deviceName: "laptop", fetch }),
  );
  expect(result).toBe(0);
}

const record = (o: Partial<InstallRecord> = {}): InstallRecord => ({
  installId: "install-id-1",
  route: "ssh",
  host: "ali@homebox",
  runtime: "docker",
  reach: "self",
  addresses: ["https://192.168.1.20:8787"],
  version: "0.0.1",
  finished: true,
  ...o,
});

interface Call {
  route: "ssh" | "local";
  target: string | null;
  args: string[];
  interactive: boolean;
}

/** A host whose installer answers each command from a script; an unscripted command exits 1. */
function fakeHost(answers: Partial<Record<string, InstallerRun>> = {}) {
  const calls: Call[] = [];
  const hostFor = (route: "ssh" | "local", target: string | null): Host => ({
    label: route === "ssh" ? target! : "this machine",
    async run(args, opts = {}) {
      calls.push({ route, target, args, interactive: opts.interactive === true });
      return answers[args[0]!] ?? { code: 1, lines: [], value: null };
    },
  });
  return { calls, hostFor };
}

const done: InstallerRun = { code: 0, lines: [], value: null };

/** A ScriptedPrompter that also keeps each select's default. */
class Recorder extends ScriptedPrompter {
  readonly defaults = new Map<string, string>();
  override async select<T extends string>(question: string, choices: Choice<T>[], d: T): Promise<T> {
    this.defaults.set(question, d);
    return super.select(question, choices, d);
  }
}

async function server(d: Device, args: string[], deps: Partial<SyncServerDeps> & { answers?: string[] } = {}) {
  const prompter = new Recorder(deps.answers ?? []);
  const { result, out } = await captured(() =>
    syncServerCommand(args, {
      context: d.context,
      prompter,
      interactive: true,
      timer: fakeTimer,
      hostFor: () => {
        throw new Error("this test runs no host");
      },
      ...deps,
    }),
  );
  return { code: result, out, prompter };
}

/** What `kerstel-server.sh info` prints for a running Docker server. */
function infoLines(o: { pin?: string | null; ipv4?: string[]; hostname?: string; tailscale?: string; installId?: string; version?: string } = {}): string[] {
  const lines = [
    "os=linux",
    "arch=arm64",
    "docker=yes",
    "systemd=yes",
    `tailscale=${o.tailscale ?? "no"}`,
    `hostname=${o.hostname ?? "homebox"}`,
    ...(o.ipv4 ?? ["192.168.1.20"]).map((ip) => `ipv4=${ip}`),
    "installed=docker",
    `install-id=${o.installId ?? "found-install-id"}`,
    `version=${o.version ?? "0.4.0"}`,
  ];
  if (o.pin !== null && o.pin !== undefined) lines.push(`pin=${o.pin}`);
  lines.push("running=yes");
  return lines;
}

describe("ks sync server", () => {
  test("shows the server's address, whether it answers, its version, and how it was installed", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    writeInstallRecord(record({ addresses: [l.url] }));
    const { code, out } = await server(d, []);
    expect(code).toBe(0);
    expect(out).toContain(`Server     ${l.url}`);
    expect(out).toContain("Answers    yes");
    expect(out).toContain("Version    test");
    expect(out).toContain("Installed  ssh, docker, self, on ali@homebox");
    expect(out).not.toContain("Managed from another device");
    // Through the pinned client: the certificate first, then health.
    expect(l.paths).toContain("/v1/health");
    expect(out).not.toContain(SECRET);
  });

  test("a device that did not set the server up says it is managed from another device", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    const { code, out } = await server(d, []);
    expect(code).toBe(0);
    expect(out).toContain("Answers    yes");
    expect(out).toContain(MANAGE_LINE);
    expect(out).not.toContain("Installed");
  });

  test("a server that does not answer is shown as not answering", async () => {
    const d = device();
    const l = startTlsServer();
    await pinnedSync(d, l);
    l.stop();
    const { code, out } = await server(d, []);
    expect(code).toBe(0);
    expect(out).toContain("Answers    no");
    expect(out).not.toContain("Version ");
  });

  test("a health check passed in replaces the client's", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    const asked: string[] = [];
    const { out } = await server(d, [], {
      health: async (url) => {
        asked.push(url);
        return { version: "9.9.9" };
      },
    });
    expect(asked).toEqual([l.url]);
    expect(out).toContain("Version    9.9.9");
  });

  test("the usage lists all six commands, and an unknown one is refused", async () => {
    const d = device();
    const { result, out } = await captured(() => syncCommand(["help"], { context: d.context }));
    expect(result).toBe(0);
    for (const line of [
      `${CLI} sync server `,
      `${CLI} sync server update`,
      `${CLI} sync server address <url>`,
      `${CLI} sync server manage <ssh-host>`,
      `${CLI} sync server stop`,
      `${CLI} sync server remove`,
    ]) {
      expect(out).toContain(line);
    }
    const bad = await captured(() => syncCommand(["server", "restart"], { context: d.context }));
    expect(bad.result).toBe(2);
    expect(bad.out).toContain(`${CLI} sync server manage <ssh-host>`);
  });
});

describe("ks sync server update", () => {
  test("runs the installer's update over the recorded route and records the version", async () => {
    const d = device();
    writeInstallRecord(record());
    const host = fakeHost({ update: done });
    const { code, out } = await server(d, ["update"], { hostFor: host.hostFor });
    expect(code).toBe(0);
    expect(host.calls).toEqual([
      { route: "ssh", target: "ali@homebox", args: ["update", "--version", VERSION, "--releases-url", RELEASES], interactive: true },
    ]);
    expect(readInstallRecord()!.version).toBe(VERSION);
    expect(out).toContain(`Updated the server on ali@homebox to ${VERSION}.`);
  });

  test("a failed update keeps the recorded version", async () => {
    const d = device();
    writeInstallRecord(record());
    const host = fakeHost({ update: { code: 1, lines: [], value: null } });
    const { code, out } = await server(d, ["update"], { hostFor: host.hostFor });
    expect(code).toBe(1);
    expect(readInstallRecord()!.version).toBe("0.0.1");
    expect(out).toContain(`${CLI} sync server update`);
  });

  test("refuses without a record", async () => {
    const d = device();
    const host = fakeHost({ update: done });
    const { code, out } = await server(d, ["update"], { hostFor: host.hostFor });
    expect(code).toBe(1);
    expect(host.calls).toEqual([]);
    expect(out).toContain(MANAGE_LINE);
  });
});

describe("ks sync server stop", () => {
  test("runs stop over the recorded route and keeps the record", async () => {
    const d = device();
    writeInstallRecord(record({ route: "local", host: null }));
    const host = fakeHost({ stop: done });
    const { code, out } = await server(d, ["stop"], { hostFor: host.hostFor });
    expect(code).toBe(0);
    expect(host.calls).toEqual([{ route: "local", target: null, args: ["stop"], interactive: true }]);
    expect(readInstallRecord()).not.toBeNull();
    expect(out).toContain("Stopped the server on this machine.");
    expect(out).toContain(`${CLI} sync server update`);
  });

  test("refuses without a record", async () => {
    const d = device();
    const { code, out } = await server(d, ["stop"]);
    expect(code).toBe(1);
    expect(out).toContain(MANAGE_LINE);
  });
});

describe("ks sync server remove", () => {
  test("asks twice, runs remove, and deletes the record", async () => {
    const d = device();
    writeInstallRecord(record());
    const host = fakeHost({ remove: done });
    const { code, out, prompter } = await server(d, ["remove"], { hostFor: host.hostFor, answers: ["yes", "delete"] });
    expect(code).toBe(0);
    expect(prompter.asked).toEqual([
      "Remove the server from ali@homebox?",
      "Also delete its database? Every device keeps its secrets, but syncing stops.",
    ]);
    expect(host.calls).toEqual([{ route: "ssh", target: "ali@homebox", args: ["remove", "--delete-data"], interactive: true }]);
    expect(readInstallRecord()).toBeNull();
    expect(out).toContain("Removed the server from ali@homebox.");
  });

  test("remove keeps the database by default", async () => {
    const d = device();
    writeInstallRecord(record());
    const host = fakeHost({ remove: done });
    const { code, prompter } = await server(d, ["remove"], { hostFor: host.hostFor, answers: ["yes", "keep"] });
    expect(code).toBe(0);
    expect(prompter.defaults.get("Remove the server from ali@homebox?")).toBe("no");
    expect(prompter.defaults.get("Also delete its database? Every device keeps its secrets, but syncing stops.")).toBe("keep");
    expect(host.calls.map((c) => c.args)).toEqual([["remove"]]);
    expect(readInstallRecord()).toBeNull();
  });

  test("No changes nothing", async () => {
    const d = device();
    writeInstallRecord(record());
    const host = fakeHost({ remove: done });
    const { code, prompter } = await server(d, ["remove"], { hostFor: host.hostFor, answers: ["no"] });
    expect(code).toBe(0);
    expect(prompter.asked).toEqual(["Remove the server from ali@homebox?"]);
    expect(host.calls).toEqual([]);
    expect(readInstallRecord()).not.toBeNull();
  });

  test("a failed remove keeps the record", async () => {
    const d = device();
    writeInstallRecord(record());
    const host = fakeHost({ remove: { code: 1, lines: [], value: null } });
    const { code, out } = await server(d, ["remove"], { hostFor: host.hostFor, answers: ["yes", "keep"] });
    expect(code).toBe(1);
    expect(readInstallRecord()).not.toBeNull();
    expect(out).toContain(`${CLI} sync server remove`);
  });

  test("without a terminal it fails with a usage line and changes nothing", async () => {
    const d = device();
    writeInstallRecord(record());
    const host = fakeHost({ remove: done });
    const { code, out } = await server(d, ["remove"], { hostFor: host.hostFor, interactive: false });
    expect(code).toBe(2);
    expect(out).toContain(`${CLI} sync server remove`);
    expect(host.calls).toEqual([]);
    expect(readInstallRecord()).not.toBeNull();
  });
});

describe("a server installed by hand", () => {
  test("manual installs print the line to run", async () => {
    const d = device();
    writeInstallRecord(record({ route: "manual", host: null }));

    const update = await server(d, ["update"]);
    expect(update.code).toBe(0);
    expect(update.out).toContain(manualCommand({ version: VERSION, args: ["update", "--version", VERSION, "--releases-url", RELEASES] }));
    expect(update.out).toContain("Run this on the server");
    // Nothing says it ran.
    expect(readInstallRecord()!.version).toBe("0.0.1");

    const stop = await server(d, ["stop"]);
    expect(stop.code).toBe(0);
    expect(stop.out).toContain(manualCommand({ version: VERSION, args: ["stop"] }));

    // The record stays until the person says the command ran.
    const notYet = await server(d, ["remove"], { answers: ["yes", "keep", "no"] });
    expect(notYet.code).toBe(0);
    expect(notYet.prompter.asked).toEqual([
      "Remove the server?",
      "Also delete its database? Every device keeps its secrets, but syncing stops.",
      "Did the command finish on the server?",
    ]);
    expect(notYet.prompter.defaults.get("Did the command finish on the server?")).toBe("no");
    expect(notYet.out).toContain(manualCommand({ version: VERSION, args: ["remove"] }));
    expect(readInstallRecord()).not.toBeNull();

    const ran = await server(d, ["remove"], { answers: ["yes", "delete", "yes"] });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain(manualCommand({ version: VERSION, args: ["remove", "--delete-data"] }));
    expect(readInstallRecord()).toBeNull();
  });
});

describe("ks sync server address", () => {
  test("saves a new address first when the server there answers with the pinned key and knows this device", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    writeInstallRecord(record({ addresses: [l.url] }));
    const moved = `https://localhost:${l.port}`;
    const { code, out } = await server(d, ["address", moved]);
    expect(code).toBe(0);
    const config = d.with((v) => loadSync(v, d.key))!;
    expect(config.servers).toEqual([moved, l.url]);
    expect(config.pin!.equals(l.pin)).toBe(true);
    expect(readInstallRecord()!.addresses).toEqual([moved, l.url]);
    expect(out).toContain(`${CLI} sync server address ${moved}`);

    // Again with the same address: no duplicate.
    expect((await server(d, ["address", `${moved}/`])).code).toBe(0);
    expect(d.with((v) => loadSync(v, d.key))!.servers).toEqual([moved, l.url]);
  });

  test("address refuses a server that doesn't know this vault", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    // The same key, so the pin matches, but another database.
    const other = listener({ key: l.key });
    const { code, out } = await server(d, ["address", other.url]);
    expect(code).toBe(1);
    expect(out).toContain("does not know this vault");
    expect(out).toContain("Nothing was changed.");
    expect(d.with((v) => loadSync(v, d.key))!.servers).toEqual([l.url]);
  });

  test("address refuses a server with another key", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    const other = listener();
    const { code, out } = await server(d, ["address", other.url]);
    expect(code).toBe(1);
    expect(out).toContain("Nothing was changed.");
    expect(d.with((v) => loadSync(v, d.key))!.servers).toEqual([l.url]);
    // The key was refused before anything signed was sent.
    expect(other.paths).toEqual(["/v1/certificate"]);
  });

  test("address checks the URL as setup does", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    expect((await server(d, ["address", "ftp://example.com"])).code).toBe(2);
    expect((await server(d, ["address", "http://example.com"])).code).toBe(2);
    // A pin needs https, even to this machine.
    const plain = await server(d, ["address", "http://127.0.0.1:8787"]);
    expect(plain.code).toBe(2);
    expect(plain.out).toContain("https://");
    expect((await server(d, ["address"])).code).toBe(2);
    expect(d.with((v) => loadSync(v, d.key))!.servers).toEqual([l.url]);
  });

  test("without a pin, the server must still answer for this vault", async () => {
    const d = device();
    const s = plainServer();
    await plainSync(d, s.fetch);
    const elsewhere = plainServer();
    const refused = await server(d, ["address", "http://localhost:8787"], { fetch: elsewhere.fetch });
    expect(refused.code).toBe(1);
    expect(d.with((v) => loadSync(v, d.key))!.servers).toEqual(["http://127.0.0.1:8787"]);

    const moved = await server(d, ["address", "http://localhost:8787"], { fetch: s.fetch });
    expect(moved.code).toBe(0);
    expect(d.with((v) => loadSync(v, d.key))!.servers).toEqual(["http://localhost:8787", "http://127.0.0.1:8787"]);
  });

  test("refuses when sync is off", async () => {
    const d = device();
    const { code } = await server(d, ["address", "https://example.com"]);
    expect(code).toBe(1);
  });
});

describe("ks sync server manage", () => {
  test("takes over a server whose pin matches and saves a finished record", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    const host = fakeHost({ info: { code: 0, lines: infoLines({ pin: formatPin(l.pin) }), value: null } });
    const { code, out } = await server(d, ["manage", "ali@homebox"], { hostFor: host.hostFor });
    expect(code).toBe(0);
    expect(host.calls).toEqual([{ route: "ssh", target: "ali@homebox", args: ["info"], interactive: true }]);
    expect(readInstallRecord()).toEqual({
      installId: "found-install-id",
      route: "ssh",
      host: "ali@homebox",
      runtime: "docker",
      reach: "self",
      addresses: [l.url],
      version: "0.4.0",
      finished: true,
    });
    expect(out).toContain("This device now manages the server on ali@homebox.");
    // `info`'s key=value lines are read, not shown.
    expect(out).not.toContain("ipv4=");
  });

  test("manage refuses a host whose pin doesn't match", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    const other = startTlsServer();
    const otherPin = formatPin(other.pin);
    other.stop();
    const host = fakeHost({ info: { code: 0, lines: infoLines({ pin: otherPin }), value: null } });
    const { code, out } = await server(d, ["manage", "ali@homebox"], { hostFor: host.hostFor });
    expect(code).toBe(1);
    expect(out).toContain("not the one this vault syncs with");
    expect(readInstallRecord()).toBeNull();
  });

  test("a pinned vault refuses a host that shows no pin", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    const host = fakeHost({ info: { code: 0, lines: infoLines({ pin: null }), value: null } });
    expect((await server(d, ["manage", "ali@homebox"], { hostFor: host.hostFor })).code).toBe(1);
    expect(readInstallRecord()).toBeNull();
  });

  test("an unpinned server matches on one of this vault's addresses", async () => {
    const d = device();
    const s = plainServer();
    await plainSync(d, s.fetch, "http://localhost:8787");

    const elsewhere = fakeHost({ info: { code: 0, lines: infoLines({ ipv4: ["10.0.0.9"], hostname: "otherbox" }), value: null } });
    const refused = await server(d, ["manage", "ali@otherbox"], { hostFor: elsewhere.hostFor, fetch: s.fetch, resolveAll: async () => [] });
    expect(refused.code).toBe(1);
    expect(readInstallRecord()).toBeNull();

    // localhost resolves to the host's address, as a domain does.
    const host = fakeHost({ info: { code: 0, lines: infoLines({ ipv4: ["10.0.0.5"] }), value: null } });
    const taken = await server(d, ["manage", "ali@homebox"], {
      hostFor: host.hostFor,
      fetch: s.fetch,
      resolveAll: async (name) => (name === "localhost" ? ["10.0.0.5"] : []),
    });
    expect(taken.code).toBe(0);
    expect(readInstallRecord()).toMatchObject({ route: "ssh", host: "ali@homebox", reach: "domain", addresses: ["http://localhost:8787"], finished: true });
  });

  test("an unpinned server whose address matches still has to know this vault", async () => {
    const d = device();
    const s = plainServer();
    await plainSync(d, s.fetch);
    const host = fakeHost({ info: { code: 0, lines: infoLines({ ipv4: ["127.0.0.1"] }), value: null } });
    const { code, out } = await server(d, ["manage", "ali@homebox"], { hostFor: host.hostFor, fetch: plainServer().fetch, resolveAll: async () => [] });
    expect(code).toBe(1);
    expect(out).toContain("does not know this vault");
    expect(readInstallRecord()).toBeNull();
  });

  test("a host with no server is refused", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    const lines = infoLines({ pin: formatPin(l.pin) }).filter((x) => !/^(installed|install-id|version|pin|running)=/.test(x));
    const host = fakeHost({ info: { code: 1, lines: [...lines, "installed=no"], value: null } });
    const { code, out } = await server(d, ["manage", "ali@homebox"], { hostFor: host.hostFor });
    expect(code).toBe(1);
    expect(out).toContain("No Kerstel server is installed on ali@homebox");
    expect(readInstallRecord()).toBeNull();
  });

  test("info's report lines are hidden, and a sudo prompt shows at once", () => {
    const shown: string[] = [];
    const write = hidingReport((text) => void shown.push(text));
    write("kerstel-server.sh: Checking for a Kerstel server in Docker needs sudo.\r\n[sudo] password for ali: ");
    expect(shown.join("")).toBe("kerstel-server.sh: Checking for a Kerstel server in Docker needs sudo.\r\n[sudo] password for ali: ");
    write("\r\nos=lin");
    write("ux\r\nipv4=192.168.1.20\npin=sha256/abc\nrunning=yes\n");
    write("password");
    write(" for ali: ");
    expect(shown.join("")).toBe(
      "kerstel-server.sh: Checking for a Kerstel server in Docker needs sudo.\r\n[sudo] password for ali: \r\npassword for ali: ",
    );
  });

  test("manage needs an SSH host", async () => {
    const d = device();
    expect((await server(d, ["manage"])).code).toBe(2);
    expect((await server(d, ["manage", "-oProxyCommand=x"])).code).toBe(2);
  });
});
