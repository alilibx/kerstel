"use strict";

const fs = require("node:fs");
const net = require("node:net");
const { StringDecoder } = require("node:string_decoder");
const { workerData } = require("node:worker_threads");
const { MAX_LINE_CHARS, PROTOCOL_VERSION } = require("./protocol.js");

// `port` is the MessagePort half handed over by the bridge. Results go back on
// it rather than on parentPort, because the bridge drains replies with
// receiveMessageOnPort() while its own thread is blocked in Atomics.wait().
const { socketPath, tokenFile, timeoutMs, control, port } = workerData;

/**
 * The current session token, read from its 0600 file on every request.
 *
 * Per request, not once: the daemon mints a new token each time it starts and
 * removes the file when it stops, so a token cached at boot would go stale the
 * first time the daemon restarted under a long-running app. The file is tiny,
 * requests are memoized per process, and reading it is what keeps the token
 * out of this process's environment and argv altogether. Missing file: send
 * an empty token, which the daemon refuses; that is the honest "no daemon"
 * answer and the caller's error says so.
 */
function readToken() {
  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

const status = new Int32Array(control);

const STATUS_INDEX = 0;
const STATE_DONE = 1;

let socket = null;
let buffer = "";
let counter = 0;
const pending = new Map();

function connect() {
  if (socket) return socket;

  socket = net.createConnection(socketPath);
  socket.setNoDelay(true);
  socket.unref();

  // Pin the connection this closure belongs to. A late "close" from a socket we
  // already replaced must not null out its successor, fail that successor's
  // pending requests, or orphan it with live handlers and nothing watching it.
  const self = socket;

  // One decoder per connection, carried across chunks. chunk.toString("utf8")
  // decodes each chunk in isolation, so a multi-byte character straddling a
  // TCP/pipe boundary -- an "e" in a secret split after its first byte -- is
  // turned into two U+FFFD replacement characters and the value is silently
  // corrupted. StringDecoder holds the incomplete tail back until the rest
  // arrives. A node: builtin, so the hook stays zero-dependency.
  const decoder = new StringDecoder("utf8");

  self.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.length === 0) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter(message);
      }
    }

    // Nothing bounded this before. A daemon that never sends a newline -- a
    // buggy one, or something else that has bound the socket path -- could
    // grow this string until the host application ran out of memory, and the
    // hook lives INSIDE that application. Match the CLI's own cap.
    if (buffer.length > MAX_LINE_CHARS) {
      failAll("Kerstel daemon sent an oversized line");
      self.destroy();
    }
  });

  const failAll = (message) => {
    // Only the live connection may tear down shared state.
    if (socket !== self) return;
    socket = null;
    buffer = "";
    for (const waiter of pending.values()) {
      waiter({ ok: false, error: { code: "unreachable", message } });
    }
    pending.clear();
  };

  self.on("error", (error) => failAll(error.message));
  self.on("close", () => failAll("Daemon connection closed"));

  return self;
}

/** Posts the reply to the bridge and wakes the blocked main thread. */
function reply(seq, ok, payload) {
  // The payload travels by postMessage because it can exceed any fixed buffer,
  // so shared memory carries nothing but the wake-up signal. `seq` echoes the
  // request so a caller that already gave up cannot have its stale answer
  // mistaken for the next request's.
  port.postMessage({ type: "result", seq, ok, payload: JSON.stringify(payload) });

  // postMessage strictly before the store: the bridge re-reads the port after
  // every wake-up, so a reply that is queued first can never be missed. Storing
  // first would open a window where the bridge wakes to an empty port.
  Atomics.store(status, STATUS_INDEX, STATE_DONE);
  Atomics.notify(status, STATUS_INDEX);
}

port.on("message", (request) => {
  // The id of the attempt currently in flight. A retry (below) issues a new
  // one, and the timeout must drop whichever is current.
  let id = null;
  let settled = false;
  const settle = (ok, payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Drop our own entry on EVERY exit path. The data handler deletes only the
    // ids it answers, so without this a request that ends by timeout would
    // leave its waiter behind and the map would grow without bound against a
    // daemon that accepts connections but never replies.
    if (id !== null) pending.delete(id);
    reply(request.seq, ok, payload);
  };

  const timer = setTimeout(() => {
    // Drop whatever partial line is sitting in the buffer. A daemon that
    // answers slowly, or dribbles a line it never terminates, would otherwise
    // leave its fragment there to be prepended to the NEXT request's reply --
    // and across a run of timed-out requests the buffer only ever grows.
    //
    // Safe to clear unconditionally: the bridge blocks its thread on
    // Atomics.wait for the whole round trip, so exactly one request is ever in
    // flight on this connection and there is no concurrent partial line to
    // destroy.
    buffer = "";
    settle(false, { code: "timeout", message: `Kerstel daemon did not answer in ${timeoutMs}ms` });
  }, timeoutMs);
  timer.unref();

  const send = (attempt) => {
    let conn;
    try {
      conn = connect();
    } catch (error) {
      settle(false, { code: "unreachable", message: error.message });
      return;
    }

    id = `w${++counter}`;
    pending.set(id, (message) => {
      if (message.ok) return settle(true, { value: message.value });
      const error = message.error || { code: "internal", message: "Unknown daemon error" };
      // The token file was read moments ago, but the daemon may have restarted
      // in between with a fresh token. One re-read and one more try; a second
      // refusal is a real refusal.
      if (error.code === "unauthorized" && attempt === 0) return send(1);
      settle(false, error);
    });

    const line = `${JSON.stringify({
      v: PROTOCOL_VERSION,
      id,
      token: readToken(),
      op: "resolve",
      scope: request.scope,
      key: request.key,
      pid: request.pid,
      processName: request.processName,
    })}\n`;

    const write = () => conn.write(line);
    if (conn.connecting) conn.once("connect", write);
    else write();
  };

  send(0);
});

// A port handed over through workerData does not deliver messages until started.
port.start();
