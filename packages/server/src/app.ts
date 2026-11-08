/**
 * The sync server's request handling, without the network listener, so tests
 * drive it with plain `Request` objects. Sync spec §9.
 *
 * The server is blind by design: it verifies signatures, enforces limits and
 * orders writes, and never holds a key that opens a record.
 */
import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  HEADERS,
  LIMITS,
  PROTOCOL_PREFIX,
  TIMING,
  base64urlBytes,
  isId,
  isPublicKey,
  signingString,
  verifySignature,
  type DeviceInput,
  type DeviceOut,
  type ErrorCode,
  type PullResponse,
  type PushResponse,
  type RecordOut,
} from "./protocol";

export interface AppOptions {
  db: Database;
  version: string;
  /** When set, creating a vault requires this value in the `Kerstel-Enroll-Token` header. */
  enrollToken?: string | null;
  now?: () => number;
}

export interface App {
  /** `ip` is the caller's address, used only for rate limits on unauthenticated routes. */
  fetch(request: Request, ip: string): Promise<Response>;
  /** Drops expired pairings, spent signatures and old tombstones. Run periodically. */
  maintain(): void;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const fail = (status: number, code: ErrorCode, message: string): never => {
  throw new HttpError(status, code, message);
};

// ---- Rate limits -------------------------------------------------------------

/** Fixed-window counters, in memory. Lost on restart, which only resets the windows. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number) {}

  hit(key: string, limit: number, windowMs: number): void {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    if (w.count > limit) fail(429, "rate_limited", "Too many requests. Try again in a minute.");
  }

  sweep(): void {
    const t = this.now();
    for (const [key, w] of this.windows) if (w.resetAt <= t) this.windows.delete(key);
  }
}

const RATE = {
  perDevice: { limit: 60, windowMs: 60_000 },
  createVaultPerIp: { limit: 10, windowMs: 60 * 60_000 },
  pairingPerIp: { limit: 30, windowMs: 60_000 },
} as const;

// ---- Validation ----------------------------------------------------------------

type Json = Record<string, unknown>;

function object(value: unknown, field: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(400, "bad_request", `${field} must be an object.`);
  }
  return value as Json;
}

function id(value: unknown, field: string): string {
  if (!isId(value)) fail(400, "bad_request", `${field} must be a 22-character base64url ID.`);
  return value as string;
}

function sealed(value: unknown, field: string, maxBytes: number): string {
  const bytes = base64urlBytes(value);
  if (bytes < 1) fail(400, "bad_request", `${field} must be base64url.`);
  if (bytes > maxBytes) fail(413, "too_large", `${field} is over ${maxBytes} bytes.`);
  return value as string;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(400, "bad_request", `${field} must be a whole number, 0 or more.`);
  }
  return value as number;
}

function array(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(400, "bad_request", `${field} must be an array.`);
  const list = value as unknown[];
  if (list.length > max) fail(413, "too_large", `${field} holds more than ${max} entries.`);
  return list;
}

function unique(ids: string[], field: string): void {
  if (new Set(ids).size !== ids.length) fail(400, "bad_request", `${field} lists an ID twice.`);
}

function device(value: unknown, field: string): DeviceInput {
  const d = object(value, field);
  if (!isPublicKey(d.signPub)) fail(400, "bad_request", `${field}.signPub must be a 32-byte key.`);
  if (!isPublicKey(d.encPub)) fail(400, "bad_request", `${field}.encPub must be a 32-byte key.`);
  return {
    id: id(d.id, `${field}.id`),
    signPub: d.signPub as string,
    encPub: d.encPub as string,
    sealedName: sealed(d.sealedName, `${field}.sealedName`, LIMITS.sealedBytes),
  };
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ---- Rows ---------------------------------------------------------------------

interface VaultRow {
  id: string;
  epoch: number;
  head: number;
  pruned_rev: number;
}

interface DeviceRow {
  vault_id: string;
  id: string;
  sign_pub: string;
  enc_pub: string;
  sealed_name: string;
  added_at: number;
  added_by: string | null;
  last_seen: number | null;
}

interface PairingRow {
  id: string;
  vault_id: string;
  payload: string | null;
  accepted_device: string | null;
  expires_at: number;
}

const deviceOut = (row: DeviceRow): DeviceOut => ({
  id: row.id,
  signPub: row.sign_pub,
  encPub: row.enc_pub,
  sealedName: row.sealed_name,
  addedAt: row.added_at,
  addedBy: row.added_by,
  lastSeen: row.last_seen,
});

// ---- The app ------------------------------------------------------------------

export function createApp(options: AppOptions): App {
  const { db, version } = options;
  const now = options.now ?? Date.now;
  const enrollToken = options.enrollToken || null;
  const limiter = new RateLimiter(now);

  const getVault = (vaultId: string): VaultRow | null =>
    db.query<VaultRow, [string]>("SELECT id, epoch, head, pruned_rev FROM vaults WHERE id = ?").get(vaultId);

  const requireVault = (vaultId: string): VaultRow =>
    getVault(vaultId) ?? fail(404, "not_found", "No such vault.");

  const getDevice = (vaultId: string, deviceId: string): DeviceRow | null =>
    db.query<DeviceRow, [string, string]>("SELECT * FROM devices WHERE vault_id = ? AND id = ?").get(vaultId, deviceId);

  const listDevices = (vaultId: string): DeviceRow[] =>
    db.query<DeviceRow, [string]>("SELECT * FROM devices WHERE vault_id = ? ORDER BY added_at, rowid").all(vaultId);

  const getPairing = (pairingId: string): PairingRow | null => {
    const row = db
      .query<PairingRow, [string]>("SELECT id, vault_id, payload, accepted_device, expires_at FROM pairings WHERE id = ?")
      .get(pairingId);
    return row && row.expires_at > now() ? row : null;
  };

  /**
   * Checks a request's signature against `signPub`, then spends it. A second
   * request with the same signature is a replay. The timestamp window bounds
   * how long a spent signature has to be remembered.
   */
  function checkSignature(request: Request, pathAndQuery: string, body: Uint8Array, signPub: string): void {
    const timestamp = request.headers.get(HEADERS.timestamp) ?? "";
    const signature = request.headers.get(HEADERS.signature) ?? "";
    if (!/^\d{1,16}$/.test(timestamp)) fail(401, "unauthorized", "Missing or malformed Kerstel-Timestamp.");
    const ts = Number(timestamp);
    if (Math.abs(now() - ts) > TIMING.clockSkewMs) {
      fail(401, "unauthorized", "The request's clock is more than 5 minutes from the server's. Check the time on this device.");
    }
    const message = signingString(request.method, pathAndQuery, timestamp, body);
    if (!verifySignature(signPub, message, signature)) fail(401, "unauthorized", "Bad signature.");
    const spent = db
      .query("INSERT OR IGNORE INTO seen_signatures (signature, expires_at) VALUES (?, ?)")
      .run(signature, ts + TIMING.clockSkewMs);
    if (spent.changes === 0) fail(401, "unauthorized", "This request was already used.");
  }

