import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { basename } from "node:path";
import { socketPath as defaultSocketPath } from "../paths";
import { cliName } from "../ui/cli-name";
import {
  LineDecoder,
  PROTOCOL_VERSION,
  encodeMessage,
  type ErrorCode,
  type Response,
  type StatusOk,
} from "./protocol";
import { daemonServeCommand } from "./spawn";
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
    throw new DaemonError("unauthorized", `No session token found. Run \`${cliName()} daemon start\`.`);
  }

  // Same short-circuit, and for the same reason, as isDaemonRunning() below:
  // "no daemon has ever been started" is the overwhelmingly common case, and a
  // stat beats building a socket, waiting out a connect, and unwinding an
  // error. It is an optimization, not a correctness guard -- on Bun 1.3.10 a
  // connect to a missing Unix socket path rejects normally through the "error"
  // event below, so removing this check would cost latency, not safety.
  // (Windows named pipes are not files, so the check is Unix-only.)
  if (process.platform !== "win32" && !existsSync(sock)) {
    throw new DaemonError("unreachable", `Kerstel daemon is not running (no socket at ${sock})`);
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

  let closed = false;

  const fail = (error: Error): void => {
    closed = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  socket.on("data", (chunk) => {
    let lines: string[];
    try {
      lines = decoder.push(chunk);
    } catch {
      // LineDecoder throws past MAX_LINE_CHARS. This runs inside a "data"
      // listener, so an escaping throw is an uncaught exception that kills the
      // whole client PROCESS -- not just this request. The server guards its
      // own decoder the same way (server.ts). Reject everything in flight with
      // a code the caller can act on, then drop the connection: the stream's
      // framing is unrecoverable once a line is this long, and `fail()` has
      // already latched `closed` so no further request can be sent.
      fail(
        new DaemonError(
          "internal",
          "The Kerstel daemon sent a message larger than the protocol allows; the connection was dropped.",
        ),
      );
      socket.destroy();
      return;
    }

    for (const line of lines) {
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
  socket.on("error", (error) => fail(new DaemonError("unreachable", (error as Error).message)));
  socket.on("close", () => fail(new DaemonError("unreachable", "Daemon connection closed")));

  function send(payload: Record<string, unknown>): Promise<Response> {
    if (closed || socket.destroyed || !socket.writable) {
      return Promise.reject(
        new DaemonError("unreachable", "The daemon connection is closed. Reconnect with connectDaemon()."),
      );
    }
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

    /**
     * Drops the vault key by shutting the daemon down.
     *
     * "Lock" cannot be a flag: the key is resident in the daemon's memory for
     * as long as it serves, so the only way to really drop it is to end that
     * process. The daemon therefore stops accepting connections after this
     * call, exactly as `shutdown` does; the next resolution auto-starts a
     * fresh one that re-reads the keychain.
     */
    async lock() {
      try {
        unwrap(await send({ op: "lock" }));
      } catch (error) {
        // Same race as shutdown(): the daemon may close the socket before the
        // ack lands, which is success, not failure.
        if (!(error instanceof DaemonError) || error.code !== "unreachable") throw error;
      }
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
      closed = true;
      socket.destroy();
    },
  };
}

/**
 * Stops the daemon on the default socket, if one answers, and returns whether
 * it did. `shutdown()` returns once the request is sent, not once the daemon
 * has let go of the vault and socket, so this waits (up to 5s) for the socket
 * to stop answering: `uninstall` deletes the home right after, and `update`
 * wants the next resolution to start the new binary, not race the old one.
 * Shared by `daemon stop`, `uninstall`, and `update`.
 */
export async function stopDaemonIfRunning(): Promise<boolean> {
  if (!(await isDaemonRunning())) return false;
  const client = await connectDaemon();
  await client.shutdown();
  client.close();
  for (let waited = 0; waited < 5000 && (await isDaemonRunning()); waited += 100) {
    await Bun.sleep(100);
  }
  return true;
}

export async function isDaemonRunning(sock: string = defaultSocketPath()): Promise<boolean> {
  // The overwhelmingly common case is "no daemon running at all" -- a socket
  // file that was never created. Short-circuit on that without touching
  // node:net, because a stat is cheaper than a connect that is going to fail.
  // Purely an optimization: on Bun 1.3.10 a connect to a missing Unix socket
  // path reports ENOENT through the "error" event below like any other connect
  // failure. (Named pipes on Windows aren't regular files, so this check only
  // applies to the Unix socket path.)
  if (process.platform !== "win32" && !existsSync(sock)) return false;

  return new Promise((resolve) => {
    let settled = false;
    let conn: Socket | undefined;
    const done = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done(false), 1_000);
    timer.unref?.();

    try {
      conn = createConnection(sock);
      conn.once("connect", () => done(true));
      // Not `.once`: a socket already destroyed by `done()` above (e.g. after
      // the connect timeout, or after a first error) can still emit a stray
      // async error afterwards -- with no listener left, that throws instead
      // of being ignorable, which is exactly the case of connecting to a
      // socket file that existed and was removed out from under us (a
      // daemon shutting down mid-poll).
      conn.on("error", () => done(false));
    } catch {
      // Bun's Unix-socket connect can fail synchronously (not just via the
      // "error" event) when the path plain doesn't exist -- the ordinary,
      // most common case of "no daemon running". Either way, no daemon.
      done(false);
    }
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

  const command = options.spawnCommand ?? daemonServeCommand();
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
    `Could not start the Kerstel daemon. Try \`${cliName()} daemon start\` manually. (${String(lastError)})`,
  );
}
