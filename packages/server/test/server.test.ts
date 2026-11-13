import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/app";
import { openDatabase } from "../src/db";
import { parseArgs } from "../src/index";
import { HEADERS, LIMITS, TIMING, newId, signRequest } from "../src/protocol";
import { Device, addDevice, anonymous, blob, body, harness, vaultWithDevice, type Harness } from "./helpers";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.close());

const records = (d: Device) => `/v1/vaults/${d.vaultId}/records`;

describe("health", () => {
  test("answers without a signature", async () => {
    const res = await anonymous(h, "GET", "/v1/health");
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, version: "test", protocol: 1 });
  });

  test("unknown paths are 404", async () => {
    expect((await anonymous(h, "GET", "/v2/health")).status).toBe(404);
    expect((await anonymous(h, "GET", "/v1/nothing")).status).toBe(404);
  });
});

describe("creating a vault", () => {
  test("registers the first device and its sealed key", async () => {
    const d = await vaultWithDevice(h);
    const devices = await body(await d.call("GET", `/v1/vaults/${d.vaultId}/devices`));
    expect(devices.devices.map((x: { id: string }) => x.id)).toEqual([d.id]);
    const keys = await body(await d.call("GET", `/v1/vaults/${d.vaultId}/keys`));
    expect(keys.epoch).toBe(1);
    expect(typeof keys.sealedKey).toBe("string");
  });

  test("an existing vault ID is refused", async () => {
    const d = await vaultWithDevice(h);
    const again = new Device(h, d.vaultId);
    const res = await again.createVault();
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("exists");
  });

  test("the request must be signed by the key it registers", async () => {
    const d = new Device(h, newId());
    const other = new Device(h, d.vaultId);
    const payload = { vaultId: d.vaultId, device: d.input(), sealedKey: blob(80) };
    const raw = new TextEncoder().encode(JSON.stringify(payload));
    const headers = signRequest(other.key.privateKey, d.id, "POST", "/v1/vaults", raw, h.clock.t);
    const res = await h.app.fetch(new Request("http://server/v1/vaults", { method: "POST", headers, body: raw }), "10.0.0.1");
    expect(res.status).toBe(401);
  });

  test("an enroll token, when configured, is required", async () => {
    h.close();
    h = harness({ enrollToken: "s3cret-token" });
    const d = new Device(h, newId());
    expect((await d.createVault()).status).toBe(403);
    const wrong = new Device(h, newId());
    expect((await wrong.createVault({ [HEADERS.enrollToken]: "nope" })).status).toBe(403);
    const right = new Device(h, newId());
    expect((await right.createVault({ [HEADERS.enrollToken]: "s3cret-token" })).status).toBe(201);
  });

  test("malformed bodies are 400", async () => {
    const d = new Device(h, "not-an-id");
    const res = await d.createVault();
    expect(res.status).toBe(400);
    expect((await body(res)).message).toContain("vaultId");
  });
});

