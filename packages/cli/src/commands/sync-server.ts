import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { CliContext } from "../context";
import { openContext } from "../context";
import { ClackPrompter } from "../init/prompts";
import { dim, fail, info, ok, yellow } from "../output";
import { isSafeReleaseUrl } from "../update/release-source";
import { isOlderRelease } from "../update/versions";
import { vaultPath } from "../paths";
import { glanceSync } from "../sync/background";
import { cliName } from "../ui/cli-name";
import { VERSION } from "../version";
import { MAX_ADDRESSES, parseHostFacts, resolveIpv4, type HostFacts } from "../sync/host-facts";
import { readInstallRecord, removeInstallRecord, writeInstallRecord, type InstallRecord } from "../sync/install-record";
import { manualCommand } from "../sync/installer";
import { PIN_NEEDS_HTTPS, SyncHttpError, syncClient, type Fetch } from "../sync/http";
import { localHost, sshHost, type Host } from "../sync/remote";
import { SYNC_META, isSafeServerUrl, loadSync, normaliseServerUrl, saveSync, shownAddress, type SyncConfig } from "../sync/state";
import { isHttps, parsePin } from "../../../server/src/pin";
import { clientFor, isInteractive, lockedOpen, notOn, type SyncDeps } from "./sync";

/**
 * `ks sync server`: the server this device set up, and looking after it.
 * Easy-sync spec §9. Only the device that installed the server holds its
 * install record; any other synced device can take it over with `manage`.
 */

export interface SyncServerDeps extends SyncDeps {
  /** Where the installer runs, for a record with the `ssh` or `local` route. */
  hostFor?: (route: "ssh" | "local", target: string | null) => Host;
  /** The server's `/v1/health` at `url`, or null when it does not answer. Defaults to the sync client's, with this vault's pin. */
  health?: (url: string) => Promise<{ version: string } | null>;
  /** A name's IPv4 addresses (A records), to tell whether an unpinned server's address points at a host. */
  resolveAll?: (name: string) => Promise<string[]>;
  /** For tests: the version to update to, in place of this CLI's. */
  version?: string;
}

const USAGE = () => `Usage:
  ${cliName()} sync server                    The server's address, whether it answers, its version
  ${cliName()} sync server update             Update the server to this Kerstel's version
  ${cliName()} sync server address <url>      Use the server's new address on this device
  ${cliName()} sync server manage <ssh-host>  Look after the server from this device
  ${cliName()} sync server stop               Stop the server and keep its data
  ${cliName()} sync server remove             Remove the server; asks before deleting its data`;

const MANAGED_ELSEWHERE = () =>
  `Managed from another device. To manage it from here: ${cliName()} sync server manage <ssh-host>`;

const DATABASE_QUESTION = "Also delete its database? Every device keeps its secrets, but syncing stops.";

/** A label column wide enough for "Installed". */
const row = (label: string, value: string) => `${label.padEnd(9)}  ${value}`;

export async function syncServerCommand(args: string[], deps: SyncServerDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  const plain = deps.context ?? (() => openContext());
  const usage = (line: string) => {
    fail(`Usage: ${cliName()} sync server ${line}`);
    return 2;
  };

  if (sub === undefined) return show(deps, plain);
  if (sub === "address") return rest.length === 1 ? address(rest[0]!, deps, lockedOpen(plain)) : usage("address <url>");
  if (sub === "manage") {
    const target = rest[0];
    // `-oProxyCommand=…` as a host would be an option to ssh, and run a command here.
    if (rest.length !== 1 || !target || target.startsWith("-") || /\s/.test(target)) return usage("manage <ssh-host>");
    return manage(target, deps, plain);
  }
  if (sub === "update" || sub === "stop" || sub === "remove") {
    if (rest.length > 0) return usage(sub);
    const record = readInstallRecord();
    if (record === null) {
      fail(`This device did not set up the server, so it can't ${sub} it.`);
      info(MANAGED_ELSEWHERE());
      return 1;
    }
    if (sub === "update") return update(record, deps);
    if (sub === "stop") return stop(record, deps);
    return remove(record, deps);
  }
  if (sub === "--help" || sub === "help") {
    console.log(USAGE());
    return 0;
  }
  fail(`Unknown sync server command "${sub}".`);
  console.log(USAGE());
  return 2;
}