  /** The device a signed request comes from. Unknown vaults and devices both answer 401, so IDs cannot be probed. */
  function authenticate(request: Request, vaultId: string, pathAndQuery: string, body: Uint8Array): DeviceRow {
    const deviceId = request.headers.get(HEADERS.device);
    if (!isId(deviceId)) fail(401, "unauthorized", "Missing or malformed Kerstel-Device.");
    const row = getDevice(vaultId, deviceId!) ?? fail(401, "unauthorized", "Unknown device.");
    checkSignature(request, pathAndQuery, body, row.sign_pub);
    limiter.hit(`device:${vaultId}:${row.id}`, RATE.perDevice.limit, RATE.perDevice.windowMs);
    db.query("UPDATE devices SET last_seen = ? WHERE vault_id = ? AND id = ?").run(now(), vaultId, row.id);
    return row;
  }

  // ---- Handlers ----

  function createVault(request: Request, pathAndQuery: string, raw: Uint8Array, body: Json, ip: string) {
    if (enrollToken !== null && !safeEqual(request.headers.get(HEADERS.enrollToken) ?? "", enrollToken)) {
      fail(403, "forbidden", "This server needs an enroll token to create a vault.");
    }
    limiter.hit(`create:${ip}`, RATE.createVaultPerIp.limit, RATE.createVaultPerIp.windowMs);
    const vaultId = id(body.vaultId, "vaultId");
    const first = device(body.device, "device");
    const sealedKey = sealed(body.sealedKey, "sealedKey", LIMITS.sealedBytes);
    if (request.headers.get(HEADERS.device) !== first.id) {
      fail(401, "unauthorized", "Kerstel-Device must be the vault's first device.");
    }
    // Proof that the caller holds the private half of the key it registers.
    checkSignature(request, pathAndQuery, raw, first.signPub);

    db.transaction(() => {
      if (getVault(vaultId)) fail(409, "exists", "A vault with this ID already exists.");
      const t = now();
      db.query("INSERT INTO vaults (id, epoch, head, pruned_rev, created_at) VALUES (?, 1, 0, 0, ?)").run(vaultId, t);
      db.query(
        "INSERT INTO devices (vault_id, id, sign_pub, enc_pub, sealed_name, added_at, added_by, last_seen) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
      ).run(vaultId, first.id, first.signPub, first.encPub, first.sealedName, t, t);
      db.query("INSERT INTO sealed_keys (vault_id, device_id, epoch, sealed) VALUES (?, ?, 1, ?)").run(vaultId, first.id, sealedKey);
    })();
    return json(201, { epoch: 1, head: 0 });
  }

