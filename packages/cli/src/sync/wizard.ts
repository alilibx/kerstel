import { randomBytes } from "node:crypto";
import type { CliContext } from "../context";
import { enableSync, serverValueTarget, type SyncDeps } from "../commands/sync";
import { CancelledError, ClackPrompter, type Choice, DefaultsPrompter, type Prompter } from "../init/prompts";
import { fail, info, ok, yellow } from "../output";
import { isSafeReleaseUrl } from "../update/release-source";
import { cliName } from "../ui/cli-name";
import { VERSION } from "../version";
import { MAX_ADDRESSES, defaultAddresses, parseHostFacts, resolveIpv4, type HostFacts } from "./host-facts";
import { readInstallRecord, removeInstallRecord, writeInstallRecord, type InstallRecord } from "./install-record";
import { installerReleaseUrl, manualCommand } from "./installer";
import { localHost, sshHost, type Host } from "./remote";
import { isSafeServerUrl, loadSync, normaliseServerUrl } from "./state";

/**
 * `ks sync setup` with no arguments on a terminal: sets up a sync server over
 * SSH, on this machine, or through a command the person runs on the server,
 * then turns sync on for this device. Spec §4 and §5.
 */

export interface WizardDeps extends SyncDeps {
  /** Where the installer runs, for the `ssh` and `local` routes. */
  hostFor?: (route: "ssh" | "local", target: string | null) => Host;
  /** Whether a name resolves from this device, for a home box's `.local` name. */
  resolves?: (name: string) => Promise<boolean>;
  /** A name's IPv4 addresses (A records), for the domain check. */
  resolveAll?: (name: string) => Promise<string[]>;
  /** Whether a release asset exists at `url`: true or false from the server's answer, null when it can't be reached. */
  releaseFound?: (url: string) => Promise<boolean | null>;
  /** For tests: the version installed, in place of this CLI's. */
  version?: string;
}

type Route = "ssh" | "manual" | "local";
type Runtime = InstallRecord["runtime"];
type Reach = InstallRecord["reach"];

/** How devices reach the server. */
interface Reached {
  reach: Reach;
  /** The addresses devices use. Empty for Tailscale on the manual route: the installer finds the name. */
  addresses: string[];
}

/** What the person chose: everything the install needs but its version. */
interface Plan extends Reached {
  installId: string;
  runtime: Runtime;
}

/** Where a device sends its vault: from a server value, or an address and token. */
interface Target {
  servers: string[];
  pin: Buffer | null;
  token: string | null;
}

/** The port a pinned or Tailscale server listens on. A domain uses 443. */
const PORT = 8787;

/** `https://…`, `http://…`: a URL rather than a bare name. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The installer's exit code when the host runs a server another device set up. */
const ANOTHER_DEVICES_SERVER = 3;

const STOPPED = () => `The install stopped. Run ${cliName()} sync setup again to continue.`;

const SOMEONE_ELSES = (label: string) =>
  `${capitalised(label)} already runs a Kerstel server. If another device syncs with it, run ${cliName()} sync add-device there instead.`;

const warn = (message: string) => console.log(yellow(`!  ${message}`));