describe("authentication", () => {
  test("an unsigned request to a vault is 401", async () => {
    const d = await vaultWithDevice(h);
    expect((await anonymous(h, "GET", records(d))).status).toBe(401);
  });

  test("a device from another vault is 401, as is an unknown vault", async () => {
    const a = await vaultWithDevice(h);
    const b = await vaultWithDevice(h);
    const intruder = new Device(h, a.vaultId);
    Object.assign(intruder, { id: b.id, key: b.key });
    expect((await intruder.call("GET", records(a))).status).toBe(401);
    const lost = new Device(h, newId());
    expect((await lost.call("GET", records(lost))).status).toBe(401);
  });

  test("a stale or future timestamp is refused", async () => {
    const d = await vaultWithDevice(h);
    for (const skew of [-TIMING.clockSkewMs - 1, TIMING.clockSkewMs + 1]) {
      const path = records(d);
      const headers = signRequest(d.key.privateKey, d.id, "GET", path, new Uint8Array(), h.clock.t + skew);
      const res = await h.app.fetch(new Request(`http://server${path}`, { headers }), "10.0.0.1");
      expect(res.status).toBe(401);
      expect((await body(res)).message).toContain("clock");
    }
  });

  test("a replayed request is refused", async () => {
    const d = await vaultWithDevice(h);
    const path = records(d);
    const headers = signRequest(d.key.privateKey, d.id, "GET", path, new Uint8Array(), h.clock.t);
    const send = () => h.app.fetch(new Request(`http://server${path}`, { headers }), "10.0.0.1");
    expect((await send()).status).toBe(200);
    const again = await send();
    expect(again.status).toBe(401);
    expect((await body(again)).message).toContain("already used");
  });

  test("a re-encoded spelling of a spent signature is not a new one", async () => {
    const d = await vaultWithDevice(h);
    const path = records(d);
    const headers = signRequest(d.key.privateKey, d.id, "GET", path, new Uint8Array(), h.clock.t);
    expect((await h.app.fetch(new Request(`http://server${path}`, { headers }), "10.0.0.1")).status).toBe(200);
    // 64 bytes leave 4 unused bits in the last base64url character; setting one
    // decodes to the same bytes.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sig = headers["kerstel-signature"]!;
    const variant = sig.slice(0, -1) + alphabet[alphabet.indexOf(sig.at(-1)!) ^ 1];
    expect(Buffer.from(variant, "base64url").equals(Buffer.from(sig, "base64url"))).toBe(true);
    const replay = await h.app.fetch(
      new Request(`http://server${path}`, { headers: { ...headers, "kerstel-signature": variant } }),
      "10.0.0.1",
    );
    expect(replay.status).toBe(401);
  });

  test("a request refused by the rate limit spends nothing", async () => {
    const d = await vaultWithDevice(h);
    const spent = () => (h.db.query("SELECT COUNT(*) AS n FROM seen_signatures").get() as { n: number }).n;
    for (let i = 0; i < 60; i += 1) await d.call("GET", records(d));
    const before = spent();
    for (let i = 0; i < 5; i += 1) expect((await d.call("GET", records(d))).status).toBe(429);
    expect(spent()).toBe(before);
  });

  test("the signature covers the query string and the body", async () => {
    const d = await vaultWithDevice(h);
    const headers = signRequest(d.key.privateKey, d.id, "GET", `${records(d)}?since=0`, new Uint8Array(), h.clock.t);
    const res = await h.app.fetch(new Request(`http://server${records(d)}?since=5`, { headers }), "10.0.0.1");
    expect(res.status).toBe(401);

    const signedBody = new TextEncoder().encode(JSON.stringify({ epoch: 1, records: [] }));
    const tampered = new TextEncoder().encode(JSON.stringify({ epoch: 2, records: [] }));
    const h2 = signRequest(d.key.privateKey, d.id, "POST", records(d), signedBody, h.clock.t + 1);
    const res2 = await h.app.fetch(new Request(`http://server${records(d)}`, { method: "POST", headers: h2, body: tampered }), "10.0.0.1");
    expect(res2.status).toBe(401);
  });
});