  function pull(vaultId: string, url: URL): Response {
    const since = count(Number(url.searchParams.get("since") ?? "0"), "since");
    const full = url.searchParams.get("full") === "1";
    const requested = url.searchParams.get("limit");
    const limit = requested === null ? LIMITS.pageSize : Math.min(Math.max(count(Number(requested), "limit"), 1), LIMITS.maxPageSize);
    const vault = requireVault(vaultId);
    // A full pull reconciles by absence, so a dropped tombstone does not matter to it.
    if (!full && since > 0 && since < vault.pruned_rev) {
      fail(409, "full_pull_required", "This device is too far behind. Pull the whole vault again (full=1).");
    }
    const rows = db
      .query<RecordOut, [string, number, number]>(
        "SELECT id, rev, blob FROM records WHERE vault_id = ? AND rev > ? ORDER BY rev LIMIT ?",
      )
      .all(vaultId, since, limit + 1);
    const more = rows.length > limit;
    const out: PullResponse = { epoch: vault.epoch, head: vault.head, records: more ? rows.slice(0, limit) : rows, more };
    return json(200, out);
  }

  function push(vaultId: string, body: Json): Response {
    const epoch = count(body.epoch, "epoch");
    const records = array(body.records, "records", 1000).map((value, i) => {
      const r = object(value, `records[${i}]`);
      return {
        id: id(r.id, `records[${i}].id`),
        baseRev: count(r.baseRev, `records[${i}].baseRev`),
        blob: r.blob === null ? null : sealed(r.blob, `records[${i}].blob`, LIMITS.recordBytes),
      };
    });
    unique(
      records.map((r) => r.id),
      "records",
    );

    const out: PushResponse = db.transaction(() => {
      const vault = requireVault(vaultId);
      if (epoch !== vault.epoch) {
        fail(409, "epoch_mismatch", `The vault is at key epoch ${vault.epoch}. Fetch the new sync key and pull again.`);
      }
      let head = vault.head;
      const t = now();
      const accepted: PushResponse["accepted"] = [];
      const conflicts: RecordOut[] = [];
      const current = db.query<{ rev: number; blob: string | null }, [string, string]>(
        "SELECT rev, blob FROM records WHERE vault_id = ? AND id = ?",
      );
      const upsert = db.query(
        `INSERT INTO records (vault_id, id, rev, blob, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (vault_id, id) DO UPDATE SET rev = excluded.rev, blob = excluded.blob, size = excluded.size, updated_at = excluded.updated_at`,
      );
      for (const r of records) {
        const existing = current.get(vaultId, r.id);
        const rev = existing?.rev ?? 0;
        if (r.baseRev !== rev) {
          conflicts.push({ id: r.id, rev, blob: existing?.blob ?? null });
          continue;
        }
        head++;
        upsert.run(vaultId, r.id, head, r.blob, r.blob === null ? 0 : base64urlBytes(r.blob), t);
        accepted.push({ id: r.id, rev: head });
      }
      if (accepted.length > 0) {
        const totals = db
          .query<{ n: number; bytes: number }, [string]>(
            "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM records WHERE vault_id = ?",
          )
          .get(vaultId)!;
        if (totals.n > LIMITS.recordsPerVault) fail(413, "vault_full", `A vault holds at most ${LIMITS.recordsPerVault} records.`);
        if (totals.bytes > LIMITS.vaultBytes) fail(413, "vault_full", `A vault holds at most ${LIMITS.vaultBytes} bytes.`);
        db.query("UPDATE vaults SET head = ? WHERE id = ?").run(head, vaultId);
      }
      return { head, accepted, conflicts };
    })();
    return json(200, out);
  }

