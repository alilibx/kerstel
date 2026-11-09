import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../server/src/app";
import { openDatabase } from "../../server/src/db";
import { TIMING, newId, signRequest } from "../../server/src/protocol";
import { syncCommand } from "../src/commands/sync";
import type { CliContext } from "../src/context";
import { listBackups } from "../src/init/backup";
import { ScriptedPrompter } from "../src/init/prompts";
import {
  generateDeviceKeys,
  generateSyncKey,
  openName,
  openPayload,
  openSyncKey,
  publicKeyOf,
  recordId,
  sealName,
  sealPayload,
  sealSyncKey,
} from "../src/sync/crypto";
import { SYNC_BACKUP_SCOPE } from "../src/sync/engine";
import { syncClient, type Fetch } from "../src/sync/http";
import { loadSync, saveSync } from "../src/sync/state";
import { generateDataKey } from "../src/vault/crypto";
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
  return { app, clock, fetch };
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
        sealedName: sealName(config.syncKey, config.vaultId, deviceId, { name: "second", platform: "Linux" }),
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
    const sealed = sealName(k, v, id, { name: "ali-mbp", platform: "macOS" });
    expect(openName(k, v, id, sealed)).toEqual({ name: "ali-mbp", platform: "macOS" });
    expect(openName(k, v, newId(), sealed)).toBeNull();
    expect(openName(generateSyncKey(), v, id, sealed)).toBeNull();
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