describe("push and pull", () => {
  test("new records are accepted with increasing revisions and pulled back", async () => {
    const d = await vaultWithDevice(h);
    const [r1, r2] = [newId(), newId()];
    const res = await d.call("POST", records(d), {
      epoch: 1,
      records: [
        { id: r1, baseRev: 0, blob: blob() },
        { id: r2, baseRev: 0, blob: blob() },
      ],
    });
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out).toMatchObject({ head: 2, accepted: [{ id: r1, rev: 1 }, { id: r2, rev: 2 }], conflicts: [] });

    const pulled = await body(await d.call("GET", `${records(d)}?since=0`));
    expect(pulled.head).toBe(2);
    expect(pulled.epoch).toBe(1);
    expect(pulled.records.map((r: { id: string }) => r.id)).toEqual([r1, r2]);

    const later = await body(await d.call("GET", `${records(d)}?since=1`));
    expect(later.records.map((r: { id: string }) => r.id)).toEqual([r2]);
  });

  test("a stale baseRev is a conflict carrying the server's copy, and other records still land", async () => {
    const a = await vaultWithDevice(h);
    const b = await addDevice(h, a);
    const shared = newId();
    const first = blob();
    await a.call("POST", records(a), { epoch: 1, records: [{ id: shared, baseRev: 0, blob: first }] });

    const other = newId();
    const res = await body(
      await b.call("POST", records(b), {
        epoch: 1,
        records: [
          { id: shared, baseRev: 0, blob: blob() },
          { id: other, baseRev: 0, blob: blob() },
        ],
      }),
    );
    expect(res.conflicts).toEqual([{ id: shared, rev: 1, blob: first }]);
    expect(res.accepted).toEqual([{ id: other, rev: 2 }]);

    const fixed = await body(await b.call("POST", records(b), { epoch: 1, records: [{ id: shared, baseRev: 1, blob: blob() }] }));
    expect(fixed.accepted).toEqual([{ id: shared, rev: 3 }]);
  });

  test("a deletion is a record with no blob", async () => {
    const d = await vaultWithDevice(h);
    const r = newId();
    await d.call("POST", records(d), { epoch: 1, records: [{ id: r, baseRev: 0, blob: blob() }] });
    await d.call("POST", records(d), { epoch: 1, records: [{ id: r, baseRev: 1, blob: null }] });
    const pulled = await body(await d.call("GET", `${records(d)}?since=1`));
    expect(pulled.records).toEqual([{ id: r, rev: 2, blob: null }]);
  });

  test("pulls page, and the last page says there is no more", async () => {
    const d = await vaultWithDevice(h);
    const batch = Array.from({ length: 5 }, () => ({ id: newId(), baseRev: 0, blob: blob(10) }));
    await d.call("POST", records(d), { epoch: 1, records: batch });
    const p1 = await body(await d.call("GET", `${records(d)}?since=0&limit=2`));
    expect(p1.records.length).toBe(2);
    expect(p1.more).toBe(true);
    const p3 = await body(await d.call("GET", `${records(d)}?since=4&limit=2`));
    expect(p3.records.length).toBe(1);
    expect(p3.more).toBe(false);
  });

  test("a push under the wrong epoch is refused", async () => {
    const d = await vaultWithDevice(h);
    const res = await d.call("POST", records(d), { epoch: 2, records: [{ id: newId(), baseRev: 0, blob: blob() }] });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe("epoch_mismatch");
  });

  test("a duplicate record ID in one push is 400", async () => {
    const d = await vaultWithDevice(h);
    const r = newId();
    const res = await d.call("POST", records(d), {
      epoch: 1,
      records: [
        { id: r, baseRev: 0, blob: blob() },
        { id: r, baseRev: 0, blob: blob() },
      ],
    });
    expect(res.status).toBe(400);
  });
});

describe("limits", () => {
  test("a record over the size limit is refused", async () => {
    const d = await vaultWithDevice(h);
    const res = await d.call("POST", records(d), { epoch: 1, records: [{ id: newId(), baseRev: 0, blob: blob(LIMITS.recordBytes + 3) }] });
    expect(res.status).toBe(413);
  });

  test("a push that would take the vault over its byte limit lands nothing", async () => {
    const d = await vaultWithDevice(h);
    const count = Math.ceil(LIMITS.vaultBytes / LIMITS.recordBytes) + 1;
    const batch = Array.from({ length: count }, () => ({ id: newId(), baseRev: 0, blob: blob(LIMITS.recordBytes - 3) }));
    const res = await d.call("POST", records(d), { epoch: 1, records: batch });
    expect(res.status).toBe(413);
    expect((await body(res)).error).toBe("vault_full");
    const pulled = await body(await d.call("GET", `${records(d)}?since=0`));
    expect(pulled.head).toBe(0);
    expect(pulled.records).toEqual([]);
  });

  test("a device is rate limited", async () => {
    const d = await vaultWithDevice(h);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await d.call("GET", records(d))).status;
    expect(last).toBe(429);
    h.clock.t += 61_000;
    expect((await d.call("GET", records(d))).status).toBe(200);
  });
});