  function keys(caller: DeviceRow): Response {
    const row = db
      .query<{ epoch: number; sealed: string }, [string, string]>(
        "SELECT epoch, sealed FROM sealed_keys WHERE vault_id = ? AND device_id = ?",
      )
      .get(caller.vault_id, caller.id);
    if (!row) fail(404, "not_found", "No sync key is sealed to this device.");
    return json(200, { epoch: row!.epoch, sealedKey: row!.sealed });
  }

  function addDevice(caller: DeviceRow, body: Json): Response {
    const added = device(body.device, "device");
    const epoch = count(body.epoch, "epoch");
    const sealedKey = sealed(body.sealedKey, "sealedKey", LIMITS.sealedBytes);
    const pairingId = body.pairingId === undefined ? null : id(body.pairingId, "pairingId");
    const vaultId = caller.vault_id;

    const row = db.transaction(() => {
      const vault = requireVault(vaultId);
      if (epoch !== vault.epoch) fail(409, "epoch_mismatch", `The vault is at key epoch ${vault.epoch}.`);
      const devices = listDevices(vaultId);
      if (devices.length >= LIMITS.devicesPerVault) {
        fail(409, "vault_full", `A vault holds at most ${LIMITS.devicesPerVault} devices.`);
      }
      if (devices.some((d) => d.id === added.id)) fail(409, "exists", "That device is already in this vault.");
      if (pairingId !== null) {
        const slot = getPairing(pairingId);
        if (!slot || slot.vault_id !== vaultId) fail(404, "not_found", "The pairing code expired or does not exist.");
        if (slot!.accepted_device !== null) fail(409, "pairing_used", "That pairing code was already used.");
        if (slot!.payload === null) fail(409, "bad_request", "The new device has not answered the pairing code yet.");
        db.query("UPDATE pairings SET accepted_device = ? WHERE id = ?").run(added.id, pairingId);
      }
      const t = now();
      db.query(
        "INSERT INTO devices (vault_id, id, sign_pub, enc_pub, sealed_name, added_at, added_by, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      ).run(vaultId, added.id, added.signPub, added.encPub, added.sealedName, t, caller.id);
      db.query("INSERT INTO sealed_keys (vault_id, device_id, epoch, sealed) VALUES (?, ?, ?, ?)").run(
        vaultId,
        added.id,
        epoch,
        sealedKey,
      );
      return getDevice(vaultId, added.id)!;
    })();
    return json(201, deviceOut(row));
  }

  function removeSelf(caller: DeviceRow, deviceId: string): Response {
    if (deviceId !== caller.id) {
      fail(403, "forbidden", "A device can only remove itself here. Removing another device replaces the sync key: POST /epochs.");
    }
    db.transaction(() => {
      if (listDevices(caller.vault_id).length <= 1) {
        fail(409, "last_device", "This is the vault's last device. Delete the vault instead.");
      }
      db.query("DELETE FROM devices WHERE vault_id = ? AND id = ?").run(caller.vault_id, caller.id);
    })();
    return empty();
  }

  function rotate(caller: DeviceRow, body: Json): Response {
    const epoch = count(body.epoch, "epoch");
    const removeDevices = array(body.removeDevices, "removeDevices", LIMITS.devicesPerVault).map((v, i) => id(v, `removeDevices[${i}]`));
    unique(removeDevices, "removeDevices");
    const sealedKeys = object(body.sealedKeys, "sealedKeys");
    const keyed = Object.entries(sealedKeys).map(([deviceId, value]) => ({
      deviceId: id(deviceId, "sealedKeys key"),
      sealed: sealed(value, `sealedKeys.${deviceId}`, LIMITS.sealedBytes),
    }));
    let bytes = 0;
    const records = array(body.records, "records", LIMITS.recordsPerVault).map((value, i) => {
      const r = object(value, `records[${i}]`);
      const blob = sealed(r.blob, `records[${i}].blob`, LIMITS.recordBytes);
      bytes += base64urlBytes(blob);
      return { id: id(r.id, `records[${i}].id`), blob };
    });
    unique(
      records.map((r) => r.id),
      "records",
    );
    if (bytes > LIMITS.vaultBytes) fail(413, "vault_full", `A vault holds at most ${LIMITS.vaultBytes} bytes.`);
    if (removeDevices.includes(caller.id)) {
      fail(403, "forbidden", "A device cannot remove itself while replacing the key. Use DELETE /devices/<own id>.");
    }
    const vaultId = caller.vault_id;

    const out = db.transaction(() => {
      const vault = requireVault(vaultId);
      if (epoch !== vault.epoch + 1) fail(409, "epoch_mismatch", `The next key epoch is ${vault.epoch + 1}.`);
      const current = new Set(listDevices(vaultId).map((d) => d.id));
      for (const r of removeDevices) if (!current.has(r)) fail(404, "not_found", `Device ${r} is not in this vault.`);
      const remaining = [...current].filter((d) => !removeDevices.includes(d)).sort();
      const sealedFor = keyed.map((k) => k.deviceId).sort();
      if (remaining.length !== sealedFor.length || remaining.some((d, i) => d !== sealedFor[i])) {
        fail(400, "bad_request", "sealedKeys must hold exactly one key for every device that stays.");
      }

      const before = vault.head;
      let head = before;
      const t = now();
      db.query("DELETE FROM records WHERE vault_id = ?").run(vaultId);
      const insert = db.query("INSERT INTO records (vault_id, id, rev, blob, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const r of records) insert.run(vaultId, r.id, ++head, r.blob, base64urlBytes(r.blob), t);
      const removeDevice = db.query("DELETE FROM devices WHERE vault_id = ? AND id = ?");
      for (const r of removeDevices) removeDevice.run(vaultId, r);
      db.query("DELETE FROM sealed_keys WHERE vault_id = ?").run(vaultId);
      const insertKey = db.query("INSERT INTO sealed_keys (vault_id, device_id, epoch, sealed) VALUES (?, ?, ?, ?)");
      for (const k of keyed) insertKey.run(vaultId, k.deviceId, epoch, k.sealed);
      // A code issued under the old key would hand the new device a key that no longer opens anything.
      db.query("DELETE FROM pairings WHERE vault_id = ?").run(vaultId);
      // Every cursor from before the rotation points at record IDs that no longer exist.
      db.query("UPDATE vaults SET epoch = ?, head = ?, pruned_rev = ? WHERE id = ?").run(epoch, head, before, vaultId);
      return { epoch, head };
    })();
    return json(200, out);
  }

  function openPairing(caller: DeviceRow, body: Json): Response {
    const pairingId = id(body.pairingId, "pairingId");
    const expiresAt = now() + TIMING.pairingTtlMs;
    db.transaction(() => {
      const open = db
        .query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM pairings WHERE vault_id = ? AND expires_at > ?")
        .get(caller.vault_id, now())!;
      if (open.n >= LIMITS.openPairingsPerVault) {
        fail(429, "rate_limited", `A vault can have at most ${LIMITS.openPairingsPerVault} pairing codes open at once.`);
      }
      db.query("DELETE FROM pairings WHERE id = ? AND expires_at <= ?").run(pairingId, now());
      if (db.query("SELECT 1 FROM pairings WHERE id = ?").get(pairingId)) fail(409, "exists", "That pairing ID is in use.");
      db.query("INSERT INTO pairings (id, vault_id, created_by, payload, accepted_device, expires_at) VALUES (?, ?, ?, NULL, NULL, ?)").run(
        pairingId,
        caller.vault_id,
        caller.id,
        expiresAt,
      );
    })();
    return json(201, { expiresAt });
  }

  function readPairing(caller: DeviceRow, pairingId: string): Response {
    const slot = getPairing(pairingId);
    if (!slot || slot.vault_id !== caller.vault_id) fail(404, "not_found", "The pairing code expired or does not exist.");
    return json(200, { payload: slot!.payload, expiresAt: slot!.expires_at });
  }

  function closePairing(caller: DeviceRow, pairingId: string): Response {
    db.query("DELETE FROM pairings WHERE id = ? AND vault_id = ?").run(pairingId, caller.vault_id);
    return empty();
  }

  /** The new device's half of pairing. Unauthenticated: it has no key the server knows yet. */
  function answerPairing(pairingId: string, body: Json, ip: string): Response {
    limiter.hit(`pairing:${ip}`, RATE.pairingPerIp.limit, RATE.pairingPerIp.windowMs);
    const payload = sealed(body.payload, "payload", LIMITS.pairingBytes);
    db.transaction(() => {
      const slot = getPairing(pairingId) ?? fail(404, "not_found", "The pairing code expired or does not exist.");
      if (slot.payload !== null) fail(409, "pairing_used", "That pairing code was already used.");
      db.query("UPDATE pairings SET payload = ? WHERE id = ?").run(payload, pairingId);
    })();
    return empty();
  }

  function pairingState(pairingId: string, ip: string): Response {
    limiter.hit(`pairing:${ip}`, RATE.pairingPerIp.limit, RATE.pairingPerIp.windowMs);
    const slot = getPairing(pairingId) ?? fail(404, "not_found", "The pairing code expired, or the other device said no.");
    return json(200, slot.accepted_device === null ? { state: "waiting" } : { state: "accepted", vaultId: slot.vault_id });
  }

  function deleteVault(caller: DeviceRow): Response {
    db.query("DELETE FROM vaults WHERE id = ?").run(caller.vault_id);
    return empty();
  }

  // ---- Routing ----

  async function route(request: Request, ip: string): Promise<Response> {
    const url = new URL(request.url);
    const pathAndQuery = url.pathname + url.search;
    const method = request.method.toUpperCase();
    if (!url.pathname.startsWith(`${PROTOCOL_PREFIX}/`)) fail(404, "not_found", "No such endpoint.");
    const parts = url.pathname.slice(PROTOCOL_PREFIX.length + 1).split("/");

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > LIMITS.bodyBytes) fail(413, "too_large", "The request body is too large.");
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.length > LIMITS.bodyBytes) fail(413, "too_large", "The request body is too large.");
    const parse = (): Json => {
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        fail(400, "bad_request", "The body must be JSON.");
      }
      return object(value, "body");
    };