// ---- Where the server runs ----------------------------------------------------

/** Where the record says the server runs, to name in a sentence; null for a server installed by hand. */
function whereOf(r: InstallRecord): string | null {
  if (r.route === "local") return "this machine";
  if (r.route === "ssh") return r.host;
  return null;
}

/** Where the record's server runs, for a sentence: its SSH host, this machine, or the host of its address. */
export function serverPlace(r: InstallRecord): string {
  const where = whereOf(r);
  if (where !== null) return where;
  const first = r.addresses[0];
  if (first === undefined) return "the host you ran the install command on";
  try {
    return hostOfUrl(first);
  } catch {
    return first;
  }
}

/**
 * What `uninstall` and `sync off` print, so a server never goes without a
 * device that can update it. Only an SSH host can be named for `manage`.
 */
export function manageLine(r: InstallRecord): string {
  const target = r.route === "ssh" && r.host !== null ? r.host : "<ssh-host>";
  return `The server keeps running. To manage it from another device: ${cliName()} sync server manage ${target}`;
}

function hostFor(deps: SyncServerDeps, route: "ssh" | "local", target: string | null, write?: (text: string) => void): Host {
  if (deps.hostFor) return deps.hostFor(route, target);
  return route === "ssh" ? sshHost(target!, write ? { write } : {}) : localHost(write ? { write } : {});
}

/** The release source the installer downloads from, when it is set, or a message when it can't be used. */
function releasesUrl(): { url: string | null } | { error: string } {
  const url = process.env.KERSTEL_RELEASES_URL || null;
  if (url !== null && !isSafeReleaseUrl(url)) return { error: "KERSTEL_RELEASES_URL must be https://, or http:// to this machine." };
  return { url };
}

/** Prints the command for a server installed by hand, to run there. */
function printManual(what: string, args: string[], version: string): void {
  info(`Run this on the server. It ${what}:`);
  console.log("");
  console.log(manualCommand({ version, args }));
  console.log("");
}

// ---- ks sync server -----------------------------------------------------------

async function show(deps: SyncServerDeps, open: () => Promise<CliContext>): Promise<number> {
  const record = readInstallRecord();
  const ctx = await open();
  let config: SyncConfig | null;
  let last: string | null;
  try {
    config = loadSync(ctx.vault, ctx.dataKey);
    last = ctx.vault.getMeta(SYNC_META.lastAddress);
  } finally {
    ctx.vault.close();
  }
  if (config === null && record === null) {
    notOn();
    return 0;
  }

  const servers = config?.servers ?? record!.addresses;
  if (servers.length > 0) {
    const shown = shownAddress(servers, last);
    const others = servers.filter((url) => url !== shown);
    console.log(row("Server", `${shown}${others.length > 0 ? ` (also ${others.join(", ")})` : ""}`));
  }
  if (config === null) {
    // Without this vault's pin, a pinned server can't be checked.
    console.log(row("Answers", dim(`not checked: sync is off on this device`)));
  } else {
    const health = await healthOf(config, deps);
    if ("version" in health) {
      console.log(row("Answers", servers.length > 1 ? `yes, at ${health.address}` : "yes"));
      console.log(row("Version", health.version));
    } else {
      console.log(row("Answers", yellow(`no: ${health.error}`)));
    }
  }

  if (record === null) {
    info(MANAGED_ELSEWHERE());
    return 0;
  }
  const where = whereOf(record);
  console.log(row("Installed", `${record.route}, ${record.runtime}, ${record.reach}, on ${where ?? "the host you ran the install command on"}`));
  if (!record.finished) info(`The setup this device started is not finished. Run ${cliName()} sync setup to continue it.`);
  return 0;
}