describe("devices", () => {
  test("an added device can read its sealed key and the vault", async () => {
    const a = await vaultWithDevice(h);
    const b = await addDevice(h, a);
    expect((await b.call("GET", `/v1/vaults/${b.vaultId}/keys`)).status).toBe(200);
    const list = await body(await b.call("GET", `/v1/vaults/${b.vaultId}/devices`));
    expect(list.devices.map((x: { id: string; addedBy: string | null }) => [x.id, x.addedBy])).toEqual([
      [a.id, null],
      [b.id, a.id],
    ]);
  });

  test("a device removes itself, but not the last one, and not another", async () => {
    const a = await vaultWithDevice(h);
    const b = await addDevice(h, a);
    expect((await a.call("DELETE", `/v1/vaults/${a.vaultId}/devices/${b.id}`)).status).toBe(403);
    expect((await b.call("DELETE", `/v1/vaults/${b.vaultId}/devices/${b.id}`)).status).toBe(204);
    expect((await b.call("GET", records(b))).status).toBe(401);
    const last = await a.call("DELETE", `/v1/vaults/${a.vaultId}/devices/${a.id}`);
    expect(last.status).toBe(409);
    expect((await body(last)).error).toBe("last_device");
  });

  test("deleting the vault removes everything", async () => {
    const a = await vaultWithDevice(h);
    await a.call("POST", records(a), { epoch: 1, records: [{ id: newId(), baseRev: 0, blob: blob() }] });
    expect((await a.call("DELETE", `/v1/vaults/${a.vaultId}`)).status).toBe(204);
    expect((await a.call("GET", records(a))).status).toBe(401);
    expect((await a.createVault()).status).toBe(201);
  });
});

