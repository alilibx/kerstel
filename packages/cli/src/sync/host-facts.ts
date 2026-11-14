import { lookup, resolve4 } from "node:dns/promises";
import { cliName } from "../ui/cli-name";

export interface HostFacts {
  os: "linux" | "darwin" | string;
  arch: string;
  docker: boolean;
  systemd: boolean;
  tailscale: string | null;
  hostname: string;
  ipv4: string[];
  installed: "docker" | "service" | null;
  installId: string | null;
}

/** Parses the `key=value` lines of `kerstel-server.sh detect`. Unknown lines are ignored. */
export function parseHostFacts(lines: string[]): HostFacts {
  const facts: HostFacts = {
    os: "",
    arch: "",
    docker: false,
    systemd: false,
    tailscale: null,
    hostname: "",
    ipv4: [],
    installed: null,
    installId: null,
  };
  for (const raw of lines) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    switch (key) {
      case "os":
        facts.os = value;
        break;
      case "arch":
        facts.arch = value;
        break;
      case "docker":
        facts.docker = value === "yes";
        break;
      case "systemd":
        facts.systemd = value === "yes";
        break;
      case "tailscale":
        facts.tailscale = value === "no" || value === "" ? null : value;
        break;
      case "hostname":
        facts.hostname = value;
        break;
      case "ipv4":
        if (value) facts.ipv4.push(value);
        break;
      case "installed":
        facts.installed = value === "docker" || value === "service" ? value : null;
        break;
      case "install-id":
        facts.installId = value || null;
        break;
    }
  }
  return facts;
}

/** Not 10/8, 172.16/12, 192.168/16, 100.64/10, 127/8 or 169.254/16. */
export function isPublicIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((n) => Number(n) > 255)) return false;
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

/** What `work` answers, or `fallback` when it fails or takes longer than `ms`. Never throws. */
export async function resolveWithin<T>(work: () => Promise<T>, fallback: T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<T>((done) => {
      timer = setTimeout(() => done(fallback), ms);
    });
    return await Promise.race([work().catch(() => fallback), timeout]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** True when `name` resolves from this device within 2 seconds. Never throws. */
export function resolvesHere(name: string): Promise<boolean> {
  return resolveWithin(() => lookup(name).then(() => true), false, 2000);
}

/** The IPv4 addresses (A records) of `name`, or none when it does not resolve within 5 seconds. Never throws. */
export function resolveIpv4(name: string): Promise<string[]> {
  return resolveWithin(() => resolve4(name), [], 5000);
}

/** A server value, and so a device, holds at most this many addresses. */
export const MAX_ADDRESSES = 4;

export async function defaultAddresses(
  facts: HostFacts,
  o: { port: number; resolves?: (name: string) => Promise<boolean> },
): Promise<{ kind: "vps" | "home"; addresses: string[]; warn: string | null }> {
  const url = (host: string) => `https://${host}:${o.port}`;
  const publicIp = facts.ipv4.find(isPublicIpv4);
  if (publicIp) return { kind: "vps", addresses: [url(publicIp)], warn: null };

  // Link-local addresses change with every boot, so no device should store one.
  const lan = facts.ipv4.filter((ip) => !ip.startsWith("127.") && !ip.startsWith("169.254.")).map(url);
  const label = facts.hostname.replace(/\.local$/i, "").split(".")[0] ?? "";
  if (label) {
    const name = `${label}.local`;
    if (await (o.resolves ?? resolvesHere)(name)) {
      return { kind: "home", addresses: [url(name), ...lan].slice(0, MAX_ADDRESSES), warn: null };
    }
  }
  return {
    kind: "home",
    addresses: lan.slice(0, MAX_ADDRESSES),
    warn: `No name for this host resolves here, so devices use its IP address. Reserve that address in your router: if it changes, run ${cliName()} sync server address on each device.`,
  };
}
