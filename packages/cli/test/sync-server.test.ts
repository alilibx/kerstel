import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../server/src/app";
import { openDatabase } from "../../server/src/db";
import { formatPin } from "../../server/src/pin";
import { syncCommand } from "../src/commands/sync";
import { hidingReport, serverBehind, serverVersion, syncServerCommand, type SyncServerDeps } from "../src/commands/sync-server";
import type { CliContext } from "../src/context";
import { ScriptedPrompter, type Choice } from "../src/init/prompts";
import type { Fetch } from "../src/sync/http";
import { readInstallRecord, removeInstallRecord, writeInstallRecord, type InstallRecord } from "../src/sync/install-record";
import { manualCommand } from "../src/sync/installer";
import type { Host, InstallerRun } from "../src/sync/remote";
import { loadSync, saveSync } from "../src/sync/state";
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

  test("a server that never answers is given the same 3 seconds as kerstel update", async () => {
    const d = device();
    const s = plainServer();
    await plainSync(d, s.fetch);
    writeInstallRecord(record({ addresses: ["http://127.0.0.1:8787"] }));
    const hanging: Fetch = (request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const started = Date.now();
    const { code, out } = await server(d, [], { fetch: hanging });
    const took = Date.now() - started;
    expect(code).toBe(0);
    expect(out).toContain("Answers    no");
    expect(took).toBeGreaterThanOrEqual(2_900);
    expect(took).toBeLessThan(6_000);
  }, 10_000);

  test("a version with control characters is printed without them", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    const shown = await server(d, [], { health: async () => ({ version: "0.4.0\u001b[2J\u0007\u202e" }) });
    expect(shown.out.split("\n").find((line) => line.startsWith("Version"))).toBe("Version    0.4.0[2J");

    const host = fakeHost({ info: { code: 0, lines: infoLines({ pin: formatPin(l.pin), version: "0.4.0\u001b]0;owned\u0007" }), value: null } });
    const managed = await server(d, ["manage", "ali@homebox"], { hostFor: host.hostFor });
    expect(managed.out).toContain("Found kerstel-server 0.4.0]0;owned on ali@homebox");
    expect(readInstallRecord()!.version).toBe("0.4.0]0;owned");
    expect(await serverVersion(d.with((v) => loadSync(v, d.key))!, { health: async () => ({ version: "1.0.0\u001b[31m" }) })).toBe("1.0.0[31m");
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
      { route: "ssh", target: "ali@homebox", args: ["update", "--version", VERSION, "--install-id", "install-id-1", "--releases-url", RELEASES], interactive: true },
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
    expect(host.calls).toEqual([{ route: "local", target: null, args: ["stop", "--install-id", "install-id-1"], interactive: true }]);
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
    expect(host.calls).toEqual([{ route: "ssh", target: "ali@homebox", args: ["remove", "--delete-data", "--install-id", "install-id-1"], interactive: true }]);
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
    expect(host.calls.map((c) => c.args)).toEqual([["remove", "--install-id", "install-id-1"]]);
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

describe("another device's server on the recorded host", () => {
  test("update, stop and remove say so when the installer finds another install ID, and change nothing", async () => {
    const d = device();
    writeInstallRecord(record());
    const other: InstallerRun = { code: 3, lines: [], value: null };
    const host = fakeHost({ update: other, stop: other, remove: other });
    const NOT_OURS = "ali@homebox runs a Kerstel server that another device set up, not the one this device did. Nothing was changed there.";
    for (const [args, answers] of [[["update"], []], [["stop"], []], [["remove"], ["yes", "keep"]]] as const) {
      const run = await server(d, [...args], { hostFor: host.hostFor, answers: [...answers] });
      expect({ args, code: run.code }).toEqual({ args, code: 1 });
      expect(run.out).toContain(NOT_OURS);
      expect(readInstallRecord()).toEqual(record());
    }
    expect(host.calls.every((c) => c.args.includes("--install-id") && c.args[c.args.indexOf("--install-id") + 1] === "install-id-1")).toBe(true);
  });
});

describe("Docker that could not be checked on the recorded host", () => {
  test("update, stop and remove say so, change nothing, and keep the record", async () => {
    const d = device();
    writeInstallRecord(record());
    const unchecked: InstallerRun = { code: 4, lines: [], value: null };
    const host = fakeHost({ update: unchecked, stop: unchecked, remove: unchecked });
    for (const [args, answers] of [[["update"], []], [["stop"], []], [["remove"], ["yes", "keep"]]] as const) {
      const run = await server(d, [...args], { hostFor: host.hostFor, answers: [...answers] });
      expect({ args, code: run.code }).toEqual({ args, code: 1 });
      expect(run.out).toContain(
        `Could not check Docker on ali@homebox for a Kerstel server, so nothing was changed there. Check that Docker runs there and that sudo works, then run ${CLI} sync server ${args[0]} again.`,
      );
      expect(run.out).not.toContain("Removed the server");
      expect(readInstallRecord()).toEqual(record());
    }
  });
});

describe("a server installed by hand", () => {
  test("manual installs print the line to run", async () => {
    const d = device();
    writeInstallRecord(record({ route: "manual", host: null }));

    const update = await server(d, ["update"]);
    expect(update.code).toBe(0);
    expect(update.out).toContain(
      manualCommand({ version: VERSION, args: ["update", "--version", VERSION, "--install-id", "install-id-1", "--releases-url", RELEASES] }),
    );
    expect(update.out).toContain("Run this on the server");
    // Nothing says it ran.
    expect(readInstallRecord()!.version).toBe("0.0.1");

    const stop = await server(d, ["stop"]);
    expect(stop.code).toBe(0);
    expect(stop.out).toContain(manualCommand({ version: VERSION, args: ["stop", "--install-id", "install-id-1"] }));

    // The record stays until the person says the command ran.
    const notYet = await server(d, ["remove"], { answers: ["yes", "keep", "no"] });
    expect(notYet.code).toBe(0);
    expect(notYet.prompter.asked).toEqual([
      "Remove the server?",
      "Also delete its database? Every device keeps its secrets, but syncing stops.",
      "Did the command finish on the server?",
    ]);
    expect(notYet.prompter.defaults.get("Did the command finish on the server?")).toBe("no");
    expect(notYet.out).toContain(manualCommand({ version: VERSION, args: ["remove", "--install-id", "install-id-1"] }));
    expect(readInstallRecord()).not.toBeNull();

    const ran = await server(d, ["remove"], { answers: ["yes", "delete", "yes"] });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain(manualCommand({ version: VERSION, args: ["remove", "--delete-data", "--install-id", "install-id-1"] }));
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
    await plainSync(d, s.fetch, "https://sync.example.com");

    const elsewhere = fakeHost({ info: { code: 0, lines: infoLines({ ipv4: ["10.0.0.9"], hostname: "otherbox" }), value: null } });
    const refused = await server(d, ["manage", "ali@otherbox"], { hostFor: elsewhere.hostFor, fetch: s.fetch, resolveAll: async () => [] });
    expect(refused.code).toBe(1);
    expect(readInstallRecord()).toBeNull();

    // The domain resolves to the host's address.
    const host = fakeHost({ info: { code: 0, lines: infoLines({ ipv4: ["10.0.0.5"] }), value: null } });
    const taken = await server(d, ["manage", "ali@homebox"], {
      hostFor: host.hostFor,
      fetch: s.fetch,
      resolveAll: async (name) => (name === "sync.example.com" ? ["10.0.0.5"] : []),
    });
    expect(taken.code).toBe(0);
    expect(readInstallRecord()).toMatchObject({ route: "ssh", host: "ali@homebox", reach: "domain", addresses: ["https://sync.example.com"], finished: true });
  });

  test("an unpinned server whose address matches still has to know this vault", async () => {
    const d = device();
    const s = plainServer();
    await plainSync(d, s.fetch, "https://sync.example.com");
    const host = fakeHost({ info: { code: 0, lines: infoLines({ ipv4: ["10.0.0.5"] }), value: null } });
    const { code, out } = await server(d, ["manage", "ali@homebox"], {
      hostFor: host.hostFor,
      fetch: plainServer().fetch,
      resolveAll: async () => ["10.0.0.5"],
    });
    expect(code).toBe(1);
    expect(out).toContain("does not know this vault");
    expect(readInstallRecord()).toBeNull();
  });

  test("a loopback address never points at a remote host, whatever it calls itself or resolves to", async () => {
    for (const url of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787", "https://127.0.0.2:8787", "https://sync.localhost:8787"]) {
      const d = device();
      const s = plainServer();
      await plainSync(d, s.fetch, url);
      const host = fakeHost({
        info: { code: 0, lines: infoLines({ ipv4: ["10.0.0.5", "127.0.0.1", "127.0.0.2"], hostname: "localhost" }), value: null },
      });
      const { code, out } = await server(d, ["manage", "ali@homebox"], {
        hostFor: host.hostFor,
        fetch: s.fetch,
        resolveAll: async () => ["10.0.0.5", "127.0.0.1"],
      });
      expect({ url, code }).toEqual({ url, code: 1 });
      expect(out).toContain("points at ali@homebox");
      expect(readInstallRecord()).toBeNull();
    }
  });

  test("a record of another host's server is replaced only on a yes, and an unfinished one never", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    const nas = fakeHost({ info: { code: 0, lines: infoLines({ pin: formatPin(l.pin) }), value: null } });

    // Unfinished: finish or remove it first. Nothing runs.
    const unfinished = record({ host: "ali@nas", finished: false });
    writeInstallRecord(unfinished);
    const refused = await server(d, ["manage", "ali@homebox"], { hostFor: nas.hostFor });
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(
      `This device is still setting up a server on ali@nas. Finish it with ${CLI} sync setup, or run ${CLI} sync server remove, then run this again. Nothing was saved.`,
    );
    expect(refused.prompter.asked).toEqual([]);
    expect(nas.calls).toEqual([]);
    expect(readInstallRecord()).toEqual(unfinished);

    // Finished: asked, No by default.
    const finished = record({ host: "ali@nas" });
    writeInstallRecord(finished);
    const no = await server(d, ["manage", "ali@homebox"], { hostFor: nas.hostFor, answers: ["no"] });
    expect(no.code).toBe(0);
    expect(no.out).toContain("This device manages the server on ali@nas. Managing the one on ali@homebox replaces that.");
    expect(no.prompter.defaults.get("Manage the server on ali@homebox instead?")).toBe("no");
    expect(nas.calls).toEqual([]);
    expect(readInstallRecord()).toEqual(finished);

    // Without a terminal it can't ask.
    const piped = await server(d, ["manage", "ali@homebox"], { hostFor: nas.hostFor, interactive: false });
    expect(piped.code).toBe(2);
    expect(readInstallRecord()).toEqual(finished);

    const yes = await server(d, ["manage", "ali@homebox"], { hostFor: nas.hostFor, answers: ["yes"] });
    expect(yes.code).toBe(0);
    expect(readInstallRecord()).toMatchObject({ host: "ali@homebox", installId: "found-install-id", finished: true });

    // The same host asks nothing.
    const same = await server(d, ["manage", "ali@homebox"], { hostFor: nas.hostFor });
    expect(same.code).toBe(0);
    expect(same.prompter.asked).toEqual([]);
  });

  test("a server with no install ID was started by hand, and is not taken over", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    const lines = infoLines({ pin: formatPin(l.pin) }).filter((x) => !x.startsWith("install-id="));
    const host = fakeHost({ info: { code: 0, lines, value: null } });
    const { code, out } = await server(d, ["manage", "ali@homebox"], { hostFor: host.hostFor });
    expect(code).toBe(1);
    expect(out).toContain(`The Kerstel server on ali@homebox has no install ID: it was started by hand, so ${CLI} can't look after it. Nothing was saved.`);
    expect(readInstallRecord()).toBeNull();

    // Exit 3: another user's, or started by hand under another name.
    const theirs = fakeHost({ info: { code: 3, lines: [], value: null } });
    const other = await server(d, ["manage", "ali@homebox"], { hostFor: theirs.hostFor });
    expect(other.code).toBe(1);
    expect(other.out).toContain("was set up by another user there, or started by hand, so it can't be managed as this user. Nothing was saved.");
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

  test("a host whose Docker could not be checked is not called empty", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    const lines = infoLines({ pin: formatPin(l.pin) }).filter((x) => !/^(installed|install-id|version|pin|running)=/.test(x));
    const host = fakeHost({ info: { code: 4, lines: [...lines, "installed=unknown"], value: null } });
    const { code, out } = await server(d, ["manage", "ali@homebox"], { hostFor: host.hostFor });
    expect(code).toBe(1);
    expect(out).toContain(
      "Couldn't check Docker on ali@homebox for a Kerstel server. Check that Docker runs there and that sudo works, then run this again. Nothing was saved.",
    );
    expect(out).not.toContain("No Kerstel server is installed");
    expect(readInstallRecord()).toBeNull();
  });

  test("a server that answers without this device names the address that answered", async () => {
    const d = device();
    const s = plainServer();
    await plainSync(d, s.fetch, "https://sync.example.com");
    d.with((v) => saveSync(v, d.key, { ...loadSync(v, d.key)!, servers: ["https://sync.example.com", "https://sync2.example.com"] }));
    const host = fakeHost({ info: { code: 0, lines: infoLines({ ipv4: ["10.0.0.5"] }), value: null } });
    // The first address can't be reached; the second answers, but does not list this device.
    const fetch: Fetch = async (request) => {
      if (new URL(request.url).hostname === "sync.example.com") throw new Error("connection refused");
      return Response.json({ devices: [] });
    };
    const { code, out } = await server(d, ["manage", "ali@homebox"], { hostFor: host.hostFor, fetch, resolveAll: async () => ["10.0.0.5"] });
    expect(code).toBe(1);
    expect(out).toContain("https://sync2.example.com answered, but it does not know this vault. Nothing was saved.");
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

describe("the server's version, for kerstel update and doctor", () => {
  const answers = (version: string | null) => async () => (version === null ? null : { version });

  test("serverBehind names an older server, and nothing for a current or silent one", async () => {
    const d = device();
    await plainSync(d, plainServer().fetch);
    writeInstallRecord(record(), d.home);
    const behind = (cli: string, version: string | null) => serverBehind(cli, { context: d.context, health: answers(version) });
    expect(await behind("0.4.0", "0.3.0")).toEqual({ place: "ali@homebox", version: "0.3.0" });
    expect(await behind("0.4.0", "0.4.0")).toBeNull();
    expect(await behind("0.4.0-dev", "0.4.0")).toBeNull();
    expect(await behind("0.4.0", null)).toBeNull();
  });

  test("a server on this machine, or installed by hand, is named by where it runs", async () => {
    const d = device();
    await plainSync(d, plainServer().fetch);
    writeInstallRecord(record({ route: "local", host: null }), d.home);
    expect(await serverBehind("0.4.0", { context: d.context, health: answers("0.3.0") })).toEqual({ place: "this machine", version: "0.3.0" });
    writeInstallRecord(record({ route: "manual", host: null }), d.home);
    expect(await serverBehind("0.4.0", { context: d.context, health: answers("0.3.0") })).toEqual({ place: "192.168.1.20", version: "0.3.0" });
  });

  test("with no record, or sync off, it opens no vault and asks no server", async () => {
    const d = device();
    let asked = 0;
    const deps: SyncServerDeps = {
      context: async () => {
        asked += 1;
        return d.context();
      },
      health: async () => {
        asked += 1;
        return { version: "0.0.1" };
      },
    };
    writeInstallRecord(record(), d.home);
    expect(await serverBehind("0.4.0", deps)).toBeNull();
    removeInstallRecord(d.home);
    await plainSync(d, plainServer().fetch);
    expect(await serverBehind("0.4.0", deps)).toBeNull();
    expect(asked).toBe(0);
  });

  test("a server that never answers counts as silent, within the time allowed", async () => {
    const d = device();
    await plainSync(d, plainServer().fetch);
    const config = d.with((v) => loadSync(v, d.key))!;
    const aborted: string[] = [];
    // Answers only when the request is aborted: the deadline must reach the fetch.
    const hanging: Fetch = (request) =>
      new Promise((_, reject) =>
        request.signal.addEventListener("abort", () => {
          aborted.push(request.url);
          reject(new Error("aborted"));
        }),
      );
    const started = Date.now();
    expect(await serverVersion(config, { fetch: hanging }, 100)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(aborted).toHaveLength(1);
    // A health hook that ignores the deadline is cut off all the same.
    expect(await serverVersion(config, { health: () => new Promise(() => {}) }, 100)).toBeNull();
  });

  test("serverVersion reads a pinned server's health through its pin", async () => {
    const d = device();
    const l = listener();
    await pinnedSync(d, l);
    const config = d.with((v) => loadSync(v, d.key))!;
    expect(await serverVersion(config)).toBe("test");
  });
});