describe("rotation", () => {
  async function setup() {
    const a = await vaultWithDevice(h);
    const b = await addDevice(h, a);
    const c = await addDevice(h, a);
    await a.call("POST", records(a), {
      epoch: 1,
      records: [
        { id: newId(), baseRev: 0, blob: blob() },
        { id: newId(), baseRev: 0, blob: blob() },
      ],
    });
    return { a, b, c };
  }

  test("replaces every record, the sealed keys, and removes the device, in one step", async () => {
    const { a, b, c } = await setup();
    const fresh = [newId(), newId()];
    const res = await a.call("POST", `/v1/vaults/${a.vaultId}/epochs`, {
      baseRevision: 2,
      epoch: 2,
      removeDevices: [c.id],
      sealedKeys: { [a.id]: blob(80), [b.id]: blob(80) },
      sealedNames: { [a.id]: blob(40), [b.id]: blob(40) },
      records: fresh.map((id) => ({ id, blob: blob() })),
    });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ epoch: 2, head: 4 });

    expect((await c.call("GET", records(c))).status).toBe(401);
    expect((await body(await b.call("GET", `/v1/vaults/${b.vaultId}/keys`))).epoch).toBe(2);

    const full = await body(await b.call("GET", `${records(b)}?since=0`));
    expect(full.epoch).toBe(2);
    expect(full.records.map((r: { id: string }) => r.id)).toEqual(fresh);

    // A cursor from before the rotation must start again.
    const behind = await b.call("GET", `${records(b)}?since=1`);
    expect(behind.status).toBe(409);
    expect((await body(behind)).error).toBe("full_pull_required");
    // A device that was fully synced just before sees every new record.
    expect((await body(await b.call("GET", `${records(b)}?since=2`))).records.length).toBe(2);

    expect((await b.call("POST", records(b), { epoch: 1, records: [{ id: newId(), baseRev: 0, blob: blob() }] })).status).toBe(409);
  });

  test("needs a key for exactly the devices that stay", async () => {
    const { a, b } = await setup();
    const res = await a.call("POST", `/v1/vaults/${a.vaultId}/epochs`, {
      baseRevision: 2,
      epoch: 2,
      removeDevices: [],
      sealedKeys: { [a.id]: blob(80), [b.id]: blob(80) },
      sealedNames: { [a.id]: blob(40), [b.id]: blob(40) },
      records: [],
    });
    expect(res.status).toBe(400);
    expect((await body(res)).message).toContain("every device that stays");
  });

  test("must name the next epoch, and cannot remove the caller", async () => {
    const { a, b, c } = await setup();
    const skip = await a.call("POST", `/v1/vaults/${a.vaultId}/epochs`, {
      baseRevision: 2,
      epoch: 3,
      removeDevices: [c.id],
      sealedKeys: { [a.id]: blob(80), [b.id]: blob(80) },
      sealedNames: { [a.id]: blob(40), [b.id]: blob(40) },
      records: [],
    });
    expect(skip.status).toBe(409);
    const self = await a.call("POST", `/v1/vaults/${a.vaultId}/epochs`, {
      baseRevision: 2,
      epoch: 2,
      removeDevices: [a.id],
      sealedKeys: { [b.id]: blob(80), [c.id]: blob(80) },
      sealedNames: { [b.id]: blob(40), [c.id]: blob(40) },
      records: [],
    });
    expect(self.status).toBe(403);
  });

  test("a rotation based on an older head is refused, so a record pushed since is never dropped", async () => {
    const { a, b, c } = await setup();
    // b pushes after a pulled at revision 2.
    await b.call("POST", records(b), { epoch: 1, records: [{ id: newId(), baseRev: 0, blob: blob() }] });
    const stale = await a.call("POST", `/v1/vaults/${a.vaultId}/epochs`, {
      baseRevision: 2,
      epoch: 2,
      removeDevices: [c.id],
      sealedKeys: { [a.id]: blob(80), [b.id]: blob(80) },
      sealedNames: { [a.id]: blob(40), [b.id]: blob(40) },
      records: [{ id: newId(), blob: blob() }],
    });
    expect(stale.status).toBe(409);
    expect((await body(stale)).error).toBe("vault_moved");
    // Nothing changed: still epoch 1, all three records, c still in.
    const full = await body(await a.call("GET", `${records(a)}?since=0`));
    expect(full.epoch).toBe(1);
    expect(full.records.length).toBe(3);
    expect((await c.call("GET", records(c))).status).toBe(200);
    expect((await a.call("POST", `/v1/vaults/${a.vaultId}/epochs`, { epoch: 2, removeDevices: [], sealedKeys: {},
      sealedNames: {}, records: [] })).status).toBe(400);
  });

  test("re-seals every remaining device's name with the new key, and needs one for each", async () => {
    const { a, b, c } = await setup();
    const names = { [a.id]: blob(41), [b.id]: blob(42) };
    const missing = await a.call("POST", `/v1/vaults/${a.vaultId}/epochs`, {
      baseRevision: 2,
      epoch: 2,
      removeDevices: [c.id],
      sealedKeys: { [a.id]: blob(80), [b.id]: blob(80) },
      sealedNames: { [a.id]: names[a.id] },
      records: [],
    });
    expect(missing.status).toBe(400);
    expect((await body(missing)).message).toContain("sealedNames");
    const ok = await a.call("POST", `/v1/vaults/${a.vaultId}/epochs`, {
      baseRevision: 2,
      epoch: 2,
      removeDevices: [c.id],
      sealedKeys: { [a.id]: blob(80), [b.id]: blob(80) },
      sealedNames: names,
      records: [],
    });
    expect(ok.status).toBe(200);
    const devices = (await body(await b.call("GET", `/v1/vaults/${b.vaultId}/devices`))).devices as { id: string; sealedName: string }[];
    expect(Object.fromEntries(devices.map((d) => [d.id, d.sealedName]))).toEqual(names);
  });

  test("a failed rotation changes nothing", async () => {
    const { a, b, c } = await setup();
    const res = await a.call("POST", `/v1/vaults/${a.vaultId}/epochs`, {
      baseRevision: 2,
      epoch: 2,
      removeDevices: [c.id, newId()],
      sealedKeys: { [a.id]: blob(80), [b.id]: blob(80) },
      sealedNames: { [a.id]: blob(40), [b.id]: blob(40) },
      records: [],
    });
    expect(res.status).toBe(404);
    expect((await c.call("GET", records(c))).status).toBe(200);
    expect((await body(await a.call("GET", `${records(a)}?since=0`))).records.length).toBe(2);
  });
});

