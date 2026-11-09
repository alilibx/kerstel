import type { KeyObject } from "node:crypto";
import {
  HEADERS,
  PROTOCOL_PREFIX,
  signRequest,
  type CreateVaultBody,
  type DeviceOut,
  type ErrorBody,
  type PullResponse,
  type PushBody,
  type PushResponse,
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

export function syncClient(options: ClientOptions) {
  const doFetch: Fetch = options.fetch ?? ((request) => fetch(request));
  const clock = options.now ?? Date.now;
  // Never the same millisecond twice: Ed25519 signatures are deterministic, so
  // two identical requests stamped alike would carry the same signature, and
  // the server refuses the second as a replay.
  let last = 0;
  const now = (): number => (last = Math.max(clock(), last + 1));

  async function call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const raw = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const headers = {
      ...signRequest(options.sign, options.deviceId, method, `${PROTOCOL_PREFIX}${path}`, raw, now()),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extra,
    };
    let response: Response;
    try {
      response = await doFetch(
        new Request(`${options.server}${PROTOCOL_PREFIX}${path}`, { method, headers, body: body === undefined ? undefined : raw }),
      );
    } catch (error) {
      throw new SyncHttpError(0, "unreachable", `Could not reach ${options.server}: ${(error as Error).message}`);
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
  };
}

export type SyncClient = ReturnType<typeof syncClient>;
