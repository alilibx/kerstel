import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../server/src/app";
import { timerEnv, type EnsureResult, type SyncTimer, type TimerStatus } from "../src/sync/timer";
import { openDatabase } from "../../server/src/db";
import { TIMING, newId, signRequest } from "../../server/src/protocol";
import { syncCommand } from "../src/commands/sync";
import type { CliContext } from "../src/context";
import { listBackups } from "../src/init/backup";
import { ScriptedPrompter } from "../src/init/prompts";
import {
  generateDeviceKeys,
  generateSyncKey,
  newPairingSecret,
  openName,
  openPairingAnswer,
  pairingCode,
  pairingConfirmation,
  pairingIdOf,
  parsePairingCode,
  sealPairingAnswer,
  openPayload,
  openSyncKey,
  publicKeyOf,
  recordId,
  sealName,
  sealPayload,
  sealSyncKey,
  verifiedName,
} from "../src/sync/crypto";
import {
  backgroundSyncEnv,
  conflictLine,
  glanceSync,
  leaveSyncNotice,
  syncAfterCommand,
  syncBeforeCommand,
  syncLockPath,
  syncNoticePath,
  takeSyncNotice,
  tryLockSync,
  type SyncGlance,
  readSpawnMarker,
  spawnMarkerPath,
} from "../src/sync/background";
import { SYNC_BACKUP_SCOPE } from "../src/sync/engine";
import { pairingClient, syncClient, type Fetch } from "../src/sync/http";
import { loadSync, saveSync, SYNC_META } from "../src/sync/state";
import { generateDataKey } from "../src/vault/crypto";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { captureLog } from "./helpers/capture-log";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

/** Sync spec §12: the client against the real server, in-process. */