describe("pairing", () => {
  test("the full flow: open, answer, read, accept", async () => {
    const a = await vaultWithDevice(h);
    const pairingId = newId();
    expect((await a.call("POST", `/v1/vaults/${a.vaultId}/pairings`, { pairingId })).status).toBe(201);

    expect(await body(await anonymous(h, "GET", `/v1/pairings/${pairingId}`))).toEqual({ state: "waiting" });
    const payload = blob(200);
    expect((await anonymous(h, "PUT", `/v1/pairings/${pairingId}`, { payload })).status).toBe(204);
    // One answer only: a second device cannot replace the first one's keys.
    const second = await anonymous(h, "PUT", `/v1/pairings/${pairingId}`, { payload: blob(200) });
    expect(second.status).toBe(409);
    expect((await body(second)).error).toBe("pairing_used");

    expect((await body(await a.call("GET", `/v1/vaults/${a.vaultId}/pairings/${pairingId}`))).payload).toBe(payload);

    const b = new Device(h, a.vaultId);
    // Accepting a pairing must carry the confirmation the new device will check.
    const unconfirmed = await a.call("POST", `/v1/vaults/${a.vaultId}/devices`, { device: b.input(), epoch: 1, sealedKey: blob(80), pairingId });
    expect(unconfirmed.status).toBe(400);
    const short = await a.call("POST", `/v1/vaults/${a.vaultId}/devices`, {
      device: b.input(),
      epoch: 1,
      sealedKey: blob(80),
      pairingId,
      confirmation: blob(16),
    });
    expect(short.status).toBe(400);
    const confirmation = blob(32);
    const added = await a.call("POST", `/v1/vaults/${a.vaultId}/devices`, {
      device: b.input(),
      epoch: 1,
      sealedKey: blob(80),
      pairingId,
      confirmation,
    });
    expect(added.status).toBe(201);
    expect(await body(await anonymous(h, "GET", `/v1/pairings/${pairingId}`))).toEqual({
      state: "accepted",
      vaultId: a.vaultId,
      confirmation,
    });
    expect((await b.call("GET", `/v1/vaults/${b.vaultId}/keys`)).status).toBe(200);

    const reuse = await a.call("POST", `/v1/vaults/${a.vaultId}/devices`, {
      device: new Device(h, a.vaultId).input(),
      epoch: 1,
      sealedKey: blob(80),
      pairingId,
      confirmation: blob(32),
    });
    expect(reuse.status).toBe(409);
  });

  test("a slot nobody opened cannot be answered, and slots expire", async () => {
    const a = await vaultWithDevice(h);
    expect((await anonymous(h, "PUT", `/v1/pairings/${newId()}`, { payload: blob() })).status).toBe(404);
    const pairingId = newId();
    await a.call("POST", `/v1/vaults/${a.vaultId}/pairings`, { pairingId });
    h.clock.t += TIMING.pairingTtlMs + 1;
    expect((await anonymous(h, "GET", `/v1/pairings/${pairingId}`)).status).toBe(404);
    expect((await anonymous(h, "PUT", `/v1/pairings/${pairingId}`, { payload: blob() })).status).toBe(404);
  });

  test("a declined pairing is deleted, and the new device sees 404", async () => {
    const a = await vaultWithDevice(h);
    const pairingId = newId();
    await a.call("POST", `/v1/vaults/${a.vaultId}/pairings`, { pairingId });
    await anonymous(h, "PUT", `/v1/pairings/${pairingId}`, { payload: blob() });
    expect((await a.call("DELETE", `/v1/vaults/${a.vaultId}/pairings/${pairingId}`)).status).toBe(204);
    expect((await anonymous(h, "GET", `/v1/pairings/${pairingId}`)).status).toBe(404);
  });

  test("another vault cannot read the slot", async () => {
    const a = await vaultWithDevice(h);
    const other = await vaultWithDevice(h);
    const pairingId = newId();
    await a.call("POST", `/v1/vaults/${a.vaultId}/pairings`, { pairingId });
    expect((await other.call("GET", `/v1/vaults/${other.vaultId}/pairings/${pairingId}`)).status).toBe(404);
  });

  test("at most three open codes per vault", async () => {
    const a = await vaultWithDevice(h);
    for (let i = 0; i < 3; i++) {
      expect((await a.call("POST", `/v1/vaults/${a.vaultId}/pairings`, { pairingId: newId() })).status).toBe(201);
    }
    expect((await a.call("POST", `/v1/vaults/${a.vaultId}/pairings`, { pairingId: newId() })).status).toBe(429);
  });
});

describe("maintenance", () => {
  test("drops old tombstones and sends lagging devices back to a full pull", async () => {
    const d = await vaultWithDevice(h);
    const [gone, kept] = [newId(), newId()];
    await d.call("POST", records(d), {
      epoch: 1,
      records: [
        { id: gone, baseRev: 0, blob: blob() },
        { id: kept, baseRev: 0, blob: blob() },
      ],
    });
    await d.call("POST", records(d), { epoch: 1, records: [{ id: gone, baseRev: 1, blob: null }] });
    h.clock.t += TIMING.tombstoneTtlMs + 1;
    h.app.maintain();

    const behind = await d.call("GET", `${records(d)}?since=1`);
    expect(behind.status).toBe(409);
    const full = await body(await d.call("GET", `${records(d)}?since=0`));
    expect(full.records.map((r: { id: string }) => r.id)).toEqual([kept]);
    // Paging a full pull past the pruned point still works.
    expect((await d.call("GET", `${records(d)}?since=1&full=1`)).status).toBe(200);
    expect((await d.call("GET", `${records(d)}?since=3`)).status).toBe(200);
  });
});