/** The server's version through the first address that answers, or why none did. */
async function healthOf(config: SyncConfig, deps: SyncServerDeps): Promise<{ address: string; version: string } | { error: string }> {
  if (deps.health) {
    for (const url of config.servers) {
      const health = await deps.health(url);
      if (health) return { address: url, version: health.version };
    }
    return { error: "no address answered" };
  }
  const client = clientFor(config, deps);
  try {
    const health = await client.health();
    return { address: client.address() ?? config.servers[0]!, version: String(health.version) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** How long `kerstel update` and `doctor` wait for the server's version, over every address together. */
export const SERVER_CHECK_MS = 3_000;

/**
 * The version the server answers with, through this vault's addresses and
 * pin, or null when none answers within `timeoutMs`. Never throws: an
 * offline server is never an error where this is asked.
 */
export async function serverVersion(config: SyncConfig, deps: SyncServerDeps = {}, timeoutMs: number = SERVER_CHECK_MS): Promise<string | null> {
  // One deadline for every request, the pinned certificate fetch included, so
  // a server with several silent addresses still takes no longer than this.
  const deadline = AbortSignal.timeout(timeoutMs);
  const base: Fetch = deps.fetch ?? ((request, init) => fetch(request, init as RequestInit));
  const timed: Fetch = (request, init) => base(new Request(request, { signal: deadline }), init);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Also bounds a `health` hook, which no signal reaches.
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const health = await Promise.race([healthOf(config, { ...deps, fetch: timed }), late]);
    return health !== null && "version" in health ? health.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * For `kerstel update`: the server this device installed, when it runs an
 * older release than `version`. Null when this device has no install record,
 * sync is off here, or the server does not answer in time.
 */
export async function serverBehind(version: string, deps: SyncServerDeps = {}): Promise<{ place: string; version: string } | null> {
  const record = readInstallRecord();
  // Read-only, so a device with sync off never opens its vault for this.
  if (record === null || !glanceSync(vaultPath()).on) return null;
  let config: SyncConfig | null;
  try {
    const ctx = await (deps.context ?? (() => openContext({ warnFileKey: false })))();
    try {
      config = loadSync(ctx.vault, ctx.dataKey);
    } finally {
      ctx.vault.close();
    }
  } catch {
    return null;
  }
  if (config === null) return null;
  const running = await serverVersion(config, deps);
  if (running === null || !isOlderRelease(running, version)) return null;
  return { place: serverPlace(record), version: running };
}

// ---- update, stop, remove -----------------------------------------------------

async function update(record: InstallRecord, deps: SyncServerDeps): Promise<number> {
  const version = deps.version ?? VERSION;
  const releases = releasesUrl();
  if ("error" in releases) {
    fail(releases.error);
    return 1;
  }
  const args = ["update", "--version", version, ...(releases.url ? ["--releases-url", releases.url] : [])];
  if (record.route === "manual") {
    printManual(`updates kerstel-server to ${version}, keeping its data`, args, version);
    return 0;
  }
  const where = whereOf(record)!;
  const run = await hostFor(deps, record.route, record.host).run(args, { interactive: true });
  if (run.code !== 0) {
    fail(`The update did not finish on ${where}. Fix what the installer said above, then run ${cliName()} sync server update again.`);
    return 1;
  }
  writeInstallRecord({ ...record, version });
  ok(`Updated the server on ${where} to ${version}.`);
  return 0;
}

async function stop(record: InstallRecord, deps: SyncServerDeps): Promise<number> {
  const again = `Start it again with ${cliName()} sync server update.`;
  if (record.route === "manual") {
    const releases = releasesUrl();
    if ("error" in releases) {
      fail(releases.error);
      return 1;
    }
    printManual("stops kerstel-server and keeps its data", ["stop"], deps.version ?? VERSION);
    return 0;
  }
  const where = whereOf(record)!;
  const run = await hostFor(deps, record.route, record.host).run(["stop"], { interactive: true });
  if (run.code !== 0) {
    fail(`The server on ${where} did not stop. Fix what the installer said above, then run ${cliName()} sync server stop again.`);
    return 1;
  }
  ok(`Stopped the server on ${where}. Its data stays. ${again}`);
  return 0;
}

/**
 * Asks before removing, and again before deleting the database (No by
 * default). The record goes only once the removal is done: for a server
 * installed by hand, once the person says the printed command finished.
 */
async function remove(record: InstallRecord, deps: SyncServerDeps): Promise<number> {
  if (!isInteractive(deps)) {
    fail(`${cliName()} sync server remove asks before it removes anything, so it needs a terminal.`);
    return 2;
  }
  const where = whereOf(record);
  if (record.route === "manual") {
    const releases = releasesUrl();
    if ("error" in releases) {
      fail(releases.error);
      return 1;
    }
  }
  const prompter = deps.prompter ?? new ClackPrompter();
  const sure = await prompter.select(
    where ? `Remove the server from ${where}?` : "Remove the server?",
    [
      { value: "no", label: "No, keep it" },
      { value: "yes", label: "Yes, remove it" },
    ],
    "no",
  );
  if (sure !== "yes") {
    info("Nothing was changed.");
    return 0;
  }
  const data = await prompter.select(
    DATABASE_QUESTION,
    [
      { value: "keep", label: "No, keep the database on the host" },
      { value: "delete", label: "Yes, delete it" },
    ],
    "keep",
  );
  const args = data === "delete" ? ["remove", "--delete-data"] : ["remove"];
  const kept = data === "delete" ? "" : " Its database stays on the host.";

  if (record.route === "manual") {
    printManual(data === "delete" ? "removes kerstel-server and its database" : "removes kerstel-server and keeps its database", args, deps.version ?? VERSION);
    const ran = await prompter.select(
      "Did the command finish on the server?",
      [
        { value: "no", label: "No, not yet" },
        { value: "yes", label: "Yes, it finished" },
      ],
      "no",
    );
    if (ran !== "yes") {
      info(`This device keeps its record of the server. Once the command has run, run ${cliName()} sync server remove again.`);
      return 0;
    }
    removeInstallRecord();
    ok(`Removed the server.${kept}`);
    return 0;
  }

  const run = await hostFor(deps, record.route, record.host).run(args, { interactive: true });
  if (run.code !== 0) {
    fail(`The server on ${where} was not removed. Fix what the installer said above, then run ${cliName()} sync server remove again.`);
    return 1;
  }
  removeInstallRecord();
  ok(`Removed the server from ${where}.${kept}`);
  return 0;
}

/**
 * For `uninstall`, which has already asked: removes the server and keeps its
 * database, without another question. A server installed by hand gets the
 * command to run there. False when it was not removed; the caller says what
 * that means, since the record goes with Kerstel.
 */
export async function removeServerKeepingData(record: InstallRecord, deps: SyncServerDeps = {}): Promise<boolean> {
  if (record.route === "manual") {
    const releases = releasesUrl();
    if ("error" in releases) {
      fail(releases.error);
      return false;
    }
    printManual("removes kerstel-server and keeps its database", ["remove"], deps.version ?? VERSION);
    return true;
  }
  const where = whereOf(record)!;
  const run = await hostFor(deps, record.route, record.host).run(["remove"], { interactive: true });
  if (run.code !== 0) {
    fail(`The server on ${where} was not removed.`);
    return false;
  }
  ok(`Removed the server from ${where}. Its database stays on the host.`);
  return true;
}

// ---- address ------------------------------------------------------------------

/** Why a server at `url` is not this vault's, from a failed `devices()` call there. */
function notThisVault(error: unknown, url: string): string {
  if (error instanceof SyncHttpError) {
    if (error.code === "pin_mismatch") return `${url} presented a key this vault does not trust, so it is not this vault's server.`;
    // Unknown vaults and devices both answer 401 "Unknown device.".
    if (error.code === "unauthorized" && error.message.startsWith("Unknown device")) return `${url} answered, but it does not know this vault.`;
  }
  return (error as Error).message;
}

/** Whether the server at `servers` answers this device's signed `devices()` and lists it. A message when not. */
async function knowsThisDevice(config: SyncConfig, servers: string[], deps: SyncServerDeps): Promise<string | null> {
  const client = syncClient({
    servers,
    vaultId: config.vaultId,
    deviceId: config.deviceId,
    sign: config.keys.sign,
    fetch: deps.fetch,
    now: deps.now,
    pin: config.pin,
  });
  try {
    const { devices } = await client.devices();
    if (devices.some((d) => d.id === config.deviceId)) return null;
    return `${servers[0]} answered, but it does not know this vault.`;
  } catch (error) {
    return notThisVault(error, client.address() ?? servers[0]!);
  }
}

/**
 * Points this device at the server's new address. It keeps the pin, and saves
 * the address, first, only when the server there answers with the pinned key
 * and lists this device.
 */
async function address(given: string, deps: SyncServerDeps, open: () => Promise<CliContext>): Promise<number> {
  const url = normaliseServerUrl(given);
  if (!isSafeServerUrl(url)) {
    fail(`${given} is not a server Kerstel will send your vault to. Use https://, or http:// to this machine.`);
    return 2;
  }
  const ctx = await open();
  try {
    const config = loadSync(ctx.vault, ctx.dataKey);
    if (!config) {
      notOn();
      return 1;
    }
    if (config.pin && !isHttps(url)) {
      fail(PIN_NEEDS_HTTPS);
      return 2;
    }
    const problem = await knowsThisDevice(config, [url], deps);
    if (problem !== null) {
      fail(`${problem} Nothing was changed.`);
      return 1;
    }
    const servers = [url, ...config.servers.filter((s) => s !== url)].slice(0, MAX_ADDRESSES);
    saveSync(ctx.vault, ctx.dataKey, { ...config, servers });
    ctx.vault.setMeta(SYNC_META.lastAddress, url);
    const record = readInstallRecord();
    if (record !== null && record.finished) writeInstallRecord({ ...record, addresses: servers });
    ok(`This device now reaches the server at ${url}.`);
    info(`Run ${cliName()} sync server address ${url} on each of your other devices too.`);
    return 0;
  } finally {
    ctx.vault.close();
  }
}

// ---- manage -------------------------------------------------------------------

/** What `kerstel-server.sh info` printed: what `detect` reports, then the server's own lines. */
interface ServerInfo {
  facts: HostFacts;
  version: string | null;
  pin: string | null;
  running: boolean;
}

function parseInfo(lines: string[]): ServerInfo {
  const value = (key: string): string | null => {
    const prefix = `${key}=`;
    const line = lines.map((l) => l.trim()).find((l) => l.startsWith(prefix));
    return line === undefined ? null : line.slice(prefix.length);
  };
  return { facts: parseHostFacts(lines), version: value("version"), pin: value("pin"), running: value("running") === "yes" };
}

/** A line `info` or `detect` reports, such as `os=linux`, or the start of one. */
const REPORT_LINE = /^[a-z][a-z0-9-]*=/;
const REPORT_START = /^([a-z][a-z0-9-]*)?$/;

/**
 * Copies the installer's output to `write`, except the `key=value` lines it
 * reports: those are read, not shown. A partial line is held only while it
 * could still become one, so a sudo prompt shows at once.
 */
export function hidingReport(write: (text: string) => void): (text: string) => void {
  let held = "";
  let passing = false;
  return (text) => {
    for (const part of text.split(/(?<=\n)/)) {
      const ends = part.endsWith("\n");
      if (passing) {
        write(part);
        passing = !ends;
        continue;
      }
      held += part;
      if (REPORT_LINE.test(held)) {
        if (ends) held = "";
        continue;
      }
      if (ends || !REPORT_START.test(held)) {
        write(held);
        passing = !ends;
        held = "";
      }
    }
  };
}

function hostOfUrl(url: string): string {
  return new URL(url).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

/** The names and addresses the host answers to, as `detect` reports them. */
function namesOf(facts: HostFacts): Set<string> {
  const names = new Set<string>(facts.ipv4);
  const hostname = facts.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname) {
    const label = hostname.replace(/\.local$/, "").split(".")[0]!;
    names.add(hostname).add(label).add(`${label}.local`);
  }
  const tailnet = facts.tailscale?.toLowerCase().replace(/\.$/, "");
  if (tailnet) names.add(tailnet);
  return names;
}

/** This vault's addresses that point at the host: one of its names or IPs, or a name that resolves to one of its IPs. */
async function addressesOnHost(servers: string[], facts: HostFacts, deps: SyncServerDeps): Promise<string[]> {
  const names = namesOf(facts);
  const found: string[] = [];
  for (const url of servers) {
    const host = hostOfUrl(url);
    if (names.has(host)) found.push(url);
    else if (isIP(host) === 0 && (await (deps.resolveAll ?? resolveIpv4)(host)).some((ip) => facts.ipv4.includes(ip))) found.push(url);
  }
  return found;
}

const newInstallId = () => randomBytes(16).toString("base64url");

/**
 * Takes over a server another device set up: over SSH, reads what the host
 * runs, checks it is the server this vault syncs with, and saves the record.
 */
async function manage(target: string, deps: SyncServerDeps, open: () => Promise<CliContext>): Promise<number> {
  const ctx = await open();
  let config: SyncConfig | null;
  try {
    config = loadSync(ctx.vault, ctx.dataKey);
  } finally {
    ctx.vault.close();
  }
  if (!config) {
    notOn();
    return 1;
  }

  const host = hostFor(deps, "ssh", target, hidingReport((text) => void process.stderr.write(text)));
  const run = await host.run(["info"], { interactive: true });
  const found = parseInfo(run.lines);
  if (run.code !== 0 || found.facts.installed === null) {
    if (found.facts.installed === null && found.facts.os !== "") fail(`No Kerstel server is installed on ${target}. Nothing was saved.`);
    else if (run.code === 3) fail(`The Kerstel server on ${target} was set up by another user there. Run this as that user. Nothing was saved.`);
    else fail(`Could not read the server on ${target}. Check that ssh ${target} works, then run this again. Nothing was saved.`);
    return 1;
  }
  info(`Found kerstel-server ${found.version ?? "(version unknown)"} on ${target}, ${found.facts.installed}, ${found.running ? "running" : "stopped"}.`);

  let servers: string[];
  let reach: InstallRecord["reach"];
  if (config.pin) {
    const pin = found.pin === null ? null : parsePin(found.pin);
    if (pin === null) {
      fail(
        `Kerstel could not read the certificate pin of the server on ${target}${found.running ? "" : ", which is stopped"}, ` +
          "so it can't tell that it is the one this vault syncs with. Nothing was saved.",
      );
      return 1;
    }
    if (!pin.equals(config.pin)) {
      fail(`The server on ${target} is not the one this vault syncs with: its certificate pin is different. Nothing was saved.`);
      return 1;
    }
    servers = config.servers;
    reach = "self";
  } else {
    servers = await addressesOnHost(config.servers, found.facts, deps);
    if (servers.length === 0) {
      fail(
        `None of this vault's addresses (${config.servers.join(", ")}) points at ${target}, ` +
          "so Kerstel can't tell that its server is the one this vault syncs with. Nothing was saved.",
      );
      return 1;
    }
    const tailnet = found.facts.tailscale?.toLowerCase().replace(/\.$/, "");
    reach = tailnet && servers.some((url) => hostOfUrl(url) === tailnet) ? "tailscale" : "domain";
  }
  const problem = await knowsThisDevice(config, servers, deps);
  if (problem !== null) {
    fail(`${problem} Nothing was saved.`);
    return 1;
  }

  const previous = readInstallRecord();
  if (previous !== null && (previous.route !== "ssh" || previous.host !== target)) {
    info(`This device no longer keeps a record of the server ${whereOf(previous) ? `on ${whereOf(previous)}` : "it set up by hand"}.`);
  }
  writeInstallRecord({
    installId: found.facts.installId ?? newInstallId(),
    route: "ssh",
    host: target,
    runtime: found.facts.installed,
    reach,
    addresses: config.servers,
    version: found.version ?? "",
    finished: true,
  });
  ok(`This device now manages the server on ${target}. See it with ${cliName()} sync server.`);
  return 0;
}
