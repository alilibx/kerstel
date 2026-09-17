"use strict";

const net = require("node:net");
const { workerData } = require("node:worker_threads");
const { PROTOCOL_VERSION } = require("./protocol.js");

// `port` is the MessagePort half handed over by the bridge. Results go back on
// it rather than on parentPort, because the bridge drains replies with
// receiveMessageOnPort() while its own thread is blocked in Atomics.wait().
const { socketPath, token, timeoutMs, control, port } = workerData;

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

  self.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
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
  const id = `w${++counter}`;
  let settled = false;
  const settle = (ok, payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Drop our own entry on EVERY exit path. The data handler deletes only the
    // ids it answers, so without this a request that ends by timeout would
    // leave its waiter behind and the map would grow without bound against a
    // daemon that accepts connections but never replies.
    pending.delete(id);
    reply(request.seq, ok, payload);
  };

  const timer = setTimeout(() => {
    settle(false, { code: "timeout", message: `Kerstel daemon did not answer in ${timeoutMs}ms` });
  }, timeoutMs);
  timer.unref();

  let conn;
  try {
    conn = connect();
  } catch (error) {
    settle(false, { code: "unreachable", message: error.message });
    return;
  }

  pending.set(id, (message) => {
    if (message.ok) settle(true, { value: message.value });
    else settle(false, message.error || { code: "internal", message: "Unknown daemon error" });
  });

  const line = `${JSON.stringify({
    v: PROTOCOL_VERSION,
    id,
    token,
    op: "resolve",
    scope: request.scope,
    key: request.key,
    pid: request.pid,
    processName: request.processName,
  })}\n`;

  const write = () => conn.write(line);
  if (conn.connecting) conn.once("connect", write);
  else write();
});

// A port handed over through workerData does not deliver messages until started.
port.start();