describe("access log labels", () => {
  test("known routes get a fixed label with IDs as :id; anything else is (unknown)", () => {
    const id = newId();
    expect(h.app.routeLabel("GET", `/v1/vaults/${id}/records`)).toBe("/v1/vaults/:id/records");
    expect(h.app.routeLabel("delete", `/v1/vaults/${id}/devices/${id}`)).toBe("/v1/vaults/:id/devices/:id");
    expect(h.app.routeLabel("GET", "/v1/health")).toBe("/v1/health");
    expect(h.app.routeLabel("GET", "/v1/private-name")).toBe("(unknown)");
    expect(h.app.routeLabel("GET", "/v1/vaults/not-an-id/records")).toBe("(unknown)");
    expect(h.app.routeLabel("PATCH", `/v1/vaults/${id}/records`)).toBe("(unknown)");
    expect(h.app.routeLabel("GET", "/secret/path")).toBe("(unknown)");
  });
});

describe("the certificate route", () => {
  test("GET /v1/certificate returns the certificate when the server has one", async () => {
    const der = randomBytes(300);
    const db = openDatabase(":memory:");
    try {
      const app = createApp({ db, version: "test", certificate: () => der });
      const res = await app.fetch(new Request("http://server/v1/certificate"), "10.0.0.2");
      expect(res.status).toBe(200);
      expect(await body(res)).toEqual({ certificate: der.toString("base64") });
      expect(app.routeLabel("GET", "/v1/certificate")).toBe("/v1/certificate");
    } finally {
      db.close();
    }
  });

  test("is 404 not_found without one", async () => {
    const res = await anonymous(h, "GET", "/v1/certificate");
    expect(res.status).toBe(404);
    expect((await body(res)).error).toBe("not_found");
    const db = openDatabase(":memory:");
    try {
      const app = createApp({ db, version: "test", certificate: () => null });
      expect((await app.fetch(new Request("http://server/v1/certificate"), "10.0.0.2")).status).toBe(404);
    } finally {
      db.close();
    }
  });
});