export async function runWizard(ctx: CliContext, deps: WizardDeps): Promise<number> {
  // `enableSync` closes the vault once it has it.
  let handedOver = false;
  let installing = false;
  try {
    if (loadSync(ctx.vault, ctx.dataKey)) {
      info(
        `Sync is already on for this vault. Run ${cliName()} sync server to see the server, or ${cliName()} sync add-device to add a device.`,
      );
      return 0;
    }
    const prompter = deps.prompter ?? new ClackPrompter();
    const route = await prompter.select(
      "Where should the sync server run?",
      [
        { value: "ssh", label: "On another machine, over SSH" },
        { value: "manual", label: "On another machine, I'll run a command there myself" },
        { value: "local", label: "On this machine" },
        { value: "existing", label: "I already have a server" },
      ],
      "ssh",
    );

    if (route === "existing") {
      const target = await existingServer(prompter);
      if (target === null) return 1;
      handedOver = true;
      // Today's `setup`: the summary, and the question before uploading.
      return await enableSync(ctx, { ...target, yes: false, deps: { ...deps, prompter } });
    }

    const version = deps.version ?? VERSION;
    const releasesUrl = process.env.KERSTEL_RELEASES_URL || null;
    if (releasesUrl !== null && !isSafeReleaseUrl(releasesUrl)) {
      fail("KERSTEL_RELEASES_URL must be https://, or http:// to this machine.");
      return 1;
    }
    // The installer fetches this version's image or binary: a build with no release has none.
    // A release source that can't be reached at all doesn't stop it: the install fails later if it must.
    if ((await (deps.releaseFound ?? releaseFound)(installerReleaseUrl(version))) === false) {
      fail(
        `No kerstel-server release v${version} was found, so the server can't be installed from this build. ` +
          "Install a released Kerstel, or set KERSTEL_RELEASES_URL to a mirror.",
      );
      return 1;
    }

    let target: Target;
    let record: InstallRecord;
    if (route === "manual") {
      const plan = await askManual(prompter, version);
      if (typeof plan === "number") return plan;
      record = { ...plan, route, host: null, version, finished: false };
      writeInstallRecord(record);
      installing = true;
      info("Run this on the server. It installs kerstel-server, then prints a server value:");
      console.log("");
      console.log(manualCommand({ version, args: installArgs(plan, version, releasesUrl) }));
      console.log("");
      const pasted = await pastedValue(prompter);
      if (pasted === null) {
        fail(STOPPED());
        return 1;
      }
      target = pasted;
      record = started(record, target);
      ok("Server running, restarts on reboot");
    } else {
      // The installer's output is held back while it only reports what it found.
      let muted = false;
      const write = (text: string) => void (muted || process.stderr.write(text));
      const hostFor = deps.hostFor ?? ((r, t) => (r === "ssh" ? sshHost(t!, { write }) : localHost({ write })));
      const sshTarget = route === "ssh" ? await askSshHost(prompter) : null;
      const host = hostFor(route, sshTarget);

      muted = true;
      const detected = await host.run(["detect"]).finally(() => (muted = false));
      if (detected.code !== 0) {
        if (deps.hostFor === undefined) for (const line of detected.lines) process.stderr.write(`${line}\n`);
        fail(
          route === "ssh"
            ? `Could not run the installer on ${host.label}. Check that ssh ${host.label} works, then run ${cliName()} sync setup again.`
            : "Could not check this machine for a server.",
        );
        return 1;
      }
      const facts = parseHostFacts(detected.lines);
      const found = `${osName(facts.os)} ${facts.arch}, ${facts.docker ? "Docker found" : "no Docker"}.`;
      info(route === "ssh" ? `Connecting with your SSH setup… ${found}` : `This machine: ${found}`);
      if (!isSupported(facts)) {
        fail(
          `${capitalised(host.label)} runs ${osName(facts.os) || "an unknown system"} ${facts.arch}. ` +
            "kerstel-server has four builds: Linux x64, Linux arm64, macOS x64 and macOS arm64.",
        );
        return 1;
      }
      if (route === "local") info("A server on this machine is reachable only while this machine is on.");

      const plan = await planForHost(prompter, deps, { route, target: sshTarget, label: host.label, facts, version });
      if (typeof plan === "number") return plan;
      record = { ...plan, route, host: sshTarget, version, finished: false };
      writeInstallRecord(record);
      installing = true;
      const run = await host.run(installArgs(plan, version, releasesUrl), { interactive: true });
      if (run.code === ANOTHER_DEVICES_SERVER) {
        // Nothing of this device's is on the host, so there is nothing to resume.
        removeInstallRecord();
        info(SOMEONE_ELSES(host.label));
        return 1;
      }
      const value = run.code === 0 && run.value !== null ? serverValueTarget(run.value) : null;
      if (value === null) {
        fail(STOPPED());
        return 1;
      }
      target = value;
      record = started(record, target);
      ok(`Server running on ${host.label}, restarts on reboot`);
    }

    handedOver = true;
    const code = await enableSync(ctx, { ...target, yes: true, deps: { ...deps, prompter: new DefaultsPrompter() } });
    if (code !== 0) {
      info(`Run ${cliName()} sync setup again to continue.`);
      return code;
    }
    writeInstallRecord({ ...record, finished: true });
    return 0;
  } catch (error) {
    if (error instanceof CancelledError) {
      fail(installing ? STOPPED() : error.message);
      return 130;
    }
    throw error;
  } finally {
    if (!handedOver) ctx.vault.close();
  }
}

