import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kerstelHome } from "../paths";

/** What this device installed on a server. It holds no secret and never syncs. */
export interface InstallRecord {
  installId: string;
  route: "ssh" | "manual" | "local";
  host: string | null;
  runtime: "docker" | "service";
  reach: "self" | "domain" | "tailscale";
  addresses: string[];
  version: string;
  /** The server answered with its value, so a failure after it was this device's sync, not the install. */
  started?: boolean;
  finished: boolean;
}

// The installer accepts exactly this for --install-id.
const INSTALL_ID = /^[A-Za-z0-9_-]{1,64}$/;

function recordPath(home: string): string {
  return join(home, "sync-server.json");
}

function parseRecord(value: unknown): InstallRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.installId !== "string" || !INSTALL_ID.test(r.installId)) return null;
  if (r.route !== "ssh" && r.route !== "manual" && r.route !== "local") return null;
  if (r.host !== null && typeof r.host !== "string") return null;
  if (r.runtime !== "docker" && r.runtime !== "service") return null;
  if (r.reach !== "self" && r.reach !== "domain" && r.reach !== "tailscale") return null;
  if (!Array.isArray(r.addresses) || !r.addresses.every((a) => typeof a === "string")) return null;
  if (typeof r.version !== "string" || typeof r.finished !== "boolean") return null;
  return {
    installId: r.installId,
    route: r.route,
    host: r.host,
    runtime: r.runtime,
    reach: r.reach,
    addresses: [...(r.addresses as string[])],
    version: r.version,
    ...(r.started === true ? { started: true } : {}),
    finished: r.finished,
  };
}

export function readInstallRecord(home: string = kerstelHome()): InstallRecord | null {
  let text: string;
  try {
    text = readFileSync(recordPath(home), "utf8");
  } catch {
    return null;
  }
  try {
    return parseRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

export function writeInstallRecord(r: InstallRecord, home: string = kerstelHome()): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = recordPath(home);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

export function removeInstallRecord(home: string = kerstelHome()): void {
  rmSync(recordPath(home), { force: true });
}