const SERVER = "http://127.0.0.1:8787";
const dirs: string[] = [];
afterEach(() => {
  restoreEnv();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function server() {
  const clock = { t: Date.now() };
  const db = openDatabase(":memory:");
  const app = createApp({ db, version: "test", now: () => clock.t });
  const fetch: Fetch = (request) => app.fetch(request, "127.0.0.1");
  return { app, clock, fetch, db };
}

/** One device: its own home, vault file and data key. */
function device() {
  const home = isolateEnv({ prefix: "sync" });
  dirs.push(home);
  const file = join(home, "vault.db");
  const key = generateDataKey();
  const open = (): Vault => openVault(key, file);
  return {
    home,
    key,
    open,
    context: async () => ({ vault: open(), dataKey: key }) as unknown as CliContext,
    /** Runs `use` with the vault open, then closes it. */
    with<T>(use: (vault: Vault) => T): T {
      const v = open();
      try {
        return use(v);
      } finally {
        v.close();
      }
    },
  };
}

type Device = ReturnType<typeof device>;
type Server = ReturnType<typeof server>;

async function quiet<T>(work: () => Promise<T>): Promise<{ result: T; out: string }> {
  const log = captureLog();
  try {
    const result = await work();
    return { result, out: log.text() };
  } finally {
    log.restore();
  }
}

async function setUp(d: Device, s: Server): Promise<void> {
  const { result } = await quiet(() => syncCommand(["setup", SERVER, "--yes"], { fetch: s.fetch, context: d.context, interactive: false, now: () => (s.clock.t += 1) }));
  expect(result).toBe(0);
}

/** What `add-device` will do (#82): device A signs device B into the vault. */
async function addSecond(a: Device, b: Device, s: Server): Promise<void> {
  const config = a.with((v) => loadSync(v, a.key))!;
  const keys = generateDeviceKeys();
  const deviceId = newId();
  const path = `/v1/vaults/${config.vaultId}/devices`;
  const raw = new TextEncoder().encode(
    JSON.stringify({
      device: {
        id: deviceId,
        signPub: publicKeyOf(keys.sign),
        encPub: publicKeyOf(keys.enc),
        sealedName: sealName(config.syncKey, config.vaultId, deviceId, {
          name: "second",
          platform: "Linux",
          signPub: publicKeyOf(keys.sign),
          encPub: publicKeyOf(keys.enc),
        }),
      },
      epoch: config.epoch,
      sealedKey: sealSyncKey(config.syncKey, publicKeyOf(keys.enc), { vaultId: config.vaultId, deviceId, epoch: config.epoch }),
    }),
  );
  const headers = {
    ...signRequest(config.keys.sign, config.deviceId, "POST", path, raw, (s.clock.t += 1)),
    "content-type": "application/json",
  };
  const res = await s.fetch(new Request(`${SERVER}${path}`, { method: "POST", headers, body: raw }));
  expect(res.status).toBe(201);
  // B opens its own sealed copy of the key, as `join` will.
  const sealed = await syncClient({
    server: SERVER,
    vaultId: config.vaultId,
    deviceId,
    sign: keys.sign,
    fetch: s.fetch,
    now: () => (s.clock.t += 1),
  }).keys();
  const syncKey = openSyncKey(sealed.sealedKey, keys.enc, { vaultId: config.vaultId, deviceId, epoch: sealed.epoch });
  b.with((v) => saveSync(v, b.key, { server: SERVER, vaultId: config.vaultId, deviceId, epoch: sealed.epoch, syncKey, keys, head: 0 }));
}

async function sync(d: Device, s: Server, args: string[] = []): Promise<{ code: number; out: string }> {
  const { result, out } = await quiet(() => syncCommand(args, { fetch: s.fetch, context: d.context, interactive: false, now: () => (s.clock.t += 1) }));
  return { code: result, out };
}

const ref = (scope: string, key: string) => ({ scope, key });

/** A pull timer that records its calls and answers from a script. Never touches launchd or systemd. */
function fakeTimer(o: { ensure?: EnsureResult; status?: TimerStatus } = {}) {
  const calls = { ensure: [] as { rewrite: boolean }[], remove: 0 };
  const timer: SyncTimer = {
    status: () => o.status ?? { state: "installed", kind: "launchd", current: true },
    ensure: (x) => {
      calls.ensure.push(x);
      return o.ensure ?? "unchanged";
    },
    remove: () => {
      calls.remove += 1;
      return true;
    },
  };
  return { timer, calls };
}

describe("crypto", () => {
  test("the sync key opens only for its device, vault and epoch", () => {
    const keys = generateDeviceKeys();
    const syncKey = generateSyncKey();
    const context = { vaultId: newId(), deviceId: newId(), epoch: 1 };
    const sealed = sealSyncKey(syncKey, publicKeyOf(keys.enc), context);
    expect(openSyncKey(sealed, keys.enc, context).equals(syncKey)).toBe(true);
    expect(() => openSyncKey(sealed, keys.enc, { ...context, epoch: 2 })).toThrow();
    expect(() => openSyncKey(sealed, keys.enc, { ...context, deviceId: newId() })).toThrow();
    expect(() => openSyncKey(sealed, generateDeviceKeys().enc, context)).toThrow();
  });

  test("record IDs are stable for one key and change with the key", () => {
    const k = generateSyncKey();
    expect(recordId(k, "app", "A")).toBe(recordId(k, "app", "A"));
    expect(recordId(k, "app", "A")).not.toBe(recordId(k, "app", "B"));
    expect(recordId(k, "app", "A")).not.toBe(recordId(generateSyncKey(), "app", "A"));
    expect(recordId(k, "ap", "pA")).not.toBe(recordId(k, "app", "A"));
  });

  test("payloads are padded to 256 bytes, and a blob moved to another record or epoch fails to open", () => {
    const k = generateSyncKey();
    const context = { vaultId: newId(), recordId: newId(), epoch: 1 };
    const payload = { v: 1 as const, scope: "app", key: "A", value: "x".repeat(10), deleted: false, updatedAt: 1, device: "d" };
    const blob = sealPayload(k, payload, context);
    expect((Buffer.from(blob, "base64url").length - 12 - 16) % 256).toBe(0);
    expect(openPayload(k, blob, context)).toEqual(payload);
    expect(() => openPayload(k, blob, { ...context, recordId: newId() })).toThrow();
    expect(() => openPayload(k, blob, { ...context, epoch: 2 })).toThrow();
  });

  test("device names open only with the sync key and for their device", () => {
    const k = generateSyncKey();
    const v = newId();
    const id = newId();
    const keys = generateDeviceKeys();
    const name = { name: "ali-mbp", platform: "macOS", signPub: publicKeyOf(keys.sign), encPub: publicKeyOf(keys.enc) };
    const sealed = sealName(k, v, id, name);
    expect(openName(k, v, id, sealed)).toEqual(name);
    expect(openName(k, v, newId(), sealed)).toBeNull();
    expect(openName(generateSyncKey(), v, id, sealed)).toBeNull();
    // A listed key that is not the one sealed in the name fails verification.
    const listed = { id, signPub: name.signPub, encPub: name.encPub, sealedName: sealed };
    expect(verifiedName(k, v, listed)).toEqual(name);
    expect(verifiedName(k, v, { ...listed, encPub: publicKeyOf(generateDeviceKeys().enc) })).toBeNull();
  });
});

describe("change tracking", () => {
  test("nothing is tracked until sync is on; then every write marks the key dirty and raises change", () => {
    const d = device();
    d.with((v) => {
      v.setSecret(ref("app", "A"), "1");
      expect(v.sync.rows()).toEqual([]);
      v.setMeta("sync_vault_id", newId());
      v.sync.trackAll();
      expect(v.sync.row(ref("app", "A"))).toMatchObject({ baseRev: 0, dirty: true, change: 1 });
      v.setSecret(ref("app", "A"), "2");
      expect(v.sync.row(ref("app", "A"))!.change).toBe(2);
      // A push that read change 2 clears dirty; one that read 1 does not.
      v.sync.adopt(ref("app", "A"), 5, 1);
      expect(v.sync.row(ref("app", "A"))).toMatchObject({ baseRev: 5, dirty: true });
      v.sync.adopt(ref("app", "A"), 6, 2);
      expect(v.sync.row(ref("app", "A"))).toMatchObject({ baseRev: 6, dirty: false });
      expect(v.removeSecret(ref("app", "A"))).toBe(true);
      expect(v.sync.row(ref("app", "A"))).toMatchObject({ dirty: true, change: 3 });
      // Removing nothing changes nothing.
      expect(v.removeSecret(ref("app", "NONE"))).toBe(false);
      expect(v.sync.row(ref("app", "NONE"))).toBeNull();
    });
  });
});

describe("one device and the server", () => {
  test("setup uploads every secret; status and devices report it; nothing printed holds a value", async () => {
    const s = server();
    const a = device();
    a.with((v) => {
      v.setSecret(ref("global", "OPENAI_API_KEY"), "sk-sync-value-1");
      v.setSecret(ref("app", "DB"), "db-sync-value-2");
    });
    const { out } = await quiet(() => syncCommand(["setup", SERVER, "--yes"], { fetch: s.fetch, context: a.context, interactive: false, now: () => (s.clock.t += 1) }));
    expect(out).toContain("2 secrets in 2 scopes");
    expect(out).toContain("Synced 2 secrets.");
    expect(a.with((v) => v.sync.rows().every((r) => !r.dirty && r.baseRev > 0))).toBe(true);

    const status = await sync(a, s, ["status"]);
    expect(status.out).toContain(`Server        ${SERVER}`);
    expect(status.out).toContain("Pending       0 changes to push");
    const list = await sync(a, s, ["devices"]);
    expect(list.out).toContain("this device");
    for (const out of [status.out, list.out]) {
      expect(out).not.toContain("sk-sync-value-1");
      expect(out).not.toContain("db-sync-value-2");
    }
    // Setting up twice is refused.
    expect((await sync(a, s, ["setup", SERVER, "--yes"])).code).toBe(1);
  });

  test("a server URL must be https, or http to this machine", async () => {
    const s = server();
    const a = device();
    expect((await sync(a, s, ["setup", "http://sync.example.com", "--yes"])).code).toBe(2);
    expect((await sync(a, s, ["setup", "https://user:pw@sync.example.com", "--yes"])).code).toBe(2);
  });

  test("setup without a terminal or --yes asks for --yes and uploads nothing", async () => {
    const s = server();
    const a = device();
    expect((await sync(a, s, ["setup", SERVER])).code).toBe(2);
    expect(a.with((v) => loadSync(v, a.key))).toBeNull();
  });

  test("sync off leaves the vault, and refuses on its last device unless asked to delete the vault", async () => {
    const s = server();
    const a = device();
    a.with((v) => v.setSecret(ref("app", "A"), "1"));
    await setUp(a, s);
    const refused = await sync(a, s, ["off"]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("last device");
    const gone = await sync(a, s, ["off", "--delete-vault"]);
    expect(gone.code).toBe(0);
    expect(a.with((v) => [loadSync(v, a.key), v.sync.rows(), v.getSecret(ref("app", "A"))])).toEqual([null, [], "1"]);
  });

  test("sync off records a device row", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    const before = a.with((v) => v.listAudit({ limit: 100, events: ["device"] }).length);
    expect((await sync(a, s, ["off", "--delete-vault"])).code).toBe(0);
    expect(a.with((v) => v.listAudit({ limit: 100, events: ["device"] }).length)).toBe(before + 1);
  });
});

describe("two devices", () => {
  async function pair() {
    const s = server();
    const a = device();
    const b = device();
    a.with((v) => v.setSecret(ref("app", "DB"), "db-a-1"));
    await setUp(a, s);
    await addSecond(a, b, s);
    return { s, a, b };
  }

  test("values, changes and deletions travel both ways; a replaced value is backed up", async () => {
    const { s, a, b } = await pair();
    expect((await sync(b, s)).out).toContain("Pulled 1 change");
    expect(b.with((v) => v.getSecret(ref("app", "DB")))).toBe("db-a-1");

    b.with((v) => v.setSecret(ref("app", "DB"), "db-b-2"));
    b.with((v) => v.setSecret(ref("global", "NEW"), "new-b-3"));
    expect((await sync(b, s)).out).toContain("Pushed 2 changes");
    const pulled = await sync(a, s);
    expect(pulled.out).toContain("Pulled 2 changes");
    expect(a.with((v) => [v.getSecret(ref("app", "DB")), v.getSecret(ref("global", "NEW"))])).toEqual(["db-b-2", "new-b-3"]);

    // The value a pull replaced on A is in A's sync backup.
    const backups = listBackups(SYNC_BACKUP_SCOPE);
    expect(backups.length).toBeGreaterThan(0);

    a.with((v) => v.removeSecret(ref("global", "NEW")));
    await sync(a, s);
    await sync(b, s);
    expect(b.with((v) => v.getSecret(ref("global", "NEW")))).toBeNull();
    for (const out of [pulled.out]) expect(out).not.toContain("db-b-2");
  });

  test("a key changed on both devices is a conflict: kept, never chosen, until settled", async () => {
    const { s, a, b } = await pair();
    await sync(b, s);
    a.with((v) => v.setSecret(ref("app", "DB"), "db-a-2"));
    await sync(a, s);
    b.with((v) => v.setSecret(ref("app", "DB"), "db-b-2"));
    const first = await sync(b, s);
    expect(first.code).toBe(1);
    expect(first.out).toContain("ks:app/DB");
    expect(first.out).not.toContain("db-a-2");
    expect(first.out).not.toContain("db-b-2");
    // B keeps its own value and does not push it.
    expect(b.with((v) => v.getSecret(ref("app", "DB")))).toBe("db-b-2");
    expect(b.with((v) => v.sync.row(ref("app", "DB"))!.conflict)).not.toBeNull();

    // --keep remote takes A's value; B's goes to the backup.
    const settled = await sync(b, s, ["--keep", "remote"]);
    expect(settled.code).toBe(0);
    expect(b.with((v) => v.getSecret(ref("app", "DB")))).toBe("db-a-2");
    expect(b.with((v) => v.sync.row(ref("app", "DB"))!.conflict)).toBeNull();
  });

  test("keeping this device's value pushes it over the other one", async () => {
    const { s, a, b } = await pair();
    await sync(b, s);
    a.with((v) => v.setSecret(ref("app", "DB"), "db-a-2"));
    await sync(a, s);
    b.with((v) => v.setSecret(ref("app", "DB"), "db-b-2"));
    await sync(b, s);
    expect((await sync(b, s, ["--keep", "local"])).code).toBe(0);
    await sync(a, s);
    expect(a.with((v) => v.getSecret(ref("app", "DB")))).toBe("db-b-2");
  });

  test("in a terminal, each conflict is a question that names only lengths", async () => {
    const { s, a, b } = await pair();
    await sync(b, s);
    a.with((v) => v.setSecret(ref("app", "DB"), "aaaa"));
    await sync(a, s);
    b.with((v) => v.setSecret(ref("app", "DB"), "bbbbbbb"));
    const prompter = new ScriptedPrompter(["remote"]);
    const { result } = await quiet(() =>
      syncCommand([], { fetch: s.fetch, context: b.context, interactive: true, prompter, now: () => (s.clock.t += 1) }),
    );
    expect(result).toBe(0);
    expect(prompter.asked[0]).toContain("DB");
    expect(prompter.asked.join("\n")).not.toContain("aaaa");
    expect(b.with((v) => v.getSecret(ref("app", "DB")))).toBe("aaaa");
  });

  describe("audit rows for what a conflict shows", () => {
    const reveals = (d: Device) => d.with((v) => v.listAudit(100).filter((r) => r.event === "reveal"));

    async function conflicted(bValue: string | null = "bbbbbbb") {
      const { s, a, b } = await pair();
      await sync(b, s);
      a.with((v) => v.setSecret(ref("app", "DB"), "aaaa"));
      await sync(a, s);
      b.with((v) => (bValue === null ? v.removeSecret(ref("app", "DB")) : v.setSecret(ref("app", "DB"), bValue)));
      return { s, b };
    }
    const settle = (s: Server, b: Device, reveal: boolean) =>
      quiet(() =>
        syncCommand(reveal ? ["--reveal"] : [], {
          fetch: s.fetch,
          context: b.context,
          interactive: true,
          prompter: new ScriptedPrompter(["remote"]),
          now: () => (s.clock.t += 1),
        }),
      );

    test("settling with --reveal writes one reveal row per conflict", async () => {
      const { s, b } = await conflicted();
      const { out } = await settle(s, b, true);
      expect(out).not.toContain("aaaa");
      expect(reveals(b).map((r) => [r.scope, r.key])).toEqual([["app", "DB"]]);
    });

    test("keeping the other device's revealed value moves the reveal past the write, so the rotation hint still sees it", async () => {
      const { s, b } = await conflicted();
      await settle(s, b, true);
      const [row] = reveals(b);
      const stored = b.with((v) => v.listSecrets("app").find((x) => x.key === "DB"))!;
      expect(b.with((v) => v.getSecret(ref("app", "DB")))).toBe("aaaa");
      expect(row!.ts).toBeGreaterThanOrEqual(stored.updatedAt);
    });

    test("rows exist even when the prompt is aborted after the values were shown", async () => {
      const { s, b } = await conflicted();
      const aborted = quiet(() =>
        syncCommand(["--reveal"], {
          fetch: s.fetch,
          context: b.context,
          interactive: true,
          prompter: new ScriptedPrompter([]),
          now: () => (s.clock.t += 1),
        }),
      );
      await expect(aborted).rejects.toThrow();
      expect(reveals(b)).toHaveLength(1);
    });

    test("without --reveal it writes none", async () => {
      const { s, b } = await conflicted();
      await settle(s, b, false);
      expect(reveals(b)).toEqual([]);
    });

    test("a deleted side prints no value and writes no reveal row for it", async () => {
      const { s, b } = await conflicted(null);
      await settle(s, b, true);
      // Only the other device's value was printed.
      expect(reveals(b).map((r) => [r.scope, r.key])).toEqual([["app", "DB"]]);
    });
  });

  test("a key written while its push is in flight stays dirty, and the next push sends the newer value", async () => {
    const { s, a, b } = await pair();
    await sync(b, s);
    a.with((v) => v.setSecret(ref("app", "DB"), "db-a-2"));
    const racing: Fetch = async (request) => {
      if (request.method === "POST" && request.url.endsWith("/records")) {
        a.with((v) => v.setSecret(ref("app", "DB"), "db-a-3"));
      }
      return s.fetch(request);
    };
    await quiet(() => syncCommand([], { fetch: racing, context: a.context, interactive: false, now: () => (s.clock.t += 1) }));
    expect(a.with((v) => v.sync.row(ref("app", "DB"))!.dirty)).toBe(true);
    await sync(a, s);
    await sync(b, s);
    expect(b.with((v) => v.getSecret(ref("app", "DB")))).toBe("db-a-3");
  });

  test("a device behind the tombstone window does a full pull and still sees the deletion", async () => {
    const { s, a, b } = await pair();
    a.with((v) => v.setSecret(ref("app", "GONE"), "gone-1"));
    await sync(a, s);
    await sync(b, s);
    expect(b.with((v) => v.getSecret(ref("app", "GONE")))).toBe("gone-1");
    a.with((v) => v.removeSecret(ref("app", "GONE")));
    a.with((v) => v.setSecret(ref("app", "LATER"), "later-2"));
    await sync(a, s);
    // The server drops the tombstone; B never saw it.
    s.clock.t += TIMING.tombstoneTtlMs + 1;
    s.app.maintain();
    a.with((v) => v.setSecret(ref("app", "AFTER"), "after-3"));
    await sync(a, s);
    const out = await sync(b, s);
    expect(out.code).toBe(0);
    expect(b.with((v) => [v.getSecret(ref("app", "GONE")), v.getSecret(ref("app", "AFTER"))])).toEqual([null, "after-3"]);
  });
});

test("without sync on, every sync command says how to turn it on", async () => {
  const s = server();
  const a = device();
  expect((await sync(a, s)).out).toContain("Sync is off for this vault");
  expect((await sync(a, s, ["status"])).code).toBe(0);
  expect((await sync(a, s, ["nope"])).code).toBe(2);
  expect(existsSync(join(a.home, "backups"))).toBe(false);
});

test("uninstall names a value that only a sync backup still holds", async () => {
  const { createBackup } = await import("../src/init/backup");
  const { planUninstall } = await import("../src/uninstall/plan");
  const a = device();
  createBackup({ scope: SYNC_BACKUP_SCOPE, dataKey: a.key, files: [], vault: [{ scope: "app", key: "LOST", value: "lost-value-9" }] });
  const plan = a.with((v) => planUninstall(v, a.key));
  expect(plan.backupOnly.map((b) => [b.project, b.key])).toContainEqual([SYNC_BACKUP_SCOPE, "LOST"]);
});

describe("review fixes", () => {
  async function pair() {
    const s = server();
    const a = device();
    const b = device();
    a.with((v) => v.setSecret(ref("app", "DB"), "db-a-1"));
    await setUp(a, s);
    await addSecond(a, b, s);
    await sync(b, s);
    return { s, a, b };
  }

  /** What `remove-device` will do (#82), minus the removal: device A replaces the sync key. */
  async function rotate(a: Device, s: Server): Promise<void> {
    const config = a.with((v) => loadSync(v, a.key))!;
    const client = syncClient({ server: SERVER, vaultId: config.vaultId, deviceId: config.deviceId, sign: config.keys.sign, fetch: s.fetch, now: () => (s.clock.t += 1) });
    const page = await client.pull(0, true);
    const newKey = generateSyncKey();
    const epoch = config.epoch + 1;
    const records = page.records.flatMap((r) => {
      if (r.blob === null) return [];
      const p = openPayload(config.syncKey, r.blob, { vaultId: config.vaultId, recordId: r.id, epoch: config.epoch });
      const id = recordId(newKey, p.scope, p.key);
      return [{ id, blob: sealPayload(newKey, p, { vaultId: config.vaultId, recordId: id, epoch }) }];
    });
    const devices = (await client.devices()).devices;
    const sealedKeys = Object.fromEntries(
      devices.map((d) => [d.id, sealSyncKey(newKey, d.encPub, { vaultId: config.vaultId, deviceId: d.id, epoch })]),
    );
    const sealedNames = Object.fromEntries(
      devices.map((d) => [d.id, sealName(newKey, config.vaultId, d.id, openName(config.syncKey, config.vaultId, d.id, d.sealedName)!)]),
    );
    const path = `/v1/vaults/${config.vaultId}/epochs`;
    const raw = new TextEncoder().encode(
      JSON.stringify({ baseRevision: page.head, epoch, removeDevices: [], sealedKeys, sealedNames, records }),
    );
    const res = await s.fetch(
      new Request(`${SERVER}${path}`, {
        method: "POST",
        headers: { ...signRequest(config.keys.sign, config.deviceId, "POST", path, raw, (s.clock.t += 1)), "content-type": "application/json" },
        body: raw,
      }),
    );
    expect(res.status).toBe(200);
    a.with((v) => saveSync(v, a.key, { ...config, syncKey: newKey, epoch }));
  }

  test("a redirect is never followed, so the enroll token and signature go nowhere else", async () => {
    const a = device();
    a.with((v) => v.setSecret(ref("app", "A"), "1"));
    const seen: string[] = [];
    const redirecting: Fetch = async (request) => {
      seen.push(request.redirect);
      return new Response(null, { status: 307, headers: { location: "http://evil.example/v1/vaults" } });
    };
    process.env.KERSTEL_SYNC_ENROLL_TOKEN = "enroll-secret";
    try {
      const { result, out } = await quiet(() =>
        syncCommand(["setup", SERVER, "--yes"], { fetch: redirecting, context: a.context, interactive: false }),
      );
      expect(result).toBe(1);
      expect(out).toContain("redirect");
      expect(seen).toEqual(["manual"]);
    } finally {
      delete process.env.KERSTEL_SYNC_ENROLL_TOKEN;
    }
  });

  test("an edit made while the other device's deletion expired becomes a conflict, not a stuck key", async () => {
    const { s, a, b } = await pair();
    a.with((v) => v.removeSecret(ref("app", "DB")));
    await sync(a, s);
    // B edits offline; the tombstone expires before B syncs.
    b.with((v) => v.setSecret(ref("app", "DB"), "db-b-offline"));
    s.clock.t += TIMING.tombstoneTtlMs + 1;
    s.app.maintain();
    a.with((v) => v.setSecret(ref("app", "OTHER"), "o"));
    await sync(a, s);
    const out = await sync(b, s);
    expect(out.code).toBe(1);
    expect(out.out).toContain("ks:app/DB");
    expect(b.with((v) => v.sync.row(ref("app", "DB"))!.conflict)).toEqual({ rev: 0, blob: null });
    // Keeping B's value brings the key back for both.
    expect((await sync(b, s, ["--keep", "local"])).code).toBe(0);
    await sync(a, s);
    expect(a.with((v) => v.getSecret(ref("app", "DB")))).toBe("db-b-offline");
  });

  test("after a rotation elsewhere: a deletion made before it reaches this device, and an open conflict stays readable", async () => {
    const { s, a, b } = await pair();
    a.with((v) => v.setSecret(ref("app", "GONE"), "gone-1"));
    a.with((v) => v.setSecret(ref("app", "BOTH"), "both-1"));
    await sync(a, s);
    await sync(b, s);
    // A conflict opens on B for BOTH.
    a.with((v) => v.setSecret(ref("app", "BOTH"), "both-a"));
    await sync(a, s);
    b.with((v) => v.setSecret(ref("app", "BOTH"), "both-b"));
    expect((await sync(b, s)).code).toBe(1);
    // A deletes GONE, then rotates: the new epoch has no record for GONE at all.
    a.with((v) => v.removeSecret(ref("app", "GONE")));
    await sync(a, s);
    await rotate(a, s);

    const out = await sync(b, s, ["--keep", "remote"]);
    expect(out.code).toBe(0);
    expect(b.with((v) => v.getSecret(ref("app", "GONE")))).toBeNull();
    expect(b.with((v) => v.getSecret(ref("app", "BOTH")))).toBe("both-a");
    expect(b.with((v) => loadSync(v, b.key)!.epoch)).toBe(2);
    // And it keeps syncing under the new key.
    b.with((v) => v.setSecret(ref("app", "NEW"), "new-b"));
    await sync(b, s);
    await sync(a, s);
    expect(a.with((v) => v.getSecret(ref("app", "NEW")))).toBe("new-b");
  });

  test("a conflict that reopens while you choose is reported, not called success", async () => {
    const { s, a, b } = await pair();
    a.with((v) => v.setSecret(ref("app", "DB"), "db-a-2"));
    await sync(a, s);
    b.with((v) => v.setSecret(ref("app", "DB"), "db-b-2"));
    await sync(b, s);
    let raced = false;
    const racing: Fetch = async (request) => {
      if (!raced && request.method === "POST" && request.url.endsWith("/records")) {
        raced = true;
        a.with((v) => v.setSecret(ref("app", "DB"), "db-a-3"));
        await sync(a, s);
      }
      return s.fetch(request);
    };
    const { result, out } = await quiet(() =>
      syncCommand(["--keep", "local"], { fetch: racing, context: b.context, interactive: false, now: () => (s.clock.t += 1) }),
    );
    expect(result).toBe(1);
    expect(out).toContain("changed on another device again");
  });

  test("settling several conflicts writes one backup holding every losing value", async () => {
    const { s, a, b } = await pair();
    a.with((v) => v.setSecret(ref("app", "X"), "x-1"));
    a.with((v) => v.setSecret(ref("app", "Y"), "y-1"));
    await sync(a, s);
    await sync(b, s);
    a.with((v) => {
      v.setSecret(ref("app", "X"), "x-a");
      v.setSecret(ref("app", "Y"), "y-a");
    });
    await sync(a, s);
    b.with((v) => {
      v.setSecret(ref("app", "X"), "x-b");
      v.setSecret(ref("app", "Y"), "y-b");
    });
    await sync(b, s);
    const before = listBackups(SYNC_BACKUP_SCOPE).length;
    expect((await sync(b, s, ["--keep", "remote"])).code).toBe(0);
    const after = listBackups(SYNC_BACKUP_SCOPE);
    expect(after.length).toBe(before + 1);
    const { readBackupVault } = await import("../src/init/backup");
    const saved = b.with(() => readBackupVault(SYNC_BACKUP_SCOPE, after.at(-1)!, b.key));
    expect(saved.map((v) => [v.key, v.value]).sort()).toEqual([["X", "x-b"], ["Y", "y-b"]]);
  });
});

describe("pairing crypto", () => {
  test("a pairing code round-trips, forgives case, dashes and misread letters, and refuses anything else", () => {
    const secret = newPairingSecret();
    const code = pairingCode(secret);
    expect(code).toMatch(/^KS-([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(parsePairingCode(code)!.equals(secret)).toBe(true);
    expect(parsePairingCode(` ${code.toLowerCase().replace(/-/g, "")} `)!.equals(secret)).toBe(true);
    expect(parsePairingCode(code.replace(/0/g, "O").replace(/1/g, "I"))!.equals(secret)).toBe(true);
    expect(parsePairingCode(code.slice(0, -1))).toBeNull();
    expect(parsePairingCode(`${code.slice(0, -1)}U`)).toBeNull();
    expect(parsePairingCode("KS-hello")).toBeNull();
    // The slot's ID comes from the secret, and tells nothing about it.
    expect(pairingIdOf(secret)).toBe(pairingIdOf(Buffer.from(secret)));
    expect(pairingIdOf(secret)).not.toBe(pairingIdOf(newPairingSecret()));
  });

  test("a pairing answer opens only with its own secret; the confirmation binds the sealed key", () => {
    const secret = newPairingSecret();
    const answer = { v: 1 as const, deviceId: newId(), signPub: "s", encPub: "e", name: "laptop", platform: "Linux" };
    const sealed = sealPairingAnswer(secret, answer);
    expect((Buffer.from(sealed, "base64url").length - 12 - 16) % 256).toBe(0);
    expect(openPairingAnswer(secret, sealed)).toEqual(answer);
    expect(openPairingAnswer(newPairingSecret(), sealed)).toBeNull();
    const c = { vaultId: newId(), deviceId: answer.deviceId, epoch: 1, sealedKey: "abc" };
    expect(pairingConfirmation(secret, c)).toBe(pairingConfirmation(secret, c));
    expect(pairingConfirmation(secret, { ...c, sealedKey: "abd" })).not.toBe(pairingConfirmation(secret, c));
    expect(pairingConfirmation(newPairingSecret(), c)).not.toBe(pairingConfirmation(secret, c));
  });
});

describe("pairing, joining and removing devices", () => {
  const tick = (s: Server) => () => (s.clock.t += 1);
  /** Pairing waits move the server's clock, so codes age and rate limits refill as they would. */
  const sleeper = (s: Server) => async () => {
    s.clock.t += 3_000;
    await Bun.sleep(1);
  };

  /** `add-device` on `a` and `join` on `b`, side by side, as two terminals would run them. */
  async function pairUp(
    a: Device,
    b: Device,
    s: Server,
    options: { answer?: "yes" | "no"; joinFetch?: Fetch; aName?: string; bName?: string; joinTimer?: SyncTimer } = {},
  ) {
    const log = captureLog();
    try {
      const prompter = new ScriptedPrompter([options.answer ?? "yes"]);
      const adding = syncCommand(["add-device"], {
        fetch: s.fetch,
        context: a.context,
        interactive: true,
        prompter,
        now: tick(s),
        sleep: sleeper(s),
      });
      let code: string | undefined;
      for (let i = 0; i < 500 && !code; i += 1) {
        await Bun.sleep(1);
        code = log.text().match(/KS-[0-9A-Z-]{29}/)?.[0];
      }
      expect(code).toBeDefined();
      const joining = syncCommand(["join", SERVER, code!], {
        fetch: options.joinFetch ?? s.fetch,
        context: b.context,
        interactive: false,
        now: tick(s),
        sleep: sleeper(s),
        deviceName: options.bName ?? "second",
        timer: options.joinTimer,
      });
      const [added, joined] = await Promise.all([adding, joining]);
      return { added, joined, out: log.text(), asked: prompter.asked };
    } finally {
      log.restore();
    }
  }

  async function syncedDevice(s: Server, secrets: Record<string, string> = {}): Promise<Device> {
    const a = device();
    a.with((v) => {
      for (const [k, value] of Object.entries(secrets)) v.setSecret(ref("app", k), value);
    });
    const { result } = await quiet(() =>
      syncCommand(["setup", SERVER, "--yes"], { fetch: s.fetch, context: a.context, interactive: false, now: tick(s), deviceName: "first" }),
    );
    expect(result).toBe(0);
    return a;
  }

  test("add-device and join pair a device; it pulls the vault and merges its own secrets in", async () => {
    const s = server();
    const a = await syncedDevice(s, { DB: "db-pair-1", SHARED: "same-value" });
    const b = device();
    b.with((v) => {
      v.setSecret(ref("other", "ONLY_B"), "b-only-value");
      v.setSecret(ref("app", "SHARED"), "same-value");
    });
    const { added, joined, out, asked } = await pairUp(a, b, s);
    expect([added, joined]).toEqual([0, 0]);
    expect(asked).toEqual(["Add it? It will be able to read every secret in this vault."]);
    expect(out).toContain("New device: second");
    // Both sides show the same fingerprint, for the person pairing to compare.
    const fingerprints = [...out.matchAll(/key fingerprint ([0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4})/g)].map((m) => m[1]);
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).toBe(fingerprints[1]!);
    for (const value of ["db-pair-1", "same-value", "b-only-value"]) expect(out).not.toContain(value);

    expect(b.with((v) => [v.getSecret(ref("app", "DB")), v.getSecret(ref("app", "SHARED"))])).toEqual(["db-pair-1", "same-value"]);
    expect(b.with((v) => v.sync.rows().filter((r) => r.dirty || r.conflict))).toEqual([]);
    expect((await sync(a, s)).code).toBe(0);
    expect(a.with((v) => v.getSecret(ref("other", "ONLY_B")))).toBe("b-only-value");
    const devices = await sync(a, s, ["devices"]);
    expect(devices.out).toContain("second (");
    expect(devices.out).toContain("first (");
    // A code works once.
    const again = await sync(device(), s, ["join", SERVER, out.match(/KS-[0-9A-Z-]{29}/)![0]]);
    expect(again.code).toBe(1);
  });

  test("join schedules pulls", async () => {
    const s = server();
    const a = await syncedDevice(s, { DB: "db-1" });
    const b = device();
    const fake = fakeTimer({ ensure: "installed" });
    const { joined, out } = await pairUp(a, b, s, { joinTimer: fake.timer });
    expect(joined).toBe(0);
    expect(fake.calls.ensure).toEqual([{ rewrite: true }]);
    expect(out).toContain("Pulls changes every five minutes on its own.");
  });

  test("add-device, join, and remove-device each write one device row", async () => {
    const s = server();
    const a = await syncedDevice(s, { DB: "db-1" });
    const b = device();
    expect((await pairUp(a, b, s, { bName: "laptop" })).joined).toBe(0);
    const devices = (d: Device) => d.with((v) => v.listAudit(100).filter((r) => r.event === "device"));
    expect(devices(a)).toHaveLength(1);
    expect(devices(b)).toHaveLength(1);
    expect(devices(a)[0]).toMatchObject({ scope: "", key: "" });
    expect((await sync(a, s, ["remove-device", "laptop"])).code).toBe(0);
    expect(devices(a)).toHaveLength(2);
    expect(devices(b)).toHaveLength(1);
  });

  test("a key both vaults hold with different values is a conflict on join, never overwritten", async () => {
    const s = server();
    const a = await syncedDevice(s, { DB: "db-from-a" });
    const b = device();
    b.with((v) => v.setSecret(ref("app", "DB"), "db-from-b"));
    const { added, joined, out } = await pairUp(a, b, s);
    expect([added, joined]).toEqual([0, 1]);
    expect(out).toContain("app/DB");
    expect(b.with((v) => v.getSecret(ref("app", "DB")))).toBe("db-from-b");
    expect(b.with((v) => v.sync.row(ref("app", "DB"))!.conflict)).not.toBeNull();
    expect(a.with((v) => v.getSecret(ref("app", "DB")))).toBe("db-from-a");
  });

  test("saying no adds nothing, and the new device stops waiting", async () => {
    const s = server();
    const a = await syncedDevice(s, { DB: "db-1" });
    const b = device();
    const { added, joined, out } = await pairUp(a, b, s, { answer: "no" });
    expect([added, joined]).toEqual([0, 1]);
    expect(out).toContain("the other device said no");
    expect(b.with((v) => loadSync(v, b.key))).toBeNull();
    expect((await sync(a, s, ["devices"])).out.split("\n").filter((l) => l.includes("added"))).toHaveLength(1);
  });

  test("add-device needs a terminal, and join refuses a bad code or URL", async () => {
    const s = server();
    const a = await syncedDevice(s);
    expect((await sync(a, s, ["add-device"])).code).toBe(2);
    const b = device();
    expect((await sync(b, s, ["join", SERVER, "KS-NOPE"])).code).toBe(2);
    expect((await sync(b, s, ["join", "http://sync.example.com", pairingCode(newPairingSecret())])).code).toBe(2);
    // A well-formed code with no slot behind it.
    expect((await sync(b, s, ["join", SERVER, pairingCode(newPairingSecret())])).code).toBe(1);
    expect(b.with((v) => loadSync(v, b.key))).toBeNull();
  });

  test("an answer sealed without the code's secret is refused before anyone is asked", async () => {
    const s = server();
    const a = await syncedDevice(s);
    const log = captureLog();
    try {
      const prompter = new ScriptedPrompter([]);
      const adding = syncCommand(["add-device"], { fetch: s.fetch, context: a.context, interactive: true, prompter, now: tick(s), sleep: sleeper(s) });
      let code: string | undefined;
      for (let i = 0; i < 500 && !code; i += 1) {
        await Bun.sleep(1);
        code = log.text().match(/KS-[0-9A-Z-]{29}/)?.[0];
      }
      // The server, which sees the slot's ID but not the secret, answers it itself.
      const forged = sealPairingAnswer(newPairingSecret(), {
        v: 1,
        deviceId: newId(),
        signPub: publicKeyOf(generateDeviceKeys().sign),
        encPub: publicKeyOf(generateDeviceKeys().enc),
        name: "forged",
        platform: "Linux",
      });
      await pairingClient(SERVER, s.fetch).answer(pairingIdOf(parsePairingCode(code!)!), forged);
      expect(await adding).toBe(1);
      expect(prompter.asked).toEqual([]);
      expect(log.text()).toContain("without this code's secret");
    } finally {
      log.restore();
    }
  });

  test("a sync key the server sealed itself fails the confirmation, and the device does not join", async () => {
    const s = server();
    const a = await syncedDevice(s, { DB: "db-1" });
    const b = device();
    b.with((v) => v.setSecret(ref("app", "MINE"), "b-secret-never-uploaded"));
    // A hostile server: it hands the joining device a key of its own, sealed to the device's real public key.
    const hostile: Fetch = async (request) => {
      const response = await s.fetch(request);
      const url = new URL(request.url);
      if (request.method !== "GET" || !url.pathname.endsWith("/keys") || response.status !== 200) return response;
      const body = (await response.json()) as { epoch: number; sealedKey: string };
      const deviceId = request.headers.get("kerstel-device")!;
      const vaultId = url.pathname.split("/")[3]!;
      const encPub = (s.db.query("SELECT enc_pub FROM devices WHERE id = ?").get(deviceId) as { enc_pub: string }).enc_pub;
      const sealedKey = sealSyncKey(generateSyncKey(), encPub, { vaultId, deviceId, epoch: body.epoch });
      return Response.json({ epoch: body.epoch, sealedKey });
    };
    const { added, joined, out } = await pairUp(a, b, s, { joinFetch: hostile });
    expect([added, joined]).toEqual([0, 1]);
    expect(out).toContain("not the one the other device confirmed");
    expect(b.with((v) => [loadSync(v, b.key), v.sync.rows()])).toEqual([null, []]);
    // Nothing of B's reached the server.
    const records = s.db.query("SELECT COUNT(*) AS n FROM records").get() as { n: number };
    expect(records.n).toBe(1);
  });

  test("remove-device replaces the key: the removed device is locked out, the rest keep syncing", async () => {
    const s = server();
    const a = await syncedDevice(s, { DB: "db-1", GONE: "gone-1" });
    const b = device();
    const c = device();
    expect((await pairUp(a, b, s, { bName: "laptop" })).joined).toBe(0);
    expect((await pairUp(a, c, s, { bName: "old-phone" })).joined).toBe(0);
    await sync(b, s);
    // A change on A not pushed yet, and a deletion pushed before the rotation.
    a.with((v) => v.removeSecret(ref("app", "GONE")));
    await sync(a, s);
    a.with((v) => v.setSecret(ref("app", "DB"), "db-2"));

    expect((await sync(a, s, ["remove-device", "nobody"])).code).toBe(1);
    expect((await sync(a, s, ["remove-device", "first"])).out).toContain("That is this device");
    const removed = await sync(a, s, ["remove-device", "old-phone"]);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain("Rotate any secret it should no longer hold");
    expect(removed.out).not.toContain("db-");

    // C's requests are refused now; its values stay on C.
    const locked = await sync(c, s);
    expect(locked.code).toBe(1);
    expect(locked.out).toContain("no longer knows this device");
    expect(c.with((v) => v.getSecret(ref("app", "DB")))).toBe("db-1");
    // It can still turn sync off, and keeps its secrets.
    expect((await sync(c, s, ["off"])).code).toBe(0);
    expect(c.with((v) => [loadSync(v, c.key), v.getSecret(ref("app", "DB"))])).toEqual([null, "db-1"]);

    // Before B syncs, the new names are sealed with a key it does not have yet: that is not a mismatch.
    const stale = (await sync(b, s, ["devices"])).out;
    expect(stale).toContain("name sealed with a newer key");
    expect(stale).not.toContain("unverified");

    // B adopts the new key and sees both the pushed change and the deletion.
    expect((await sync(b, s)).code).toBe(0);
    expect(b.with((v) => [v.getSecret(ref("app", "DB")), v.getSecret(ref("app", "GONE"))])).toEqual(["db-2", null]);
    b.with((v) => v.setSecret(ref("app", "NEW"), "new-1"));
    await sync(b, s);
    expect((await sync(a, s)).code).toBe(0);
    expect(a.with((v) => v.getSecret(ref("app", "NEW")))).toBe("new-1");
    const names = (await sync(b, s, ["devices"])).out;
    expect(names).toContain("first (");
    expect(names).toContain("laptop (");
    expect(names).not.toContain("old-phone");
  });

  test("a rotation that another device's push overtakes is prepared again, and keeps that push", async () => {
    const s = server();
    const a = await syncedDevice(s, { DB: "db-1" });
    const b = device();
    const c = device();
    await pairUp(a, b, s, { bName: "laptop" });
    await pairUp(a, c, s, { bName: "old-phone" });
    let raced = false;
    const racing: Fetch = async (request) => {
      if (!raced && request.method === "POST" && new URL(request.url).pathname.endsWith("/epochs")) {
        raced = true;
        b.with((v) => v.setSecret(ref("app", "RACE"), "race-1"));
        expect((await sync(b, s)).code).toBe(0);
      }
      return s.fetch(request);
    };
    const { result } = await quiet(() =>
      syncCommand(["remove-device", "old-phone"], { fetch: racing, context: a.context, interactive: false, now: tick(s) }),
    );
    expect(result).toBe(0);
    expect(raced).toBe(true);
    expect(a.with((v) => v.getSecret(ref("app", "RACE")))).toBe("race-1");
    expect((await sync(b, s)).code).toBe(0);
    expect(b.with((v) => v.getSecret(ref("app", "RACE")))).toBe("race-1");
  });

  test("a rotation refuses a device key the server swapped in, and sends nothing", async () => {
    const s = server();
    const a = await syncedDevice(s, { DB: "db-1" });
    const b = device();
    const c = device();
    await pairUp(a, b, s, { bName: "laptop" });
    await pairUp(a, c, s, { bName: "old-phone" });
    const serverKey = publicKeyOf(generateDeviceKeys().enc);
    let rotated = false;
    // A hostile server: it lists its own encryption key for "laptop" and keeps laptop's sealed name.
    const hostile: Fetch = async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname.endsWith("/epochs")) rotated = true;
      const response = await s.fetch(request);
      if (request.method !== "GET" || !url.pathname.endsWith("/devices")) return response;
      const body = (await response.json()) as { devices: { id: string; encPub: string }[] };
      const laptop = b.with((v) => loadSync(v, b.key))!.deviceId;
      for (const d of body.devices) if (d.id === laptop) d.encPub = serverKey;
      return Response.json(body);
    };
    const { result, out } = await quiet(() =>
      syncCommand(["remove-device", "old-phone"], { fetch: hostile, context: a.context, interactive: false, now: tick(s) }),
    );
    expect(result).toBe(1);
    expect(out).toContain("do not match the ones your devices sealed");
    expect(rotated).toBe(false);
    const listing = await quiet(() => syncCommand(["devices"], { fetch: hostile, context: a.context, interactive: false, now: tick(s) }));
    expect(listing.out).toContain("unverified");
  });

  test("names stay readable for remove-device after another device rotated the key", async () => {
    const s = server();
    const a = await syncedDevice(s, { DB: "db-1" });
    const b = device();
    const c = device();
    const d = device();
    await pairUp(a, b, s, { bName: "laptop" });
    await pairUp(a, c, s, { bName: "old-phone" });
    await pairUp(a, d, s, { bName: "tablet" });
    expect((await sync(a, s, ["remove-device", "tablet"])).code).toBe(0);
    // B has not synced since: its key is the old one, which no longer opens the names.
    const removed = await sync(b, s, ["remove-device", "old-phone"]);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain("Removed old-phone");
  });

  test("an approval whose answer is lost still counts, and the new device finishes joining", async () => {
    const s = server();
    const a = await syncedDevice(s, { DB: "db-1" });
    const b = device();
    // The server adds the device, then the connection drops before the answer arrives.
    let dropped = false;
    const flaky: Fetch = async (request) => {
      const response = await s.fetch(request);
      const url = new URL(request.url);
      if (!dropped && request.method === "POST" && url.pathname.endsWith("/devices")) {
        dropped = true;
        throw new Error("connection reset");
      }
      return response;
    };
    const log = captureLog();
    try {
      const adding = syncCommand(["add-device"], {
        fetch: flaky,
        context: a.context,
        interactive: true,
        prompter: new ScriptedPrompter(["yes"]),
        now: tick(s),
        sleep: sleeper(s),
      });
      let code: string | undefined;
      for (let i = 0; i < 500 && !code; i += 1) {
        await Bun.sleep(1);
        code = log.text().match(/KS-[0-9A-Z-]{29}/)?.[0];
      }
      const joining = syncCommand(["join", SERVER, code!], {
        fetch: s.fetch,
        context: b.context,
        interactive: false,
        now: tick(s),
        sleep: sleeper(s),
        deviceName: "second",
      });
      expect(await Promise.all([adding, joining])).toEqual([0, 0]);
      expect(dropped).toBe(true);
    } finally {
      log.restore();
    }
    expect(b.with((v) => v.getSecret(ref("app", "DB")))).toBe("db-1");
  });

  test("remove-device refuses while a conflict is open", async () => {
    const s = server();
    const a = await syncedDevice(s, { DB: "db-1" });
    const b = device();
    const c = device();
    await pairUp(a, b, s, { bName: "laptop" });
    await pairUp(a, c, s, { bName: "old-phone" });
    b.with((v) => v.setSecret(ref("app", "DB"), "db-b"));
    await sync(b, s);
    a.with((v) => v.setSecret(ref("app", "DB"), "db-a"));
    await sync(a, s);
    const refused = await sync(a, s, ["remove-device", "old-phone"]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("Settle the open sync conflicts first");
  });
});

describe("uninstall on a synced device", () => {
  const NO_BINARY = { path: "/usr/local/bin/bun", compiled: false };

  /** A device whose data key is in its home's credential store, as uninstall reads it. */
  async function installed(): Promise<Device> {
    const home = isolateEnv({ prefix: "sync-uninstall" });
    dirs.push(home);
    const { key } = await loadOrCreateDataKey();
    const open = (): Vault => openVault(key);
    return {
      home,
      key,
      open,
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
  }

  test("it leaves the vault first, and the other devices keep it", async () => {
    const { uninstallCommand } = await import("../src/commands/uninstall");
    const s = server();
    const a = device();
    a.with((v) => v.setSecret(ref("app", "DB"), "db-1"));
    await setUp(a, s);
    const b = await installed();
    await addSecond(a, b, s);
    const { result, out } = await quiet(() => uninstallCommand(["--yes"], undefined, NO_BINARY, { fetch: s.fetch, now: () => (s.clock.t += 1) }));
    expect(result).toBe(0);
    expect(out).toContain("Removed this device from the synced vault");
    expect((await sync(a, s, ["devices"])).out.split("\n").filter((l) => l.includes("added"))).toHaveLength(1);
  });

  test("cancelling the last-device question cancels the uninstall", async () => {
    const { uninstallCommand } = await import("../src/commands/uninstall");
    const { CancelledError } = await import("../src/init/prompts");
    const s = server();
    const a = await installed();
    await setUp(a, s);
    let asked = 0;
    const prompter = {
      async select<T extends string>(_q: string, _c: unknown, _d: T): Promise<T> {
        asked += 1;
        if (asked === 1) return "yes" as T;
        throw new CancelledError();
      },
    } as unknown as import("../src/init/prompts").Prompter;
    const { result } = await quiet(() => uninstallCommand(["--force"], prompter, NO_BINARY, { fetch: s.fetch, now: () => (s.clock.t += 1) }));
    expect(result).toBe(130);
    expect(existsSync(a.home)).toBe(true);
    expect((s.db.query("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n).toBe(1);
  });

  test("on the last device it asks whether to delete the vault from the server; no keeps it", async () => {
    const { uninstallCommand } = await import("../src/commands/uninstall");
    for (const answer of ["no", "yes"] as const) {
      const s = server();
      const a = await installed();
      a.with((v) => v.setSecret(ref("app", "DB"), "db-1"));
      await setUp(a, s);
      const prompter = new ScriptedPrompter(["yes", answer]);
      const { result, out } = await quiet(() => uninstallCommand(["--force"], prompter, NO_BINARY, { fetch: s.fetch, now: () => (s.clock.t += 1) }));
      expect(result).toBe(0);
      expect(prompter.asked[1]).toContain("last device");
      const vaults = (s.db.query("SELECT COUNT(*) AS n FROM vaults").get() as { n: number }).n;
      expect(vaults).toBe(answer === "yes" ? 0 : 1);
      expect(out).toContain(answer === "yes" ? "Deleted the synced vault" : "stays on");
    }
  });
});

describe("sync in the background", () => {
  const glance = (d: Device) => glanceSync(join(d.home, "vault.db"));
  const background = (d: Device, s: Server, fetch: Fetch = s.fetch) =>
    quiet(() => syncCommand(["--background"], { fetch, context: d.context, interactive: false, now: () => (s.clock.t += 1) }));

  async function two() {
    const s = server();
    const a = device();
    a.with((v) => v.setSecret(ref("app", "DB"), "db-1"));
    await setUp(a, s);
    const b = device();
    await addSecond(a, b, s);
    await sync(b, s);
    return { s, a, b };
  }

  test("glance reads sync from the vault file alone: off, pending changes and open conflicts", async () => {
    const s = server();
    const a = device();
    a.with((v) => v.setSecret(ref("app", "DB"), "db-1"));
    expect(glance(a).on).toBe(false);
    await setUp(a, s);
    expect(glance(a)).toMatchObject({ on: true, pending: 0, conflicts: 0, server: SERVER, lastError: null });
    expect(glance(a).lastOk).not.toBeNull();
    a.with((v) => v.setSecret(ref("app", "NEW"), "new-1"));
    expect(glance(a).pending).toBe(1);
    expect(glanceSync(join(a.home, "missing.db")).on).toBe(false);
  });

  test("a background sync pushes and pulls, prints nothing, and records the result", async () => {
    const { s, a, b } = await two();
    a.with((v) => v.setSecret(ref("app", "NEW"), "new-1"));
    const pushed = await background(a, s);
    expect(pushed).toEqual({ result: 0, out: "" });
    expect(glance(a).pending).toBe(0);
    const pulled = await background(b, s);
    expect(pulled).toEqual({ result: 0, out: "" });
    expect(b.with((v) => v.getSecret(ref("app", "NEW")))).toBe("new-1");
  });

  test("a background sync never chooses: it keeps this device's value and leaves the conflict open", async () => {
    const { s, a, b } = await two();
    a.with((v) => v.setSecret(ref("app", "DB"), "db-a"));
    await background(a, s);
    b.with((v) => v.setSecret(ref("app", "DB"), "db-b"));
    expect((await background(b, s)).out).toBe("");
    expect(b.with((v) => v.getSecret(ref("app", "DB")))).toBe("db-b");
    expect(glance(b)).toMatchObject({ conflicts: 1, pending: 0 });
    expect(conflictLine("ls", "ks", () => glance(b))).toBe("kerstel: 1 sync conflict. Run `ks sync` to choose which value stays.");
    expect(conflictLine("sync", "ks", () => glance(b))).toBeNull();
    // A's value never reached B's vault, and B's never reached the server.
    await background(a, s);
    expect(a.with((v) => v.getSecret(ref("app", "DB")))).toBe("db-a");
  });

  test("offline, a background sync records the failure for doctor and stays quiet", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    a.with((v) => v.setSecret(ref("app", "NEW"), "new-1"));
    const down: Fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const { result, out } = await background(a, s, down);
    expect(result).toBe(1);
    expect(out).toBe("");
    const seen = glance(a);
    expect(seen.lastError).toContain("ECONNREFUSED");
    expect(seen.pending).toBe(1);
    expect(a.with((v) => v.getSecret(ref("app", "NEW")))).toBe("new-1");
  });

  test("the lock: a background sync waits for the holder, then syncs what was written meanwhile", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    const lock = syncLockPath(join(a.home, "vault.db"));
    expect(lock).toBe(join(a.home, "sync.lock"));

    const release = tryLockSync(lock)!;
    expect(release).not.toBeNull();
    expect(tryLockSync(lock)).toBeNull();
    // The holder already collected its changes; this write comes after.
    a.with((v) => v.setSecret(ref("app", "NEW"), "new-1"));
    setTimeout(release, 400);
    expect(await background(a, s)).toEqual({ result: 0, out: "" });
    expect(glance(a).pending).toBe(0);
    release();
  });

  test("the lock: the operating system frees it when its process dies, however it dies", async () => {
    const a = device();
    const lock = syncLockPath(join(a.home, "vault.db"));
    const module = join(import.meta.dir, "..", "src", "sync", "background.ts");
    const holder = Bun.spawn(
      ["bun", "-e", `const { tryLockSync } = await import(${JSON.stringify(module)}); console.log(tryLockSync(${JSON.stringify(lock)}) ? "held" : "busy"); await Bun.sleep(60_000);`],
      { stdout: "pipe", stderr: "ignore" },
    );
    const reader = holder.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("held");
    expect(tryLockSync(lock)).toBeNull();
    holder.kill(9);
    await holder.exited;
    const mine = tryLockSync(lock);
    expect(mine).not.toBeNull();
    mine!();
  });

  test("a sync you start waits for a background one to finish", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    a.with((v) => v.setSecret(ref("app", "NEW"), "new-1"));
    const release = tryLockSync(syncLockPath(join(a.home, "vault.db")))!;
    setTimeout(release, 400);
    const started = Date.now();
    const { code, out } = await sync(a, s);
    expect(code).toBe(0);
    expect(out).toContain("Pushed 1 change");
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  test("which commands start a background sync, and when", () => {
    const on: SyncGlance = { on: true, pending: 0, conflicts: 0, server: SERVER, lastOk: null, lastTry: null, lastError: null, lastTimer: null, lastSpawn: null };
    const now = 10 * 60_000 + 1;
    const run = (command: string, state: Partial<typeof on>, when: "before" | "after") => {
      let spawned = 0;
      const deps = { glance: () => ({ ...on, ...state }), spawn: () => void (spawned += 1), now: () => now };
      const [name, ...args] = command.split(" ");
      if (when === "before") syncBeforeCommand(name!, deps);
      else syncAfterCommand(name!, args, deps);
      return spawned;
    };
    // Writes push what they left pending.
    for (const command of ["set", "rm", "init", "move", "ui"]) expect(run(command, { pending: 1 }, "after")).toBe(1);
    expect(run("set", { pending: 0 }, "after")).toBe(0);
    expect(run("set", { on: false, pending: 1 }, "after")).toBe(0);
    expect(run("get", { pending: 1 }, "after")).toBe(0);
    // Pairing holds the lock longer than a background sync waits: it pushes what was written meanwhile.
    for (const command of ["sync add-device", "sync join"]) expect(run(command, { pending: 1 }, "after")).toBe(1);
    expect(run("sync", { pending: 1 }, "after")).toBe(0);
    expect(run("sync status", { pending: 1 }, "after")).toBe(0);
    // run and exec pull when nothing finished in a minute, whether it worked or not.
    for (const command of ["run", "exec"]) expect(run(command, { lastOk: now - 2 * 60_000 }, "before")).toBe(1);
    expect(run("run", { lastOk: now - 30_000 }, "before")).toBe(0);
    expect(run("run", { lastOk: now - 6 * 60_000, lastTry: now - 30_000 }, "before")).toBe(0);
    expect(run("run", { on: false }, "before")).toBe(0);
    expect(run("ls", {}, "before")).toBe(0);
    // A failing glance or spawn never fails the command.
    expect(syncAfterCommand("set", [], { glance: () => ({ ...on, pending: 1 }), spawn: () => { throw new Error("no"); } })).toBe(false);
  });

  test("run syncs a minute after the last success", () => {
    const now = 10 * 60_000;
    const base: SyncGlance = { on: true, pending: 0, conflicts: 0, server: SERVER, lastOk: null, lastTry: null, lastError: null, lastTimer: null, lastSpawn: null };
    const at = (ago: number) => syncBeforeCommand("run", { glance: () => ({ ...base, lastOk: now - ago, lastTry: now - ago }), spawn: () => {}, now: () => now });
    expect(at(59_000)).toBe(false);
    expect(at(60_000)).toBe(true);
  });

  test("run backs off five minutes after a failure", () => {
    const now = 20 * 60_000;
    const base: SyncGlance = { on: true, pending: 0, conflicts: 0, server: SERVER, lastOk: now - 10 * 60_000, lastTry: null, lastError: "x", lastTimer: null, lastSpawn: null };
    const at = (ago: number) => syncBeforeCommand("run", { glance: () => ({ ...base, lastTry: now - ago }), spawn: () => {}, now: () => now });
    expect(at(4 * 60_000)).toBe(false);
    expect(at(5 * 60_000)).toBe(true);
  });

  describe("the spawn marker throttles a watch loop", () => {
    // The fake spawn writes nothing: only the marker syncBeforeCommand writes itself can throttle.
    const loop = (calls: number, stepMs: number, state: Partial<SyncGlance>) => {
      const home = isolateEnv({ prefix: "sync-spawn-marker" });
      dirs.push(home);
      let now = 10 * 60_000;
      let spawned = 0;
      const deps = {
        glance: (): SyncGlance => ({ on: true, pending: 0, conflicts: 0, server: SERVER, lastOk: null, lastTry: null, lastError: null, lastTimer: null, ...state, lastSpawn: readSpawnMarker() }),
        spawn: () => void (spawned += 1),
        now: () => now,
      };
      for (let i = 0; i < calls; i += 1) {
        syncBeforeCommand("run", deps);
        now += stepMs;
      }
      return spawned;
    };

    test("a watch loop spawns at most one sync a minute", () => {
      expect(loop(30, 2_000, {})).toBe(1);
    });

    test("a child that crashes and writes no lastTry is not respawned for a minute", () => {
      expect(loop(30, 2_000, { lastOk: 1_000, lastTry: 1_000 })).toBe(1);
    });

    test("after a failure, six minutes of calls spawn at most twice", () => {
      expect(loop(180, 2_000, { lastOk: 1_000, lastTry: 10 * 60_000 - 1_000, lastError: "x" })).toBeLessThanOrEqual(2);
    });

    test("a garbled or missing marker reads as null", () => {
      const home = isolateEnv({ prefix: "sync-spawn-marker" });
      dirs.push(home);
      expect(readSpawnMarker()).toBeNull();
      writeFileSync(spawnMarkerPath(), "not a number");
      expect(readSpawnMarker()).toBeNull();
    });
  });

  test("the background environment carries no caller variables or runtime options", () => {
    const env = backgroundSyncEnv({
      PATH: "/usr/bin",
      KERSTEL_HOME: "/h",
      HTTPS_PROXY: "http://proxy:3128",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      BUN_OPTIONS: "--preload /tmp/x.js",
      NODE_OPTIONS: "--require /tmp/x.js",
      STRIPE_KEY: "sk_live_not_a_real_value",
    });
    expect(env).toMatchObject({ PATH: "/usr/bin", KERSTEL_HOME: "/h", HTTPS_PROXY: "http://proxy:3128", NODE_EXTRA_CA_CERTS: "/ca.pem" });
    expect(env.BUN_OPTIONS).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.STRIPE_KEY).toBeUndefined();
  });

  test("the background environment passes the test-only no-timer flag, and only when set", () => {
    expect(backgroundSyncEnv({ PATH: "/usr/bin", KERSTEL_TEST_NO_SYNC_TIMER: "1" }).KERSTEL_TEST_NO_SYNC_TIMER).toBe("1");
    expect(backgroundSyncEnv({ PATH: "/usr/bin" }).KERSTEL_TEST_NO_SYNC_TIMER).toBeUndefined();
    // The flag reaches a child process, but never a unit file.
    expect(timerEnv({ KERSTEL_TEST_NO_SYNC_TIMER: "1" }).KERSTEL_TEST_NO_SYNC_TIMER).toBeUndefined();
  });

  test("end to end: `set` in its own process starts a detached sync that reaches a real server", async () => {
    const home = isolateEnv({ prefix: "sync-bg" });
    dirs.push(home);
    const { key } = await loadOrCreateDataKey();
    const db = openDatabase(":memory:");
    const app = createApp({ db, version: "test" });
    const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request, "127.0.0.1") });
    try {
      const url = `http://127.0.0.1:${http.port}`;
      const context = async () => ({ vault: openVault(key), dataKey: key }) as unknown as CliContext;
      const { result } = await quiet(() => syncCommand(["setup", url, "--yes"], { context, interactive: false }));
      expect(result).toBe(0);
      const records = () => (db.query("SELECT COUNT(*) AS n FROM records").get() as { n: number }).n;
      expect(records()).toBe(0);

      const cli = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "set", "app/NEW", "--value", "new-1"], {
        env: { ...process.env, KERSTEL_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await cli.exited).toBe(0);
      const deadline = Date.now() + 20_000;
      while (records() === 0 && Date.now() < deadline) await Bun.sleep(100);
      expect(records()).toBe(1);
      // The background sync holds the lock until it has recorded its result.
      let free = tryLockSync(join(home, "sync.lock"));
      while (!free && Date.now() < deadline) {
        await Bun.sleep(50);
        free = tryLockSync(join(home, "sync.lock"));
      }
      free?.();
      expect(glanceSync(join(home, "vault.db"))).toMatchObject({ pending: 0, lastError: null });
      expect(await new Response(cli.stdout).text()).not.toContain("new-1");
    } finally {
      http.stop(true);
    }
  }, 30_000);
});

describe("the pull timer", () => {
  const tick = (s: Server) => () => (s.clock.t += 1);
  const run = (d: Device, s: Server, args: string[], timer: SyncTimer) =>
    quiet(() => syncCommand(args, { fetch: s.fetch, context: d.context, interactive: false, now: tick(s), timer }));
  const unavailable: TimerStatus = { state: "unavailable", reason: "no systemd user session" };

  test("setup schedules pulls", async () => {
    const s = server();
    const a = device();
    const fake = fakeTimer({ ensure: "installed" });
    const { result, out } = await run(a, s, ["setup", SERVER, "--yes"], fake.timer);
    expect(result).toBe(0);
    expect(fake.calls.ensure).toEqual([{ rewrite: true }]);
    expect(out).toContain("Pulls changes every five minutes on its own.");
  });

  test("setup says when it can't schedule", async () => {
    const s = server();
    const a = device();
    const fake = fakeTimer({ ensure: "unavailable", status: unavailable });
    const { result, out } = await run(a, s, ["setup", SERVER, "--yes"], fake.timer);
    expect(result).toBe(0);
    expect(out).toContain("Can't schedule pulls here (no systemd user session). Kerstel still pulls when you run, exec, or change a secret.");
    expect(out).not.toContain("Pulls changes every five minutes");
    // Told once: neither a sync you run nor a background one says it again.
    expect((await run(a, s, [], fake.timer)).out).not.toContain("Can't schedule");
    a.with((v) => v.setSecret(ref("app", "NEW"), "new-1"));
    expect((await run(a, s, ["--background"], fake.timer)).result).toBe(0);
    expect(takeSyncNotice(a.home)).toBeNull();
  });

  test("a failed setup schedules nothing", async () => {
    const s = server();
    const a = device();
    const fake = fakeTimer({ ensure: "installed" });
    const down: Fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const { result } = await quiet(() =>
      syncCommand(["setup", SERVER, "--yes"], { fetch: down, context: a.context, interactive: false, now: tick(s), timer: fake.timer }),
    );
    expect(result).toBe(1);
    expect(fake.calls.ensure).toEqual([]);
  });

  test("a foreground sync rewrites the timer and says so only when it changed", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    const unchanged = fakeTimer({ ensure: "unchanged" });
    const quietRun = await run(a, s, [], unchanged.timer);
    expect(quietRun.result).toBe(0);
    expect(unchanged.calls.ensure).toEqual([{ rewrite: true }]);
    expect(quietRun.out).not.toContain("scheduled pull");
    expect(quietRun.out).not.toContain("five minutes");

    const updated = fakeTimer({ ensure: "updated" });
    const loud = await run(a, s, [], updated.timer);
    expect(loud.result).toBe(0);
    expect(loud.out).toContain("Updated the scheduled pull to match this shell's settings.");
  });

  test("a 0.3.0 device's first foreground sync installs the timer and says how to stop", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    const fake = fakeTimer({ ensure: "installed" });
    const { result, out } = await run(a, s, [], fake.timer);
    expect(result).toBe(0);
    expect(out).toContain("Pulls changes every five minutes on its own.");
    expect(out).toMatch(/Run `\S+ sync off` to stop syncing this device\./);
  });

  test("a foreground sync says it can't schedule once, then stays quiet", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    // A 0.3.0 device: set up before Kerstel could say so.
    a.with((v) => v.deleteMeta(SYNC_META.timerNoted));
    const fake = fakeTimer({ ensure: "unavailable", status: unavailable });
    const line = "Can't schedule pulls here (no systemd user session). Kerstel still pulls when you run, exec, or change a secret.";
    const first = await run(a, s, [], fake.timer);
    expect(first.result).toBe(0);
    expect(first.out).toContain(line);
    const second = await run(a, s, [], fake.timer);
    expect(second.result).toBe(0);
    expect(second.out).not.toContain("Can't schedule");
  });

  test("a 0.3.0 device gets the timer on its next background sync", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    a.with((v) => v.setSecret(ref("app", "NEW"), "new-1"));
    const fake = fakeTimer({ ensure: "installed" });
    const { result, out } = await run(a, s, ["--background"], fake.timer);
    expect(result).toBe(0);
    expect(out).toBe("");
    expect(fake.calls.ensure).toEqual([{ rewrite: false }]);
    expect(takeSyncNotice(a.home)).toMatch(
      /^kerstel: sync now pulls changes every five minutes on its own\. Run `\S+ sync off` to stop syncing this device\.$/,
    );
    expect(takeSyncNotice(a.home)).toBeNull();
  });

  test("the can't-schedule notice is left once", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    // A 0.3.0 device: set up before Kerstel could say so.
    a.with((v) => v.deleteMeta(SYNC_META.timerNoted));
    const fake = fakeTimer({ ensure: "unavailable", status: unavailable });
    a.with((v) => v.setSecret(ref("app", "ONE"), "one-1"));
    expect((await run(a, s, ["--background"], fake.timer)).result).toBe(0);
    expect(takeSyncNotice(a.home)).toBe(
      "kerstel: can't schedule sync pulls here (no systemd user session). Kerstel still pulls when you run, exec, or change a secret.",
    );
    a.with((v) => v.setSecret(ref("app", "TWO"), "two-2"));
    expect((await run(a, s, ["--background"], fake.timer)).result).toBe(0);
    expect(fake.calls.ensure).toHaveLength(2);
    expect(takeSyncNotice(a.home)).toBeNull();
  });

  test("a failed background sync leaves the timer alone", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    a.with((v) => v.setSecret(ref("app", "NEW"), "new-1"));
    const fake = fakeTimer({ ensure: "installed" });
    const down: Fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const { result } = await quiet(() =>
      syncCommand(["--background"], { fetch: down, context: a.context, interactive: false, now: tick(s), timer: fake.timer }),
    );
    expect(result).toBe(1);
    expect(fake.calls.ensure).toEqual([]);
    expect(takeSyncNotice(a.home)).toBeNull();
  });

  test("a timer that throws changes nothing a background sync prints or returns", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    a.with((v) => v.setSecret(ref("app", "NEW"), "new-1"));
    const broken: SyncTimer = {
      status: () => {
        throw new Error("boom");
      },
      ensure: () => {
        throw new Error("boom");
      },
      remove: () => {
        throw new Error("boom");
      },
    };
    expect(await run(a, s, ["--background", "--timer"], broken)).toEqual({ result: 0, out: "" });
    expect(glanceSync(join(a.home, "vault.db")).pending).toBe(0);
  });

  test("a timer run with sync off removes the timer", async () => {
    const s = server();
    const a = device();
    a.with((v) => v.setSecret(ref("app", "A"), "1"));
    const fake = fakeTimer();
    expect((await run(a, s, ["--background", "--timer"], fake.timer)).result).toBe(0);
    expect(fake.calls.remove).toBe(1);
    const plain = fakeTimer();
    expect((await run(a, s, ["--background"], plain.timer)).result).toBe(0);
    expect(plain.calls.remove).toBe(0);
    // Sync stays off, and nothing about it was written.
    expect(a.with((v) => v.getMeta(SYNC_META.lastTimer))).toBeNull();
  });

  test("a timer run on a home with no vault removes the timer and creates nothing", async () => {
    const home = isolateEnv({ prefix: "sync-novault" });
    dirs.push(home);
    rmSync(home, { recursive: true, force: true });
    const fake = fakeTimer();
    let opened = 0;
    const context = async () => {
      opened += 1;
      throw new Error("must not open a vault");
    };
    const { result, out } = await quiet(() => syncCommand(["--background", "--timer"], { context, timer: fake.timer }));
    expect({ result, out, opened, removed: fake.calls.remove }).toEqual({ result: 0, out: "", opened: 0, removed: 1 });
    expect(existsSync(home)).toBe(false);
  });

  test("a timer run records when it ran", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    const before = Date.now();
    expect((await run(a, s, ["--background", "--timer"], fakeTimer().timer)).result).toBe(0);
    const after = Date.now();
    const { lastTimer } = glanceSync(join(a.home, "vault.db"));
    expect(typeof lastTimer).toBe("number");
    expect(lastTimer!).toBeGreaterThanOrEqual(before);
    expect(lastTimer!).toBeLessThanOrEqual(after);
  });

  test("background refuses unknown arguments", async () => {
    const s = server();
    const a = device();
    expect((await run(a, s, ["--background", "--nope"], fakeTimer().timer)).result).toBe(2);
    expect((await run(a, s, ["--background", "--timer", "--nope"], fakeTimer().timer)).result).toBe(2);
  });

  test("sync off removes the timer", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    const fake = fakeTimer();
    expect((await run(a, s, ["off", "--delete-vault"], fake.timer)).result).toBe(0);
    expect(fake.calls.remove).toBe(1);
  });

  test("sync off on a device no longer in the vault removes the timer", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    const b = device();
    await addSecond(a, b, s);
    expect((await sync(a, s, ["remove-device", "second"])).code).toBe(0);
    const fake = fakeTimer();
    const { result, out } = await run(b, s, ["off"], fake.timer);
    expect(result).toBe(0);
    expect(out).toContain("no longer in the synced vault");
    expect(fake.calls.remove).toBe(1);
  });

  test("status shows the schedule", async () => {
    const s = server();
    const a = device();
    await setUp(a, s);
    const pulls = async (status: TimerStatus) =>
      (await run(a, s, ["status"], fakeTimer({ status }).timer)).out.split("\n").find((l) => l.startsWith("Pulls"));

    expect(await pulls({ state: "installed", kind: "launchd", current: true })).toBe("Pulls         every 5 minutes (launchd), last ran never");
    a.with((v) => v.setMeta(SYNC_META.lastTimer, String(Date.UTC(2026, 10, 13, 9, 30))));
    expect(await pulls({ state: "installed", kind: "systemd", current: true })).toBe(
      "Pulls         every 5 minutes (systemd), last ran 2026-11-13 09:30",
    );
    expect(Bun.stripANSI((await pulls({ state: "missing", kind: "launchd" }))!)).toBe(
      "Pulls         not scheduled yet: added on the next sync",
    );
    expect(Bun.stripANSI((await pulls(unavailable))!)).toBe("Pulls         not scheduled (no systemd user session)");
    // The line sits right after Last sync.
    const lines = (await run(a, s, ["status"], fakeTimer().timer)).out.split("\n");
    expect(lines.findIndex((l) => l.startsWith("Pulls"))).toBe(lines.findIndex((l) => l.startsWith("Last sync")) + 1);
  });

  test("a notice is taken once, and taking one never throws", () => {
    const home = isolateEnv({ prefix: "sync-notice" });
    dirs.push(home);
    expect(syncNoticePath(home)).toBe(join(home, "sync-notice"));
    expect(takeSyncNotice(home)).toBeNull();
    leaveSyncNotice("kerstel: hello", home);
    expect(existsSync(syncNoticePath(home))).toBe(true);
    expect(takeSyncNotice(home)).toBe("kerstel: hello");
    expect(existsSync(syncNoticePath(home))).toBe(false);
    expect(takeSyncNotice(join(home, "missing", "dir"))).toBeNull();
  });
});