/** Records that the server answered with its value: a failure from here on is this device's sync. */
function started(record: InstallRecord, target: Target): InstallRecord {
  const next = { ...record, addresses: target.servers, started: true };
  writeInstallRecord(next);
  return next;
}

/** HEAD on the release asset, for 5 seconds. Null when nothing answers. */
async function releaseFound(url: string): Promise<boolean | null> {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return null;
  }
}

// ---- The installer's command line -------------------------------------------

/** `kerstel-server.sh install …` for `plan`. The token is never among them: the server makes it. */
function installArgs(plan: Plan, version: string, releasesUrl: string | null): string[] {
  const args = ["install", "--version", version, "--install-id", plan.installId, "--runtime", plan.runtime, "--reach", plan.reach];
  args.push("--port", String(plan.reach === "domain" ? 443 : PORT));
  // The names go into the self-signed certificate.
  if (plan.reach === "self") for (const name of new Set(plan.addresses.map(hostOf))) args.push("--name", name);
  if (plan.reach === "domain") args.push("--domain", hostOf(plan.addresses[0]!));
  if (releasesUrl !== null) args.push("--releases-url", releasesUrl);
  // The addresses the server value carries.
  for (const url of plan.addresses) args.push("--url", url);
  return args;
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");
}

const newInstallId = () => randomBytes(16).toString("base64url");

// ---- The routes ---------------------------------------------------------------

async function existingServer(prompter: Prompter): Promise<Target | null> {
  const answer = (await prompter.text("Server address, or paste a server value", { secret: true })).trim();
  if (answer.startsWith("ks-server")) return serverValueTarget(answer);
  const url = normaliseServerUrl(HAS_SCHEME.test(answer) ? answer : `https://${answer}`);
  // The answer is never repeated: it was typed at a hidden prompt, and may be a secret pasted by mistake.
  if (!answer || !isSafeServerUrl(url)) {
    fail("That is not a server address or a server value. Use https://, or http:// to this machine.");
    return null;
  }
  const token =
    process.env.KERSTEL_SYNC_ENROLL_TOKEN ||
    (await prompter.text("Enroll token (leave empty if the server has none)", { secret: true })).trim() ||
    null;
  return { servers: [url], pin: null, token };
}

async function askSshHost(prompter: Prompter): Promise<string> {
  for (;;) {
    const target = (await prompter.text('SSH host (as you\'d type it after "ssh")')).trim();
    if (target && !target.startsWith("-") && !/\s/.test(target)) return target;
    fail("Type the host as you would after ssh, like ali@homebox.");
  }
}

/** A server value pasted at a hidden prompt, asked again until it reads; null when the answer is empty. */
async function pastedValue(prompter: Prompter): Promise<Target | null> {
  for (;;) {
    const answer = (await prompter.text("Paste the server value it printed", { secret: true })).trim();
    if (!answer) return null;
    const target = serverValueTarget(answer);
    if (target !== null) return target;
  }
}

/**
 * Whether to set up a new server when this device has an unfinished one
 * elsewhere, which the new record would forget. Asks, and No is the default.
 */
async function replacesUnfinished(prompter: Prompter, record: InstallRecord): Promise<boolean> {
  const where = record.host ?? (record.route === "local" ? "This machine" : "The server you ran the install command on");
  warn(
    `${where} may still run the server this device started setting up. Run ${cliName()} sync server remove first, or continue to set up a new one.`,
  );
  const answer = await prompter.select(
    "Set up a new server?",
    [
      { value: "no", label: "No, stop without changes" },
      { value: "yes", label: "Yes, set up a new one" },
    ],
    "no",
  );
  return answer === "yes";
}

/** The manual route: every question detection would have answered. A number is the exit code when it stops. */
async function askManual(prompter: Prompter, version: string): Promise<Plan | number> {
  // A rerun prints the same install ID, so the installer on the server continues the first run.
  const record = readInstallRecord();
  let installId: string;
  if (record?.route === "manual") installId = record.installId;
  else if (record !== null && !record.finished && !(await replacesUnfinished(prompter, record))) return 1;
  else installId = newInstallId();
  const runtime = await askRuntime(prompter, "systemd or launchd", version);
  const reach = await askReach(prompter, "Tailscale (the server's name on your tailnet)");
  if (reach === "domain") return { installId, runtime, reach, addresses: [`https://${await askDomain(prompter)}`] };
  if (reach === "tailscale") {
    info("Every device that syncs must be on your tailnet.");
    return { installId, runtime, reach, addresses: [] };
  }
  return { installId, runtime, reach, addresses: await askAddresses(prompter, [], { found: false }) };
}

