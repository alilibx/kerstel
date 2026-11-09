import { generateKeyPairSync, randomBytes } from "node:crypto";
import { openDatabase } from "../src/db";
import { createApp, type App } from "../src/app";
import { generateSigningKey, newId, signRequest, type DeviceInput, type SigningKey } from "../src/protocol";

/** Stand-in ciphertext. The server never opens a blob, so random bytes test it as well as real ones. */
export const blob = (bytes = 300): string => randomBytes(bytes).toString("base64url");

export interface Harness {
  app: App;
  /** For tests that check what a request wrote. */
  db: ReturnType<typeof openDatabase>;
  clock: { t: number };
  close(): void;
}

export function harness(options: { enrollToken?: string } = {}): Harness {
  const db = openDatabase(":memory:");
  const clock = { t: 1_762_560_000_000 };
  const app = createApp({ db, version: "test", enrollToken: options.enrollToken, now: () => clock.t });
  return { app, db, clock, close: () => db.close() };
}

export class Device {
  readonly id = newId();
  readonly key: SigningKey = generateSigningKey();
  readonly encPub = generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x!;
  private n = 0;

  constructor(
    private readonly h: Harness,
    public vaultId: string,
  ) {}

  input(): DeviceInput {
    return { id: this.id, signPub: this.key.publicKey, encPub: this.encPub, sealedName: blob(40) };
  }

  /** A signed request. Each one gets its own timestamp, so no two signatures repeat. */
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const raw = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const signed = signRequest(this.key.privateKey, this.id, method, path, raw, this.h.clock.t + this.n++);
    return this.h.app.fetch(
      new Request(`http://server${path}`, {
        method,
        headers: { ...signed, ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : raw,
      }),
      "10.0.0.1",
    );
  }

  createVault(headers: Record<string, string> = {}): Promise<Response> {
    return this.call("POST", "/v1/vaults", { vaultId: this.vaultId, device: this.input(), sealedKey: blob(80) }, headers);
  }
}

export async function body(response: { json(): Promise<unknown> }): Promise<any> {
  return response.json();
}

/** An unauthenticated request, as a joining device makes before it has a key the server knows. */
export function anonymous(h: Harness, method: string, path: string, payload?: unknown, ip = "10.0.0.2"): Promise<Response> {
  return h.app.fetch(
    new Request(`http://server${path}`, {
      method,
      headers: payload === undefined ? {} : { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
    ip,
  );
}

/** A vault with one device, created. */
export async function vaultWithDevice(h: Harness): Promise<Device> {
  const device = new Device(h, newId());
  const res = await device.createVault();
  if (res.status !== 201) throw new Error(`createVault: ${res.status} ${await res.text()}`);
  return device;
}

/** Adds a second device directly, as the confirming device does once pairing succeeds. */
export async function addDevice(h: Harness, by: Device, epoch = 1): Promise<Device> {
  const added = new Device(h, by.vaultId);
  const res = await by.call("POST", `/v1/vaults/${by.vaultId}/devices`, { device: added.input(), epoch, sealedKey: blob(80) });
  if (res.status !== 201) throw new Error(`addDevice: ${res.status} ${await res.text()}`);
  return added;
}
