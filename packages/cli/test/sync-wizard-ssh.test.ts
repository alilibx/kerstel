import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { syncServerCommand } from "../src/commands/sync-server";
import type { CliContext } from "../src/context";
import { ScriptedPrompter } from "../src/init/prompts";
import { SyncHttpError, syncClient, type Fetch } from "../src/sync/http";
import { readInstallRecord } from "../src/sync/install-record";
import { loadSync } from "../src/sync/state";
import type { SyncTimer } from "../src/sync/timer";
import { runWizard } from "../src/sync/wizard";
import { VERSION } from "../src/version";
import { generateDataKey } from "../src/vault/crypto";
import { openVault, type Vault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

/**
 * Task 11: the setup wizard over the real `ssh`, installing the real
 * kerstel-server with Docker and as a systemd service. The `wizard-ssh` job in
 * .github/workflows/ci.yml sets it up: an sshd on 127.0.0.1:2222 for the
 * runner user (named by KERSTEL_TEST_SSH_HOST through the config file in
 * KERSTEL_TEST_SSH_CONFIG), the server image tagged for this version, and a
 * release mirror on 127.0.0.1 in KERSTEL_RELEASES_URL.
 *
 * The SSH host must be this machine: the test checks the container, the unit,
 * the token file and every process's argv here. Elsewhere it skips.
 */

const HOST = process.env.KERSTEL_TEST_SSH_HOST ?? "";
const MIRROR = process.env.KERSTEL_RELEASES_URL ?? "";
const skip = !HOST;

/** What the installer writes on the host. */
const KH = join(homedir(), ".kerstel-server");
const UNIT = "/etc/systemd/system/kerstel-server.service";
const CONTAINER = "kerstel-server";
const VOLUME = "kerstel-server";
/** The address the server answers on: the runner itself. */
const ADDRESS = "https://127.0.0.1:8787";
const SECRET = "ssh-e2e-secret-value";
const VALUE = /ks-server1-[A-Za-z0-9_-]+/g;
/** Long enough for an image start or a service install over ssh. */
const TIMEOUT = 240_000;

const fakeTimer: SyncTimer = {
  status: () => ({ state: "installed", kind: "systemd", current: true }),
  ensure: () => "unchanged",
  remove: () => true,
};

/** A command here; its output, never printed. */
function run(argv: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", env: process.env });
  return { code: proc.exitCode ?? 1, out: proc.stdout.toString().trim() };
}

const containerIds = () => run(["docker", "ps", "-aq", "--filter", `name=^${CONTAINER}$`]).out.split("\n").filter(Boolean);
const volumes = () => run(["docker", "volume", "ls", "-q", "--filter", `name=^${VOLUME}$`]).out.split("\n").filter(Boolean);
const unitFiles = () => run(["sh", "-c", "ls /etc/systemd/system | grep '^kerstel-server' || true"]).out.split("\n").filter(Boolean);
const mainPid = () => run(["systemctl", "show", "--property=MainPID", "--value", "kerstel-server.service"]).out;
const serviceActive = () => run(["systemctl", "is-active", "--quiet", "kerstel-server.service"]).code === 0;

/** What the host already runs, so the test never takes over or removes someone's real server. */
function hostIsClean(): boolean {
  return containerIds().length === 0 && !existsSync(UNIT) && !existsSync(join(KH, "install-id"));
}

/** The enroll token kerstel-server made, read from its file; null when there is none yet. */
function tokenOnHost(runtime: "docker" | "service"): string | null {
  if (runtime === "service") {
    try {
      return readFileSync(join(KH, "enroll-token"), "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "kerstel-ssh-token-"));
  try {
    // The image has no shell, so `docker cp` rather than `docker exec cat`.
    if (run(["docker", "cp", `${CONTAINER}:/data/enroll-token`, join(dir, "token")]).code !== 0) return null;
    return readFileSync(join(dir, "token"), "utf8").trim() || null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- This device ----------------------------------------------------------------

const dirs: string[] = [];

/** A fresh device: its own KERSTEL_HOME, a file-backed vault with one secret. */
function device(name: string) {
  const home = isolateEnv({ prefix: `wizard-ssh-${name}` });
  dirs.push(home);
  // isolateEnv points releases at a dead port; the installer needs the job's mirror.
  process.env.KERSTEL_RELEASES_URL = MIRROR;
  const key = generateDataKey();
  const file = join(home, "vault.db");
  const open = (): Vault => openVault(key, file);
  const d = {
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

// ---- Output and argv ------------------------------------------------------------

/**
 * Everything the wizard and the installer printed. It is shown only after the
 * test has read the token, with the token and any server value blanked out,
 * so a leak fails the test without reaching the CI log.
 */
let transcript: string[] = [];

async function quietly<T>(work: () => Promise<T>): Promise<{ result: T; out: string }> {
  const start = transcript.length;
  const realLog = console.log;
  const realWrite = process.stderr.write;
  console.log = (...args: unknown[]) => void transcript.push(`${args.map(String).join(" ")}\n`);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    transcript.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await work();
    return { result, out: transcript.slice(start).join("") };
  } finally {
    console.log = realLog;
    process.stderr.write = realWrite;
  }
}

function showTranscript(token: string | null): void {
  let text = transcript.join("").replace(VALUE, "ks-server1-<value>");
  if (token) text = text.replaceAll(token, "<token>");
  transcript = [];
  process.stderr.write(text);
}

/** Every process's full argv on the host (`ps -ww`, never cut to the terminal's width), every 100 ms into a file until stopped. */
function sampleArgv() {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-ssh-argv-"));
  dirs.push(dir);
  const file = join(dir, "argv");
  const proc = Bun.spawn(["sh", "-c", 'while :; do ps -e -ww -o args=; sleep 0.1; done >"$1"', "sh", file], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return {
    /** Stops sampling (again, harmlessly) and returns every sample. */
    async stop(): Promise<string> {
      proc.kill();
      await proc.exited;
      return readFileSync(file, "utf8");
    },
  };
}

// ---- The wizard -----------------------------------------------------------------

/** The network is down for this device's first sync, so the wizard stops after the install. */
const offline: Fetch = async () => {
  throw new Error("offline for this test");
};

async function wizard(d: Device, answers: string[], fetch?: Fetch) {
  const prompter = new ScriptedPrompter(answers);
  const { result: code, out } = await quietly(async () =>
    runWizard(await d.context(), {
      prompter,
      interactive: true,
      deviceName: "ci-laptop",
      timer: fakeTimer,
      // No .local name resolves on a runner; the address is answered below anyway.
      resolves: async () => false,
      ...(fetch ? { fetch } : {}),
    }),
  );
  return { code, out, asked: prompter.asked };
}

/** Sync is on, through the server's address and pin, and the server holds this vault. */
async function expectSynced(d: Device): Promise<void> {
  const config = d.with((v) => loadSync(v, d.key));
  expect(config).not.toBeNull();
  expect(config!.servers).toEqual([ADDRESS]);
  expect(config!.pin).not.toBeNull();
  const client = syncClient({ servers: config!.servers, vaultId: config!.vaultId, deviceId: config!.deviceId, sign: config!.keys.sign, pin: config!.pin });
  expect((await client.health()).version).toBe(VERSION);
  const pulled = await client.pull(0, true);
  expect(pulled.records.length).toBeGreaterThan(0);

  // The answer came over HTTPS from the pinned key: any other key is refused.
  const other = syncClient({ servers: config!.servers, vaultId: config!.vaultId, deviceId: config!.deviceId, sign: config!.keys.sign, pin: randomBytes(32) });
  const refused = await other.health().then(
    () => null,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(SyncHttpError);
  expect((refused as SyncHttpError).code).toBe("pin_mismatch");
}

/** The argv samples show the installer ran and never carried the token or a server value. */
function expectNoSecretInArgv(argv: string, token: string): void {
  expect(argv).toContain("kerstel-server.sh install");
  expect(argv.includes(token)).toBe(false);
  expect(argv.includes("ks-server1-")).toBe(false);
}

async function removeServer(): Promise<{ code: number; out: string }> {
  const prompter = new ScriptedPrompter(["yes", "delete"]);
  const { result: code, out } = await quietly(() => syncServerCommand(["remove"], { prompter, interactive: true }));
  return { code, out };
}

// ---- The tests --------------------------------------------------------------------

let ours = false;

beforeAll(() => {
  if (skip) return;
  if (!MIRROR) throw new Error("KERSTEL_RELEASES_URL must name the release mirror the job serves.");
  if (!hostIsClean()) throw new Error("This host already has a Kerstel server, so the test will not touch it.");
  ours = true;
});

afterAll(() => {
  restoreEnv();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (!ours) return;
  // What a failed test may have left. Each step is harmless when there is nothing to remove.
  run(["docker", "rm", "-f", CONTAINER]);
  run(["docker", "volume", "rm", VOLUME]);
  if (existsSync(UNIT)) {
    run(["sudo", "-n", "systemctl", "disable", "--now", "kerstel-server.service"]);
    run(["sudo", "-n", "rm", "-f", UNIT]);
    run(["sudo", "-n", "systemctl", "daemon-reload"]);
  }
  rmSync(KH, { recursive: true, force: true });
});

describe("the setup wizard over ssh", () => {
  test.skipIf(skip)(
    "installs kerstel-server with Docker, resumes, and removes it",
    async () => {
      const d = device("docker");
      const argv = sampleArgv();
      let token: string | null = null;
      try {
        // The first run installs the server, then can't reach it to sync.
        const first = await wizard(d, ["ssh", HOST, "docker", "self", "127.0.0.1"], offline);
        expect(first.code).toBe(1);
        expect(first.out).toContain("Docker found");
        expect(first.out).toContain(`sync setup again to continue`);
        expect(readInstallRecord()).toMatchObject({ route: "ssh", host: HOST, runtime: "docker", reach: "self", addresses: [ADDRESS], started: true, finished: false });
        expect(d.with((v) => loadSync(v, d.key))).toBeNull();
        const installId = readInstallRecord()!.installId;
        const ids = containerIds();
        expect(ids).toHaveLength(1);
        expect(run(["docker", "inspect", "--format", '{{index .Config.Labels "dev.kerstel.install-id"}}', CONTAINER]).out).toBe(installId);

        // The rerun finds the same container, keeps it, and syncs.
        const again = await wizard(d, ["ssh", HOST, ""]);
        token = tokenOnHost("docker");
        expect(again.code).toBe(0);
        expect(again.asked).toHaveLength(3);
        expect(again.out).toContain("Found the server this device started setting up. Continuing.");
        expect(again.out).toContain("already runs");
        expect(containerIds()).toEqual(ids);
        expect(readInstallRecord()).toMatchObject({ installId, finished: true });
        await expectSynced(d);

        expect(token).not.toBeNull();
        expectNoSecretInArgv(await argv.stop(), token!);
        expect(first.out.includes(token!) || again.out.includes(token!)).toBe(false);
        expect((first.out + again.out).includes("ks-server1-")).toBe(false);

        const removed = await removeServer();
        expect(removed.code).toBe(0);
        expect(removed.out).toContain(`Removed the server from ${HOST}.`);
        expect(containerIds()).toEqual([]);
        expect(volumes()).toEqual([]);
        expect(readInstallRecord()).toBeNull();
      } finally {
        await argv.stop().catch(() => "");
        showTranscript(token ?? tokenOnHost("docker"));
      }
    },
    TIMEOUT,
  );

  test.skipIf(skip)(
    "installs kerstel-server as a systemd service, resumes, and removes it",
    async () => {
      const d = device("service");
      const argv = sampleArgv();
      let token: string | null = null;
      try {
        const first = await wizard(d, ["ssh", HOST, "service", "self", "127.0.0.1"], offline);
        expect(first.code).toBe(1);
        expect(first.out).toContain("Checksum verified.");
        expect(readInstallRecord()).toMatchObject({ runtime: "service", started: true, finished: false });
        const installId = readInstallRecord()!.installId;
        expect(readFileSync(join(KH, "install-id"), "utf8").trim()).toBe(installId);
        expect(unitFiles()).toEqual(["kerstel-server.service"]);
        expect(serviceActive()).toBe(true);
        const pid = mainPid();

        // The rerun leaves the running service alone: same unit, same process.
        const again = await wizard(d, ["ssh", HOST, ""]);
        token = tokenOnHost("service");
        expect(again.code).toBe(0);
        expect(again.asked).toHaveLength(3);
        expect(again.out).toContain("Found the server this device started setting up. Continuing.");
        expect(again.out).toContain("kerstel-server is already running.");
        expect(unitFiles()).toEqual(["kerstel-server.service"]);
        expect(mainPid()).toBe(pid);
        expect(containerIds()).toEqual([]);
        await expectSynced(d);

        expect(token).not.toBeNull();
        expectNoSecretInArgv(await argv.stop(), token!);
        expect(first.out.includes(token!) || again.out.includes(token!)).toBe(false);
        expect((first.out + again.out).includes("ks-server1-")).toBe(false);

        const removed = await removeServer();
        expect(removed.code).toBe(0);
        expect(removed.out).toContain(`Removed the server from ${HOST}.`);
        expect(existsSync(UNIT)).toBe(false);
        expect(serviceActive()).toBe(false);
        expect(existsSync(join(KH, "install-id"))).toBe(false);
        expect(existsSync(join(KH, "enroll-token"))).toBe(false);
        expect(existsSync(join(KH, "kerstel-server.db"))).toBe(false);
        expect(readInstallRecord()).toBeNull();
      } finally {
        await argv.stop().catch(() => "");
        showTranscript(token ?? tokenOnHost("service"));
      }
    },
    TIMEOUT,
  );
});