/** The `ssh` and `local` routes, from what `detect` found. A number is the exit code when it stops. */
async function planForHost(
  prompter: Prompter,
  deps: WizardDeps,
  o: { route: "ssh" | "local"; target: string | null; label: string; facts: HostFacts; version: string },
): Promise<Plan | number> {
  const { label, facts } = o;
  const record = readInstallRecord();
  const ours = record !== null && facts.installId !== null && record.installId === facts.installId;
  if (facts.installed !== null && !ours) {
    info(SOMEONE_ELSES(label));
    await prompter.select("What next?", [{ value: "stop", label: "Stop without changes" }], "stop");
    return 1;
  }
  // `detect` can miss this device's install: it never asks for a sudo password, and Docker may need one.
  const unfinishedHere = record !== null && !record.finished && record.route === o.route && record.host === o.target;
  if (record !== null && (ours || unfinishedHere)) {
    info(ours ? "Found the server this device started setting up. Continuing." : `Continuing the setup this device started on ${label}.`);
    return resumedPlan(prompter, deps, { record, runtime: facts.installed ?? record.runtime, label, facts });
  }
  if (record !== null && !record.finished && !(await replacesUnfinished(prompter, record))) return 1;

  let runtime: Runtime = "service";
  if (facts.docker) {
    runtime = await askRuntime(prompter, facts.os === "darwin" ? "launchd" : "systemd", o.version);
  } else if (facts.os === "linux" && !facts.systemd) {
    fail(`${capitalised(label)} has neither Docker nor systemd, so kerstel-server cannot run there. Install Docker, then run ${cliName()} sync setup again.`);
    return 1;
  } else {
    info(`No Docker on ${label}, so the server runs as a service.`);
  }
  const reached = await askHowReached(prompter, deps, { label, facts });
  if (typeof reached === "number") return reached;
  return { installId: newInstallId(), runtime, ...reached };
}

/**
 * A rerun of the install this device started, with its install ID. A pinned
 * server's addresses are asked again, starting from the last ones. A domain or
 * Tailscale stays as it was, unless this device could not sync through it.
 */
async function resumedPlan(
  prompter: Prompter,
  deps: WizardDeps,
  o: { record: InstallRecord; runtime: Runtime; label: string; facts: HostFacts },
): Promise<Plan | number> {
  const { record } = o;
  const kept = { installId: record.installId, runtime: o.runtime };
  if (record.reach === "self") {
    return { ...kept, reach: "self", addresses: await askAddresses(prompter, record.addresses, { found: false }) };
  }
  if (record.started === true) {
    const shown = record.addresses.map(shortAddress).join(", ");
    info(`Last time, this device could not sync through ${shown}.`);
    const next = await prompter.select(
      "Reach it the same way?",
      [
        { value: "keep", label: `Yes, keep ${shown}` },
        { value: "change", label: "Change how devices reach it" },
      ],
      "keep",
    );
    if (next === "change") {
      const reached = await askHowReached(prompter, deps, { label: o.label, facts: o.facts });
      if (typeof reached === "number") return reached;
      return { ...kept, ...reached };
    }
  }
  return { ...kept, reach: record.reach, addresses: record.addresses };
}

/** How devices reach a server on a host `detect` described. A number is the exit code when it stops. */
async function askHowReached(prompter: Prompter, deps: WizardDeps, o: { label: string; facts: HostFacts }): Promise<Reached | number> {
  const { label, facts } = o;
  const tailnetName = facts.tailscale?.replace(/\.$/, "") || null;
  const reach = await askReach(prompter, tailnetName ? `Tailscale (${tailnetName}, found on this host)` : null);
  if (reach === "tailscale") {
    info("Every device that syncs must be on your tailnet.");
    return { reach, addresses: [`https://${tailnetName}`] };
  }
  if (reach === "domain") {
    const domain = await askDomain(prompter);
    const points = await (deps.resolveAll ?? resolveIpv4)(domain);
    if (!points.some((ip) => facts.ipv4.includes(ip))) {
      warn(`${domain} does not point at ${label} yet. Let's Encrypt needs it to.`);
      const go = await prompter.select(
        "Continue anyway?",
        [
          { value: "stop", label: "No, stop without changes" },
          { value: "continue", label: "Yes, continue" },
        ],
        "stop",
      );
      if (go !== "continue") return 1;
    }
    return { reach, addresses: [`https://${domain}`] };
  }
  const found = await defaultAddresses(facts, { port: PORT, resolves: deps.resolves });
  if (found.warn && found.addresses.length > 0) warn(found.warn);
  return { reach, addresses: await askAddresses(prompter, found.addresses, { found: true }) };
}

