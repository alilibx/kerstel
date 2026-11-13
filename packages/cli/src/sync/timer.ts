import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SCRUBBED_MARKER } from "../daemon/env";
import { cliCommand } from "../daemon/spawn";
import { kerstelHome } from "../paths";
import { NETWORK_SETTINGS } from "./background";

/** How often a synced device pulls: five minutes. */
export const SYNC_INTERVAL_SEC = 300;

/** Settings the timer's environment may carry, besides the network settings. Never a secret. */
const KEYCHAIN_SETTINGS = ["KERSTEL_KEYCHAIN_BACKEND", "KERSTEL_KEYCHAIN_SERVICE"];

/**
 * The environment a pull timer runs with. An allowlist built from scratch, so
 * nothing else (and nothing a test flag adds) can reach a unit file.
 */
export function timerEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  if (typeof base.KERSTEL_HOME === "string" && base.KERSTEL_HOME !== "") {
    env.KERSTEL_HOME = resolve(base.KERSTEL_HOME);
  }
  for (const name of [...KEYCHAIN_SETTINGS, ...NETWORK_SETTINGS]) {
    const value = base[name];
    if (typeof value === "string") env[name] = value;
  }
  env[SCRUBBED_MARKER] = "1";
  return env;
}

/** One timer per Kerstel home: the default home keeps the plain name. */
export function timerName(home: string, defaultHome: string, kind: "launchd" | "systemd"): string {
  const base = kind === "launchd" ? "dev.kerstel.sync" : "kerstel-sync";
  const resolved = resolve(home);
  if (resolved === resolve(defaultHome)) return base;
  const hex8 = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${base}${kind === "launchd" ? "." : "-"}${hex8}`;
}

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderLaunchdPlist(o: { label: string; argv: string[]; env: Record<string, string> }): string {
  const args = o.argv.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const env = Object.entries(o.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>StartInterval</key>
  <integer>${SYNC_INTERVAL_SEC}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

/** A systemd word: `%` is a specifier, so it doubles; a word with spaces or quotes is quoted. */
function sdWord(s: string): string {
  const pct = s.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  if (!/[\s"'\\]/.test(s)) return pct;
  return `"${pct.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sdEnv(k: string, v: string): string {
  const body = `${k}=${v}`.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `Environment="${body}"`;
}

