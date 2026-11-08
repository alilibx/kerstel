import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
      epoch: 2,
      removeDevices: [c.id],
      sealedKeys: { [a.id]: blob(80), [b.id]: blob(80) },
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
      epoch: 2,
      removeDevices: [],
      sealedKeys: { [a.id]: blob(80), [b.id]: blob(80) },
      records: [],
    });
    expect(res.status).toBe(400);
    expect((await body(res)).message).toContain("every device that stays");
  });

  test("must name the next epoch, and cannot remove the caller", async () => {
    const { a, b, c } = await setup();
    const skip = await a.call("POST", `/v1/vaults/${a.vaultId}/epochs`, {
      epoch: 3,
      removeDevices: [c.id],
      sealedKeys: { [a.id]: blob(80), [b.id]: blob(80) },
      records: [],
    });
    expect(skip.status).toBe(409);
    const self = await a.call("POST", `/v1/vaults/${a.vaultId}/epochs`, {
      epoch: 2,
      removeDevices: [a.id],
      sealedKeys: { [b.id]: blob(80), [c.id]: blob(80) },
      records: [],
    });
    expect(self.status).toBe(403);
  });

  test("a failed rotation changes nothing", async () => {
    const { a, b, c } = await setup();
    const res = await a.call("POST", `/v1/vaults/${a.vaultId}/epochs`, {
      epoch: 2,
      removeDevices: [c.id, newId()],
      sealedKeys: { [a.id]: blob(80), [b.id]: blob(80) },
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
    const added = await a.call("POST", `/v1/vaults/${a.vaultId}/devices`, { device: b.input(), epoch: 1, sealedKey: blob(80), pairingId });
    expect(added.status).toBe(201);
    expect(await body(await anonymous(h, "GET", `/v1/pairings/${pairingId}`))).toEqual({ state: "accepted", vaultId: a.vaultId });
    expect((await b.call("GET", `/v1/vaults/${b.vaultId}/keys`)).status).toBe(200);

    const reuse = await a.call("POST", `/v1/vaults/${a.vaultId}/devices`, {
      device: new Device(h, a.vaultId).input(),
      epoch: 1,
      sealedKey: blob(80),
      pairingId,
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
