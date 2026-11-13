import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { SCRUBBED_MARKER } from "../daemon/env";
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
  const pct = s.replace(/%/g, "%%");
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
