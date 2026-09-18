import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { Vault } from "../vault/store";
import {
  LineDecoder,
  PROTOCOL_VERSION,
  encodeMessage,
  errorResponse,
  type Request,
  type Response,
} from "./protocol";
import { tokensMatch } from "./token";

export interface DaemonOptions {
  vault: Vault;
  socketPath: string;
  token: string;
  /** Keychain backend name, reported by `status`. */
  backendName: string;
  /** Relock and stop serving after this long with no requests. Default 8 hours. */
  idleMs?: number;
  onIdle?: () => void;
}

export interface DaemonHandle {
  socketPath: string;
  close(): Promise<void>;
  /**
   * Resolves once THIS server has finished closing, whether `close()` was
   * called locally, by the idle timer, or by a client's `shutdown`. A caller
   * that needs to outlive the server (`daemon serve`) awaits this instead of
   * probing the socket path, which only ever answers "is SOMETHING listening
   * here" -- a question that gets the wrong answer the moment another process
   * binds the same path.
   */
  closed: Promise<void>;
}

const DEFAULT_IDLE_MS = 8 * 60 * 60 * 1000;

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const { vault, socketPath, token, backendName } = options;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const startedAt = Date.now();

  let unlocked = true;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const sockets = new Set<Socket>();

  const lock = (): void => {
    unlocked = false;
  };

  const touchIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      lock();
      options.onIdle?.();
    }, idleMs);
    idleTimer.unref?.();
  };

  function handle(raw: string): Response {
    let message: Partial<Request>;
    try {
      message = JSON.parse(raw) as Partial<Request>;
    } catch {
      return errorResponse("", "bad_request", "Request was not valid JSON");
    }

    const id = typeof message.id === "string" ? message.id : "";

    if (message.v !== PROTOCOL_VERSION) {
      return errorResponse(id, "unsupported_version", `Expected protocol v${PROTOCOL_VERSION}`);
    }
    if (typeof message.token !== "string" || !tokensMatch(message.token, token)) {
      return errorResponse(id, "unauthorized", "Invalid session token");
    }

    touchIdleTimer();

    // Everything below can touch the vault (SQLite I/O), which can throw
    // synchronously for reasons that have nothing to do with the request
    // (a full disk, a corrupted row). An uncaught throw here would escape
    // the `socket.on("data")` listener and take down the whole process,
    // dropping every live session — so every op is guarded, not just the
    // ones we happened to think of first. Keep this generic: never surface
    // the underlying error's message, which can carry a file path or row
    // content.
    try {
      switch (message.op) {
        case "status":
          return {
            v: PROTOCOL_VERSION,
            id,
            ok: true,
            op: "status",
            pid: process.pid,
            unlocked,
            backend: backendName,
            secretCount: vault.listSecrets().length,
            uptimeMs: Date.now() - startedAt,
          };

        case "lock":
          // "Lock" has to mean the key is GONE, not that a boolean says no.
          // The data key lives in this process's memory for as long as the
          // vault is open, so flipping `unlocked` left it sitting in a heap
          // that a core dump, a debugger, or /proc/<pid>/mem still yields --
          // which is precisely what someone typing `lock` is trying to
          // prevent. Take the same path the idle timer takes: ack first, then
          // close, which ends the process and drops the key with it. The next
          // `resolve` auto-starts a fresh daemon that re-reads the keychain.
          lock();
          queueMicrotask(() => void close());
          return { v: PROTOCOL_VERSION, id, ok: true, op: "lock" };

        case "shutdown":
          queueMicrotask(() => void close());
          return { v: PROTOCOL_VERSION, id, ok: true, op: "shutdown" };

        case "resolve": {
          if (!unlocked) {
            return errorResponse(id, "locked", "Vault is locked. Run `kerstel daemon start` to unlock.");
          }
          const { scope, key } = message;
          if (typeof scope !== "string" || typeof key !== "string") {
            return errorResponse(id, "bad_request", "resolve requires string scope and key");
          }

          // Distinct from the outer catch: this tells "wrong key, can't
          // decrypt" apart from "key simply isn't there" (Vault.getSecret's
          // contract), which the generic guard below cannot.
          let value: string | null;
          try {
            value = vault.getSecret({ scope, key });
          } catch {
            return errorResponse(id, "internal", "Could not decrypt the stored value");
          }
          if (value === null) {
            return errorResponse(id, "not_found", `No secret at kerstel://${scope}/${key}`);
          }

          vault.appendAudit({
            ts: Date.now(),
            event: "resolve",
            scope,
            key,
            pid: typeof message.pid === "number" ? message.pid : null,
            processName: typeof message.processName === "string" ? message.processName : null,
          });

          return { v: PROTOCOL_VERSION, id, ok: true, op: "resolve", value };
        }

        default:
          return errorResponse(id, "bad_request", `Unknown op "${String(message.op)}"`);
      }
    } catch {
      return errorResponse(id, "internal", "Internal server error");
    }
  }

  // A socket file left behind by a crashed daemon would block bind().
  if (process.platform !== "win32" && existsSync(socketPath)) rmSync(socketPath, { force: true });

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const decoder = new LineDecoder();

    socket.on("data", (chunk) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (error) {
        socket.write(encodeMessage(errorResponse("", "bad_request", (error as Error).message)));
        socket.end();
        return;
      }
      for (const line of lines) {
        const response = handle(line);
        socket.write(encodeMessage(response));
        // A malformed request (bad JSON) has no recoverable id, so the reply
        // carries id: "" and a client matching replies by id can never pair
        // it up. End the connection after flushing the reply — same
        // treatment as the oversized-line path above — so the client's own
        // close handling deterministically rejects the stranded request
        // instead of leaving it silently unmatched.
        if (!response.ok && response.id === "") {
          socket.end();
          break;
        }
      }
    });

    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  if (process.platform !== "win32") chmodSync(socketPath, 0o600);
  touchIdleTimer();

  let signalClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    signalClosed = resolve;
  });

  async function close(): Promise<void> {
    if (idleTimer) clearTimeout(idleTimer);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") rmSync(socketPath, { force: true });
    // Last, so anything awaiting `closed` observes a fully torn-down server.
    // Resolving a promise twice is a no-op, so a second close() is harmless.
    signalClosed();
  }

  return { socketPath, close, closed };
}