    const [a, b, c, d] = parts;

    if (method === "GET" && a === "health" && parts.length === 1) {
      return json(200, { ok: true, version, protocol: 1 });
    }

    if (a === "vaults" && parts.length === 1 && method === "POST") {
      return createVault(request, pathAndQuery, raw, parse(), ip);
    }

    if (a === "pairings" && parts.length === 2 && isId(b)) {
      if (method === "PUT") return answerPairing(b, parse(), ip);
      if (method === "GET") return pairingState(b, ip);
    }

    if (a === "vaults" && isId(b)) {
      const caller = authenticate(request, b, pathAndQuery, raw);
      if (parts.length === 2 && method === "DELETE") return deleteVault(caller);
      if (parts.length === 3 && c === "records") {
        if (method === "GET") return pull(b, url);
        if (method === "POST") return push(b, parse());
      }
      if (parts.length === 3 && c === "keys" && method === "GET") return keys(caller);
      if (parts.length === 3 && c === "devices") {
        if (method === "GET") return json(200, { devices: listDevices(b).map(deviceOut) });
        if (method === "POST") return addDevice(caller, parse());
      }
      if (parts.length === 4 && c === "devices" && isId(d) && method === "DELETE") return removeSelf(caller, d);
      if (parts.length === 3 && c === "epochs" && method === "POST") return rotate(caller, parse());
      if (parts.length === 3 && c === "pairings" && method === "POST") return openPairing(caller, parse());
      if (parts.length === 4 && c === "pairings" && isId(d)) {
        if (method === "GET") return readPairing(caller, d);
        if (method === "DELETE") return closePairing(caller, d);
      }
    }

