import { createConnection, type Socket } from "node:net";
import { basename } from "node:path";
import { socketPath as defaultSocketPath } from "../paths";
import {
  LineDecoder,
  PROTOCOL_VERSION,
  encodeMessage,
  type ErrorCode,
  type Response,
  type StatusOk,
} from "./protocol";
import { readToken } from "./token";

export class DaemonError extends Error {
  constructor(
    public readonly code: ErrorCode | "unreachable",
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export interface DaemonClient {
  resolve(scope: string, key: string, meta?: { pid?: number; processName?: string }): Promise<string>;
  status(): Promise<StatusOk>;
  lock(): Promise<void>;
  shutdown(): Promise<void>;
  close(): void;
}

export interface ConnectOptions {
  socketPath?: string;
  token?: string;
  timeoutMs?: number;
}

export async function connectDaemon(options: ConnectOptions = {}): Promise<DaemonClient> {
  const sock = options.socketPath ?? defaultSocketPath();
  const token = options.token ?? readToken();
  const timeoutMs = options.timeoutMs ?? 5_000;

  if (!token) {
    throw new DaemonError("unauthorized", "No session token found. Run `kerstel daemon start`.");
  }

  const socket = await new Promise<Socket>((resolve, reject) => {
    const conn = createConnection(sock);
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new DaemonError("unreachable", `Timed out connecting to the Kerstel daemon at ${sock}`));
    }, timeoutMs);

    conn.once("connect", () => {
      clearTimeout(timer);
      resolve(conn);
    });
    conn.once("error", (error) => {
      clearTimeout(timer);
      reject(new DaemonError("unreachable", `Kerstel daemon is not running (${(error as Error).message})`));
    });
  });

  const pending = new Map<string, { resolve(r: Response): void; reject(e: Error): void }>();
  const decoder = new LineDecoder();
  let counter = 0;

  socket.on("data", (chunk) => {
    for (const line of decoder.push(chunk)) {
      let response: Response;
      try {
        response = JSON.parse(line) as Response;
      } catch {
        continue;
      }
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        waiter.resolve(response);
      }
    }
  });

  const fail = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  socket.on("error", (error) => fail(new DaemonError("unreachable", (error as Error).message)));
  socket.on("close", () => fail(new DaemonError("unreachable", "Daemon connection closed")));

  function send(payload: Record<string, unknown>): Promise<Response> {
    const id = `${process.pid}-${++counter}`;
    return new Promise<Response>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.write(encodeMessage({ v: PROTOCOL_VERSION, id, token, ...payload }));
    });
  }

  function unwrap(response: Response): Response {
    if (response.ok === false) throw new DaemonError(response.error.code, response.error.message);
    return response;
  }

  return {
    async resolve(scope, key, meta) {
      const response = unwrap(
        await send({
          op: "resolve",
          scope,
          key,
          pid: meta?.pid ?? process.pid,
          processName: meta?.processName ?? basename(process.argv[0] ?? "unknown"),
        }),
      );
      if (!("value" in response)) throw new DaemonError("internal", "Malformed resolve response");
      return response.value;
    },

    async status() {
      const response = unwrap(await send({ op: "status" }));
      if (!("unlocked" in response)) throw new DaemonError("internal", "Malformed status response");
      return response;
    },

    async lock() {
      unwrap(await send({ op: "lock" }));
    },

    async shutdown() {
      try {
        unwrap(await send({ op: "shutdown" }));
      } catch (error) {
        // The daemon may close the socket before the reply lands; that is success.
        if (!(error instanceof DaemonError) || error.code !== "unreachable") throw error;
      }
    },

    close() {
      socket.destroy();
    },
  };
}

export async function isDaemonRunning(sock: string = defaultSocketPath()): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection(sock);
    const done = (result: boolean): void => {
      conn.destroy();
      resolve(result);
    };
    conn.once("connect", () => done(true));
    conn.once("error", () => done(false));
    setTimeout(() => done(false), 1_000).unref?.();
  });
}

export interface EnsureOptions {
  /** Command used to start the daemon. Defaults to this executable. */
  spawnCommand?: string[];
  timeoutMs?: number;
}

/**
 * Returns a connected client, starting a detached daemon first when none is
 * listening. Polls rather than racing so a daemon started by another process
 * in the same moment is reused.
 */
export async function ensureDaemon(options: EnsureOptions = {}): Promise<DaemonClient> {
  try {
    return await connectDaemon({ timeoutMs: 1_000 });
  } catch {
    // Fall through and start one.
  }

  const command = options.spawnCommand ?? [process.execPath, "daemon", "serve"];
  Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();

  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    await Bun.sleep(100);
    try {
      return await connectDaemon({ timeoutMs: 1_000 });
    } catch (error) {
      lastError = error;
    }
  }

  throw new DaemonError(
    "unreachable",
    `Could not start the Kerstel daemon. Try \`kerstel daemon start\` manually. (${String(lastError)})`,
  );
}
