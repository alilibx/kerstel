import { randomBytes } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import type { CliContext } from "../context";
import { enableSync, serverValueTarget, type SyncDeps } from "../commands/sync";
import { CancelledError, ClackPrompter, DefaultsPrompter, type Choice, type Prompter } from "../init/prompts";
import { fail, info, ok, yellow } from "../output";
import { isSafeReleaseUrl } from "../update/release-source";
import { cliName } from "../ui/cli-name";
import { VERSION } from "../version";
import { MAX_ADDRESSES, defaultAddresses, parseHostFacts, type HostFacts } from "./host-facts";
import { readInstallRecord, writeInstallRecord, type InstallRecord } from "./install-record";
import { manualCommand } from "./installer";
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
  /** For tests: the version installed, in place of this CLI's. */
  version?: string;
}

type Route = "ssh" | "manual" | "local";
type Runtime = InstallRecord["runtime"];
type Reach = InstallRecord["reach"];

/** What the person chose: everything the install needs but its version. */
interface Plan {
  installId: string;
  runtime: Runtime;
  reach: Reach;
  /** The addresses devices use. Empty for Tailscale on the manual route: the installer finds the name. */
  addresses: string[];
}

/** Where a device sends its vault: from a server value, or an address and token. */
interface Target {
  servers: string[];
  pin: Buffer | null;
  token: string | null;
}

/** The port a pinned or Tailscale server listens on. A domain uses 443. */
const PORT = 8787;

const STOPPED = () => `The install stopped. Run ${cliName()} sync setup again to continue.`;

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
      if (target === null) return 2;
      handedOver = true;
      return await enableSync(ctx, { ...target, yes: true, deps: withoutQuestions(deps) });
    }

    const version = deps.version ?? VERSION;
    const releasesUrl = process.env.KERSTEL_RELEASES_URL || null;
    if (releasesUrl !== null && !isSafeReleaseUrl(releasesUrl)) {
      fail("KERSTEL_RELEASES_URL must be https://, or http:// to this machine.");
      return 1;
    }
    // A dev build has no published image or binary to install.
    if (releasesUrl === null && version.includes("-dev")) {
      fail("The server installer needs a released Kerstel, or KERSTEL_RELEASES_URL pointing at a mirror.");
      return 1;
    }

    let target: Target;
    let record: InstallRecord;
    if (route === "manual") {
      const plan = await askManual(prompter, version);
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

      const plan = await planForHost(prompter, deps, { label: host.label, facts, version });
      if (typeof plan === "number") return plan;
      record = { ...plan, route, host: sshTarget, version, finished: false };
      writeInstallRecord(record);
      installing = true;
      const run = await host.run(installArgs(plan, version, releasesUrl), { interactive: true });
      const value = run.code === 0 && run.value !== null ? serverValueTarget(run.value) : null;
      if (value === null) {
        fail(STOPPED());
        return 1;
      }
      target = value;
      ok(`Server running on ${host.label}, restarts on reboot`);
    }

    handedOver = true;
    const code = await enableSync(ctx, { ...target, yes: true, deps: withoutQuestions(deps) });
    if (code !== 0) {
      info(`Run ${cliName()} sync setup again to continue.`);
      return code;
    }
    writeInstallRecord({ ...record, addresses: target.servers, finished: true });
    console.log(`Add your other devices with:  ${cliName()} sync add-device`);
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

/** The person already chose to set up, so `enableSync` asks nothing. */
function withoutQuestions(deps: SyncDeps): SyncDeps {
  return { ...deps, prompter: new DefaultsPrompter() };
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
  const url = normaliseServerUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(answer) ? answer : `https://${answer}`);
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

/** The manual route: every question detection would have answered. */
async function askManual(prompter: Prompter, version: string): Promise<Plan> {
  // A rerun prints the same install ID, so the installer on the server continues the first run.
  const record = readInstallRecord();
  const installId = record?.route === "manual" ? record.installId : newInstallId();
  const runtime = await askRuntime(prompter, "systemd or launchd", version);
  const reach = await askReach(prompter, "Tailscale (the server's name on your tailnet)");
  if (reach === "domain") return { installId, runtime, reach, addresses: [`https://${await askDomain(prompter)}`] };
  if (reach === "tailscale") {
    info("Every device that syncs must be on your tailnet.");
    return { installId, runtime, reach, addresses: [] };
  }
  return { installId, runtime, reach, addresses: await askAddresses(prompter, []) };
}

/** The `ssh` and `local` routes, from what `detect` found. A number is the exit code when it stops. */
async function planForHost(
  prompter: Prompter,
  deps: WizardDeps,
  o: { label: string; facts: HostFacts; version: string },
): Promise<Plan | number> {
  const { label, facts, version } = o;
  if (facts.installed !== null) {
    const record = readInstallRecord();
    if (record !== null && facts.installId !== null && record.installId === facts.installId) {
      info("Found the server this device started setting up. Continuing.");
      return { installId: record.installId, runtime: facts.installed, reach: record.reach, addresses: record.addresses };
    }
    info(
      `${capitalised(label)} already runs a Kerstel server. If another device syncs with it, run ${cliName()} sync add-device there instead.`,
    );
    await prompter.select("What next?", [{ value: "stop", label: "Stop without changes" }], "stop");
    return 1;
  }

  let runtime: Runtime = "service";
  if (facts.docker) {
    runtime = await askRuntime(prompter, facts.os === "darwin" ? "launchd" : "systemd", version);
  } else if (facts.os === "linux" && !facts.systemd) {
    fail(`${capitalised(label)} has neither Docker nor systemd, so kerstel-server cannot run there. Install Docker, then run ${cliName()} sync setup again.`);
    return 1;
  } else {
    info(`No Docker on ${label}, so the server runs as a service.`);
  }

  const tailnetName = facts.tailscale?.replace(/\.$/, "") || null;
  const reach = await askReach(prompter, tailnetName ? `Tailscale (${tailnetName}, found on this host)` : null);
  const installId = newInstallId();
  if (reach === "tailscale") {
    info("Every device that syncs must be on your tailnet.");
    return { installId, runtime, reach, addresses: [`https://${tailnetName}`] };
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
    return { installId, runtime, reach, addresses: [`https://${domain}`] };
  }
  const found = await defaultAddresses(facts, { port: PORT, resolves: deps.resolves });
  if (found.warn && found.addresses.length > 0) warn(found.warn);
  return { installId, runtime, reach, addresses: await askAddresses(prompter, found.addresses) };
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
 * The addresses devices use, comma-separated. With `found`, the question
 * shows them, starts from them, and an empty answer keeps them. Without, an
 * empty answer is asked again.
 */
async function askAddresses(prompter: Prompter, found: string[]): Promise<string[]> {
  const shown = found.map(shortAddress).join(", ");
  const question = found.length > 0 ? `Address your devices use (found ${shown})` : "Address your devices use";
  for (;;) {
    const answer = (await prompter.text(question, found.length > 0 ? { initial: shown } : {})).trim();
    if (!answer) {
      if (found.length > 0) return found;
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
  const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(text);
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

/** A name's A records, or none when it does not resolve within 5 seconds. Never throws. */
async function resolveIpv4(name: string): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<string[]>((done) => {
      timer = setTimeout(() => done([]), 5000);
    });
    return await Promise.race([resolve4(name).catch(() => [] as string[]), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