    return fail(404, "not_found", "No such endpoint.");
  }

  return {
    async fetch(request, ip) {
      try {
        return await route(request, ip);
      } catch (error) {
        if (error instanceof HttpError) return json(error.status, { error: error.code, message: error.message });
        console.error(error);
        return json(500, { error: "internal", message: "Internal error." });
      }
    },

    maintain() {
      const t = now();
      db.query("DELETE FROM pairings WHERE expires_at <= ?").run(t);
      db.query("DELETE FROM seen_signatures WHERE expires_at <= ?").run(t);
      const cutoff = t - TIMING.tombstoneTtlMs;
      db.transaction(() => {
        const pruned = db
          .query<{ vault_id: string; rev: number }, [number]>(
            "SELECT vault_id, MAX(rev) AS rev FROM records WHERE blob IS NULL AND updated_at < ? GROUP BY vault_id",
          )
          .all(cutoff);
        for (const p of pruned) {
          db.query("DELETE FROM records WHERE vault_id = ? AND blob IS NULL AND updated_at < ?").run(p.vault_id, cutoff);
          db.query("UPDATE vaults SET pruned_rev = MAX(pruned_rev, ?) WHERE id = ?").run(p.rev, p.vault_id);
        }
      })();
      limiter.sweep();
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function empty(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