export function renderSystemdUnits(o: {
  name: string;
  argv: string[];
  env: Record<string, string>;
}): { service: string; timer: string } {
  const envLines = Object.entries(o.env).map(([k, v]) => sdEnv(k, v));
  const service = [
    "[Unit]",
    "Description=Kerstel sync",
    "",
    "[Service]",
    "Type=oneshot",
    ...envLines,
    `ExecStart=${o.argv.map(sdWord).join(" ")}`,
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    "Description=Kerstel sync every five minutes",
    "",
    "[Timer]",
    "OnStartupSec=1min",
    "OnUnitActiveSec=5min",
    `Unit=${o.name}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return { service, timer };
}

// ---- Install, check, remove -------------------------------------------------

type TimerKind = "launchd" | "systemd";

export type TimerStatus =
  | { state: "installed"; kind: TimerKind; current: boolean }
  | { state: "missing"; kind: TimerKind }
  | { state: "unavailable"; reason: string };

export type EnsureResult = "installed" | "updated" | "unchanged" | "unavailable";

export interface TimerDeps {
  platform: NodeJS.Platform;
  userHome: string;
  /** The Kerstel home this timer pulls for. */
  home: string;
  /** The home that keeps the plain timer name. */
  defaultHome: string;
  env: NodeJS.ProcessEnv;
  /** What the timer runs. */
  argv: string[];
  uid: number;
  run: (argv: string[]) => { code: number; stdout: string };
}

export interface SyncTimer {
  status(): TimerStatus;
  ensure(o: { rewrite: boolean }): EnsureResult;
  remove(): boolean;
}

function spawnRun(argv: string[]): { code: number; stdout: string } {
  const r = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return { code: r.exitCode ?? 1, stdout: r.stdout.toString() };
}

const DISABLED: SyncTimer = {
  status: () => ({ state: "unavailable", reason: "disabled in tests" }),
  ensure: () => "unavailable",
  remove: () => false,
};

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function writeUnit(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o644 });
  chmodSync(file, 0o644);
}

/** The pull timer for this Kerstel home. `ensure` and `remove` never throw. */
export function syncTimer(given: Partial<TimerDeps> = {}): SyncTimer {
  if (process.env.KERSTEL_TEST_NO_SYNC_TIMER === "1" && !given.run) return DISABLED;
  const deps: TimerDeps = {
    platform: process.platform,
    userHome: homedir(),
    home: kerstelHome(),
    defaultHome: join(homedir(), ".kerstel"),
    env: process.env,
    argv: cliCommand(["sync", "--background", "--timer"]),
    uid: process.getuid?.() ?? 0,
    run: spawnRun,
    ...given,
  };
  if (deps.platform === "darwin") return launchdTimer(deps);
  if (deps.platform === "linux") return systemdTimer(deps);
  const reason = `not supported on ${deps.platform}`;
  return { status: () => ({ state: "unavailable", reason }), ensure: () => "unavailable", remove: () => false };
}

function launchdTimer(deps: TimerDeps): SyncTimer {
  const label = timerName(deps.home, deps.defaultHome, "launchd");
  const file = join(deps.userHome, "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${deps.uid}`;
  const wanted = () => renderLaunchdPlist({ label, argv: deps.argv, env: timerEnv(deps.env) });
  const bootout = () => deps.run(["launchctl", "bootout", `${domain}/${label}`]);

  const status = (): TimerStatus => {
    const text = readOrNull(file);
    if (text === null) return { state: "missing", kind: "launchd" };
    return { state: "installed", kind: "launchd", current: text === wanted() };
  };
  const ensure = ({ rewrite }: { rewrite: boolean }): EnsureResult => {
    try {
      const s = status();
      if (s.state === "installed" && (s.current || !rewrite)) return "unchanged";
      writeUnit(file, wanted());
      bootout();
      if (deps.run(["launchctl", "bootstrap", domain, file]).code !== 0) return "unavailable";
      return s.state === "installed" ? "updated" : "installed";
    } catch {
      return "unavailable";
    }
  };
  const remove = (): boolean => {
    try {
      const existed = existsSync(file);
      bootout();
      rmSync(file, { force: true });
      return existed;
    } catch {
      return false;
    }
  };
  return { status, ensure, remove };
}

function systemdTimer(deps: TimerDeps): SyncTimer {
  const name = timerName(deps.home, deps.defaultHome, "systemd");
  const config = deps.env.XDG_CONFIG_HOME || join(deps.userHome, ".config");
  const dir = join(config, "systemd", "user");
  const serviceFile = join(dir, `${name}.service`);
  const timerFile = join(dir, `${name}.timer`);
  const wanted = () => renderSystemdUnits({ name, argv: deps.argv, env: timerEnv(deps.env) });
  const ctl = (...args: string[]) => deps.run(["systemctl", "--user", ...args]);
  const hasSession = () => ctl("show-environment").code === 0;

  const status = (): TimerStatus => {
    if (!hasSession()) return { state: "unavailable", reason: "no systemd user session" };
    const service = readOrNull(serviceFile);
    const timer = readOrNull(timerFile);
    if (service === null || timer === null) return { state: "missing", kind: "systemd" };
    const w = wanted();
    return { state: "installed", kind: "systemd", current: service === w.service && timer === w.timer };
  };
  const ensure = ({ rewrite }: { rewrite: boolean }): EnsureResult => {
    try {
      const s = status();
      if (s.state === "unavailable") return "unavailable";
      if (s.state === "installed" && (s.current || !rewrite)) return "unchanged";
      const w = wanted();
      writeUnit(serviceFile, w.service);
      writeUnit(timerFile, w.timer);
      if (ctl("daemon-reload").code !== 0) return "unavailable";
      if (ctl("enable", "--now", `${name}.timer`).code !== 0) return "unavailable";
      return s.state === "installed" ? "updated" : "installed";
    } catch {
      return "unavailable";
    }
  };
  const remove = (): boolean => {
    try {
      const existed = existsSync(serviceFile) || existsSync(timerFile);
      ctl("disable", "--now", `${name}.timer`);
      rmSync(serviceFile, { force: true });
      rmSync(timerFile, { force: true });
      if (existed) ctl("daemon-reload");
      return existed;
    } catch {
      return false;
    }
  };
  return { status, ensure, remove };
}
