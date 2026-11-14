import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAddresses, isPublicIpv4, parseHostFacts } from "../src/sync/host-facts";
import {
  type InstallRecord,
  readInstallRecord,
  removeInstallRecord,
  writeInstallRecord,
} from "../src/sync/install-record";

const record: InstallRecord = {
  installId: "abc_DEF-123",
  route: "ssh",
  host: "me@box",
  runtime: "docker",
  reach: "self",
  addresses: ["https://203.0.113.5:8787"],
  version: "0.4.0",
  finished: false,
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kerstel-install-record-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("install record", () => {
  test("round trips with mode 0600 and removes", () => {
    writeInstallRecord(record, home);
    expect(readInstallRecord(home)).toEqual(record);
    if (process.platform !== "win32") {
      expect(statSync(join(home, "sync-server.json")).mode & 0o777).toBe(0o600);
    }
    removeInstallRecord(home);
    expect(readInstallRecord(home)).toBeNull();
    removeInstallRecord(home);
  });

  test("missing or malformed reads as null", () => {
    expect(readInstallRecord(home)).toBeNull();
    const file = join(home, "sync-server.json");
    writeFileSync(file, "{nope");
    expect(readInstallRecord(home)).toBeNull();
    writeFileSync(file, "[]");
    expect(readInstallRecord(home)).toBeNull();
  });

  test.each([
    ["route", { route: "carrier-pigeon" }],
    ["runtime", { runtime: "k8s" }],
    ["reach", { reach: "magic" }],
    ["installId format", { installId: "bad id!" }],
    ["installId too long", { installId: "a".repeat(65) }],
    ["addresses type", { addresses: [1] }],
    ["finished type", { finished: "yes" }],
    ["host type", { host: 5 }],
  ])("invalid %s reads as null", (_name, patch) => {
    writeFileSync(join(home, "sync-server.json"), JSON.stringify({ ...record, ...patch }));
    expect(readInstallRecord(home)).toBeNull();
  });
});

describe("parseHostFacts", () => {
  test("parses detect output", () => {
    const facts = parseHostFacts([
      "os=linux",
      "arch=arm64",
      "docker=yes",
      "systemd=no",
      "tailscale=box.tail1.ts.net",
      "hostname=nas",
      "ipv4=192.168.1.20",
      "ipv4=10.0.0.4",
      "installed=service",
      "install-id=abc123",
      "something=else",
    ]);
    expect(facts).toEqual({
      os: "linux",
      arch: "arm64",
      docker: true,
      systemd: false,
      tailscale: "box.tail1.ts.net",
      hostname: "nas",
      ipv4: ["192.168.1.20", "10.0.0.4"],
      installed: "service",
      installId: "abc123",
    });
  });

  test("nothing installed, no tailscale", () => {
    const facts = parseHostFacts(["os=darwin", "tailscale=no", "installed=no"]);
    expect(facts.installed).toBeNull();
    expect(facts.installId).toBeNull();
    expect(facts.tailscale).toBeNull();
    expect(facts.ipv4).toEqual([]);
  });

  test("an installed server without an id", () => {
    const facts = parseHostFacts(["installed=docker"]);
    expect(facts.installed).toBe("docker");
    expect(facts.installId).toBeNull();
  });
});

describe("defaultAddresses", () => {
  const base = parseHostFacts(["os=linux", "hostname=nas"]);
  const yes = async () => true;
  const no = async () => false;

  test("a public IP is a VPS", async () => {
    const facts = { ...base, ipv4: ["10.0.0.2", "203.0.113.5"] };
    expect(await defaultAddresses(facts, { port: 8787, resolves: no })).toEqual({
      kind: "vps",
      addresses: ["https://203.0.113.5:8787"],
      warn: null,
    });
  });

  test("a home box gives its .local name, then its IP", async () => {
    const facts = { ...base, ipv4: ["192.168.1.20"] };
    const asked: string[] = [];
    const out = await defaultAddresses(facts, {
      port: 9000,
      resolves: async (n) => (asked.push(n), true),
    });
    expect(asked).toEqual(["nas.local"]);
    expect(out).toEqual({
      kind: "home",
      addresses: ["https://nas.local:9000", "https://192.168.1.20:9000"],
      warn: null,
    });
    expect(
      (await defaultAddresses({ ...facts, hostname: "nas.local" }, { port: 1, resolves: yes }))
        .addresses[0],
    ).toBe("https://nas.local:1");
  });

  test("with nothing resolving a home box gets its IP and a warning", async () => {
    const facts = { ...base, ipv4: ["192.168.1.20"] };
    const out = await defaultAddresses(facts, { port: 8787, resolves: no });
    expect(out.kind).toBe("home");
    expect(out.addresses).toEqual(["https://192.168.1.20:8787"]);
    expect(out.warn).toContain("No name for this host resolves here, so devices use its IP address.");
    expect(out.warn).toContain("sync server address on each device.");
  });

  test("CGNAT counts as private", async () => {
    const facts = { ...base, ipv4: ["100.64.0.1", "100.127.255.254"] };
    expect((await defaultAddresses(facts, { port: 8787, resolves: no })).kind).toBe("home");
  });

  test("range edges", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.0.1", "100.64.0.0", "100.127.0.1", "127.0.0.1", "169.254.1.1"]) {
      expect(isPublicIpv4(ip)).toBe(false);
    }
    for (const ip of ["172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "8.8.8.8", "192.169.0.1"]) {
      expect(isPublicIpv4(ip)).toBe(true);
    }
  });
});