// ---- Questions ----------------------------------------------------------------

async function askRuntime(prompter: Prompter, manager: string, version: string): Promise<Runtime> {
  return prompter.select<Runtime>(
    "Run the server with",
    [
      { value: "docker", label: `Docker (ghcr.io/alilibx/kerstel-server:${version})` },
      { value: "service", label: `A service, no Docker (${manager}, checksum-verified binary)` },
    ],
    "docker",
  );
}

async function askReach(prompter: Prompter, tailscale: string | null): Promise<Reach> {
  const choices: Choice<Reach>[] = [
    { value: "self", label: "Its own certificate, pinned by your devices (no domain needed)" },
    { value: "domain", label: "My domain, with a Let's Encrypt certificate" },
  ];
  if (tailscale) choices.push({ value: "tailscale", label: tailscale });
  return prompter.select("How will your other devices reach it?", choices, "self");
}

async function askDomain(prompter: Prompter): Promise<string> {
  for (;;) {
    const answer = (await prompter.text("Domain")).trim().toLowerCase();
    const domain = answer.replace(/^https:\/\//, "").replace(/\/+$/, "").replace(/\.$/, "");
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return domain;
    fail("Type a domain name, like sync.example.com.");
  }
}

/**
 * The addresses devices use, comma-separated. With `defaults`, the answer
 * starts from them and an empty answer keeps them; the question names them
 * when they were `found` on the host. Without, an empty answer is asked again.
 */
async function askAddresses(prompter: Prompter, defaults: string[], o: { found: boolean }): Promise<string[]> {
  const shown = defaults.map(shortAddress).join(", ");
  const question = o.found && defaults.length > 0 ? `Address your devices use (found ${shown})` : "Address your devices use";
  for (;;) {
    const answer = (await prompter.text(question, defaults.length > 0 ? { initial: shown } : {})).trim();
    if (!answer) {
      if (defaults.length > 0) return defaults;
      fail("Your devices need an address to reach the server, like 192.168.1.20.");
      continue;
    }
    const parts = answer.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length > MAX_ADDRESSES) {
      fail(`Give at most ${MAX_ADDRESSES} addresses.`);
      continue;
    }
    const urls = parts.map(addressUrl);
    const bad = parts.find((_, i) => urls[i] === null);
    if (bad !== undefined) {
      fail(`${bad} is not an address devices can use. Type a name or an IP address, like 192.168.1.20.`);
      continue;
    }
    return [...new Set(urls as string[])];
  }
}

/** `https://<host>:8787` for a bare name or IP; an https:// URL as typed. Null for anything else. */
function addressUrl(text: string): string | null {
  const bare = !HAS_SCHEME.test(text);
  let url: URL;
  try {
    url = new URL(bare ? `https://${text}` : text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) return null;
  if (bare && url.port === "" && !/:443$/.test(text)) url.port = String(PORT);
  const out = `https://${url.host}`;
  return isSafeServerUrl(out) ? out : null;
}

/** `192.168.1.20` for `https://192.168.1.20:8787`, as the person would type it. */
function shortAddress(url: string): string {
  return url.replace(/^https:\/\//, "").replace(new RegExp(`:${PORT}$`), "");
}

// ---- Facts ------------------------------------------------------------------

function osName(os: string): string {
  return os === "linux" ? "Linux" : os === "darwin" ? "macOS" : os;
}

function isSupported(facts: HostFacts): boolean {
  return (facts.os === "linux" || facts.os === "darwin") && (facts.arch === "x64" || facts.arch === "arm64");
}

/** A host's label to start a sentence: "This machine", or an SSH target exactly as typed. */
function capitalised(label: string): string {
  return label === "this machine" ? "This machine" : label;
}
