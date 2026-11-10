import type { KeyObject } from "node:crypto";
import {
  HEADERS,
  PROTOCOL_PREFIX,
  signRequest,
  type AddDeviceBody,
  type CreateVaultBody,
  type DeviceOut,
  type PairingSlotOut,
  type PairingStateOut,
  type ErrorBody,
  type PullResponse,
  type PushBody,
  type PushResponse,
  type RotateBody,
} from "../../../server/src/protocol";

/**
 * A signed client for `kerstel-server`. Sync spec §9.2. Every request to a
 * vault is signed with this device's Ed25519 key over the method, the path
 * with its query, the time and the body's hash. `fetch` is injectable, so the
 * tests run against the server in-process.
 */

export type Fetch = (request: Request) => Promise<Response>;

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    /** The server's error code, or `unreachable` when no answer came. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SyncHttpError";
  }
}

export interface ClientOptions {
  server: string;
  vaultId: string;
  deviceId: string;
  sign: KeyObject;
  fetch?: Fetch;
  now?: () => number;
}

/** One request, without following redirects; a non-2xx answer becomes a SyncHttpError. */
async function send<T>(doFetch: Fetch, server: string, method: string, path: string, raw: Uint8Array | null, headers: Record<string, string>): Promise<T> {
  let response: Response;
  try {
    // Never followed: a redirect would carry the enroll token and the
    // signed request to wherever it points, plain http included.
    response = await doFetch(
      new Request(`${server}${PROTOCOL_PREFIX}${path}`, {
        method,
        headers: raw === null ? headers : { ...headers, "content-type": "application/json" },
        body: raw ?? undefined,
        redirect: "manual",
      }),
    );
  } catch (error) {
    throw new SyncHttpError(0, "unreachable", `Could not reach ${server}: ${(error as Error).message}`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new SyncHttpError(
      response.status,
      "redirect",
      `${server} answered with a redirect, which Kerstel does not follow for sync. Use the server's final URL.`,
    );
  }
  const text = await response.text();
  if (!response.ok) {
    let parsed: Partial<ErrorBody> = {};
    try {
      parsed = JSON.parse(text) as ErrorBody;
    } catch {
      // Not the server's JSON: a proxy's page, say. Its status is all there is.
    }
    throw new SyncHttpError(response.status, parsed.error ?? "http", parsed.message ?? `The server answered ${response.status}.`);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

const encode = (body: unknown): Uint8Array | null => (body === undefined ? null : new TextEncoder().encode(JSON.stringify(body)));

export function syncClient(options: ClientOptions) {
  const doFetch: Fetch = options.fetch ?? ((request) => fetch(request));
  const clock = options.now ?? Date.now;
  // Never the same millisecond twice: Ed25519 signatures are deterministic, so
  // two identical requests stamped alike would carry the same signature, and
  // the server refuses the second as a replay.
  let last = 0;
  const now = (): number => (last = Math.max(clock(), last + 1));

  function call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const raw = encode(body);
    const headers = {
      ...signRequest(options.sign, options.deviceId, method, `${PROTOCOL_PREFIX}${path}`, raw ?? new Uint8Array(), now()),
      ...extra,
    };
    return send<T>(doFetch, options.server, method, path, raw, headers);
  }

  const vault = `/vaults/${options.vaultId}`;
  return {
    createVault(body: CreateVaultBody, enrollToken: string | null) {
      return call<{ epoch: number; head: number }>("POST", "/vaults", body, enrollToken ? { [HEADERS.enrollToken]: enrollToken } : {});
    },
    pull(since: number, full: boolean) {
      return call<PullResponse>("GET", `${vault}/records?since=${since}${full ? "&full=1" : ""}`);
    },
    push(body: PushBody) {
      return call<PushResponse>("POST", `${vault}/records`, body);
    },
    keys() {
      return call<{ epoch: number; sealedKey: string }>("GET", `${vault}/keys`);
    },
    devices() {
      return call<{ devices: DeviceOut[] }>("GET", `${vault}/devices`);
    },
    removeSelf() {
      return call<void>("DELETE", `${vault}/devices/${options.deviceId}`);
    },
    deleteVault() {
      return call<void>("DELETE", vault);
    },
    addDevice(body: AddDeviceBody) {
      return call<DeviceOut>("POST", `${vault}/devices`, body);
    },
    rotate(body: RotateBody) {
      return call<{ epoch: number; head: number }>("POST", `${vault}/epochs`, body);
    },
    openPairing(pairingId: string) {
      return call<{ expiresAt: number }>("POST", `${vault}/pairings`, { pairingId });
    },
    readPairing(pairingId: string) {
      return call<PairingSlotOut>("GET", `${vault}/pairings/${pairingId}`);
    },
    closePairing(pairingId: string) {
      return call<void>("DELETE", `${vault}/pairings/${pairingId}`);
    },
  };
}

export type SyncClient = ReturnType<typeof syncClient>;

/**
 * The new device's half of pairing, before it has a key the server knows:
 * unsigned. The answer is sealed with the pairing secret instead.
 */
export function pairingClient(server: string, fetchImpl?: Fetch) {
  const doFetch: Fetch = fetchImpl ?? ((request) => fetch(request));
  return {
    answer(pairingId: string, payload: string) {
      return send<void>(doFetch, server, "PUT", `/pairings/${pairingId}`, encode({ payload }), {});
    },
    state(pairingId: string) {
      return send<PairingStateOut>(doFetch, server, "GET", `/pairings/${pairingId}`, null, {});
    },
  };
}