describe("parseArgs: TLS", () => {
  const LE = "https://acme-v02.api.letsencrypt.org/directory";

  test("plain HTTP by default", () => {
    expect(parseArgs([], {})).toMatchObject({ hostname: "127.0.0.1", port: 8787, tls: { mode: "off" } });
  });

  test("--tls self names localhost, 127.0.0.1, the listen host and each --tls-name", () => {
    expect(parseArgs(["--tls", "self"], {})).toMatchObject({ tls: { mode: "self", names: ["localhost", "127.0.0.1"] } });
    expect(parseArgs([], { KERSTEL_SERVER_TLS: "self" })).toMatchObject({ tls: { mode: "self", names: ["localhost", "127.0.0.1"] } });
    expect(
      parseArgs(["--tls", "self", "--listen", "192.168.1.20:8787", "--tls-name", "homebox.local", "--tls-name", "10.0.0.5"], {}),
    ).toMatchObject({ tls: { mode: "self", names: ["localhost", "127.0.0.1", "192.168.1.20", "homebox.local", "10.0.0.5"] } });
    expect(
      parseArgs([], { KERSTEL_SERVER_TLS: "self", KERSTEL_SERVER_TLS_NAMES: "homebox.local, *.home.arpa ,10.0.0.5" }),
    ).toMatchObject({ tls: { mode: "self", names: ["localhost", "127.0.0.1", "homebox.local", "*.home.arpa", "10.0.0.5"] } });
    // A flag replaces the environment's list.
    expect(
      parseArgs(["--tls-name", "nas.local"], { KERSTEL_SERVER_TLS: "self", KERSTEL_SERVER_TLS_NAMES: "homebox.local" }),
    ).toMatchObject({ tls: { mode: "self", names: ["localhost", "127.0.0.1", "nas.local"] } });
  });

  test("a wildcard or already listed listen host is not added twice, and IPv6 is written one way", () => {
    for (const listen of ["0.0.0.0:8787", "[::]:8787", "127.0.0.1:8787", "localhost:8787"]) {
      expect(parseArgs(["--tls", "self", "--listen", listen], {})).toMatchObject({
        tls: { mode: "self", names: ["localhost", "127.0.0.1"] },
      });
    }
    expect(
      parseArgs(["--tls", "self", "--listen", "[0:0:0:0:0:0:0:1]:8787", "--tls-name", "::1", "--tls-name", "LOCALHOST"], {}),
    ).toMatchObject({ hostname: "0:0:0:0:0:0:0:1", tls: { mode: "self", names: ["localhost", "127.0.0.1", "::1"] } });
  });

  test("--domain and the ACME options, each with its environment twin", () => {
    expect(parseArgs(["--domain", "sync.example.com"], {})).toMatchObject({
      hostname: "0.0.0.0",
      port: 443,
      tls: { mode: "acme", domain: "sync.example.com", directory: LE, email: null, httpHostname: "0.0.0.0", httpPort: 80 },
    });
    expect(
      parseArgs(
        [
          "--domain",
          "sync.example.com",
          "--acme-directory",
          "https://localhost:14000/dir",
          "--acme-email",
          "me@example.com",
          "--acme-http",
          "127.0.0.1:5002",
          "--listen",
          "127.0.0.1:5001",
        ],
        {},
      ),
    ).toMatchObject({
      hostname: "127.0.0.1",
      port: 5001,
      tls: {
        mode: "acme",
        domain: "sync.example.com",
        directory: "https://localhost:14000/dir",
        email: "me@example.com",
        httpHostname: "127.0.0.1",
        httpPort: 5002,
      },
    });
    expect(
      parseArgs([], {
        KERSTEL_SERVER_DOMAIN: "sync.example.com",
        KERSTEL_SERVER_ACME_DIRECTORY: "https://localhost:14000/dir",
        KERSTEL_SERVER_ACME_EMAIL: "me@example.com",
        KERSTEL_SERVER_ACME_HTTP: "[::]:5002",
      }),
    ).toMatchObject({
      hostname: "0.0.0.0",
      port: 443,
      tls: {
        mode: "acme",
        domain: "sync.example.com",
        directory: "https://localhost:14000/dir",
        email: "me@example.com",
        httpHostname: "::",
        httpPort: 5002,
      },
    });
    // KERSTEL_SERVER_LISTEN wins over the 443 default.
    expect(parseArgs(["--domain", "sync.example.com"], { KERSTEL_SERVER_LISTEN: "127.0.0.1:8443" })).toMatchObject({
      hostname: "127.0.0.1",
      port: 8443,
    });
  });

  test("rejects conflicting or malformed TLS options", () => {
    expect(() => parseArgs(["--tls", "self", "--domain", "sync.example.com"], {})).toThrow("--domain");
    expect(() => parseArgs(["--domain", "sync.example.com"], { KERSTEL_SERVER_TLS: "self" })).toThrow("--domain");
    expect(() => parseArgs(["--tls-name", "homebox.local"], {})).toThrow("--tls self");
    expect(() => parseArgs([], { KERSTEL_SERVER_TLS_NAMES: "homebox.local" })).toThrow("--tls self");
    expect(() => parseArgs(["--tls", "acme"], {})).toThrow("--tls takes only self");
    expect(() => parseArgs([], { KERSTEL_SERVER_TLS: "on" })).toThrow("--tls takes only self");
    for (const name of ["fe80::1%en0", "home_box", "-", "a..b", "foo.*", "*", "bad name", "ünï.example", "a.b.", "192.168.1.256", "127.1", "1.2.3.4.5", "010.0.0.1"]) {
      expect(() => parseArgs(["--tls", "self", "--tls-name", name], {})).toThrow("--tls-name");
    }
    expect(() => parseArgs(["--domain", "*.example.com"], {})).toThrow("--domain");
    expect(() => parseArgs(["--domain", "192.0.2.1"], {})).toThrow("--domain");
    expect(() => parseArgs(["--domain", "sync.example.com", "--acme-http", "80"], {})).toThrow("host:port");
  });
});
