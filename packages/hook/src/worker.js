"use strict";

const net = require("node:net");
const { workerData } = require("node:worker_threads");
const { PROTOCOL_VERSION } = require("./protocol.js");

// `port` is the MessagePort half handed over by the bridge. Results go back on
// it rather than on parentPort, because the bridge drains replies with
// receiveMessageOnPort() while its own thread is blocked in Atomics.wait().
const { socketPath, token, timeoutMs, control, header, port } = workerData;

const status = new Int32Array(control);
const headerView = new Int32Array(header);

const STATUS_INDEX = 0;
const STATE_PENDING = 0;
const STATE_DONE = 1;

const HEADER_OK = 0;
const HEADER_LENGTH = 1;

let socket = null;
let buffer = "";
let counter = 0;
const pending = new Map();

function connect() {
  if (socket) return socket;

  socket = net.createConnection(socketPath);
  socket.setNoDelay(true);
  socket.unref();

  socket.on("data", (chunk) => {
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
    socket = null;
    buffer = "";
    for (const waiter of pending.values()) {
      waiter({ ok: false, error: { code: "unreachable", message } });
    }
    pending.clear();
  };

  socket.on("error", (error) => failAll(error.message));
  socket.on("close", () => failAll("Daemon connection closed"));

  return socket;
}

/** Writes the reply into shared memory and wakes the blocked main thread. */
function reply(seq, ok, payload) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  headerView[HEADER_OK] = ok ? 1 : 0;
  headerView[HEADER_LENGTH] = bytes.length;

  // The payload travels by postMessage because it can exceed any fixed buffer;
  // shared memory carries only the wake-up signal and the length. `seq` echoes
  // the request so a caller that already gave up cannot have its stale answer
  // mistaken for the next request's.
  port.postMessage({ type: "result", seq, ok, payload: bytes.toString("utf8") });

  Atomics.store(status, STATUS_INDEX, STATE_DONE);
  Atomics.notify(status, STATUS_INDEX);
}

port.on("message", (request) => {
  let settled = false;
  const settle = (ok, payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
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

  const id = `w${++counter}`;
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
