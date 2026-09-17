"use strict";

const path = require("node:path");
const { Worker, receiveMessageOnPort, MessageChannel } = require("node:worker_threads");

const STATUS_INDEX = 0;
const STATE_PENDING = 0;
const STATE_DONE = 1;

/**
 * Bridges the daemon's async socket into a synchronous call.
 *
 * The main thread posts a request to the worker, then parks on
 * Atomics.wait(). postMessage is delivered through the worker's own event
 * loop, which keeps running while this thread is blocked, so the worker can do
 * its socket round trip and wake us with Atomics.notify(). The reply itself
 * travels over a MessagePort so its size is not capped by shared memory.
 */
function createBridge(options) {
  const socketPath = options.socketPath;
  const token = options.token;
  const timeoutMs = options.timeoutMs || 5_000;

  const control = new SharedArrayBuffer(4);
  const header = new SharedArrayBuffer(8);
  const status = new Int32Array(control);

  const channel = new MessageChannel();
  let worker = null;
  let disposed = false;
  let seq = 0;

  function start() {
    if (worker) return worker;

    // After bundling, this file is preload.cjs and its worker is worker.cjs.
    const workerFile = path.join(__dirname, __filename.endsWith(".cjs") ? "worker.cjs" : "worker.js");

    worker = new Worker(workerFile, {
      workerData: { socketPath, token, timeoutMs, control, header, port: channel.port2 },
      transferList: [channel.port2],
      stdout: false,
      stderr: false,
    });
    // The worker must never hold the host process open.
    worker.unref();
    worker.on("error", () => {
      // Surfaced to callers through the pending-request timeout path.
    });
    return worker;
  }

  function resolveSync(scope, key) {
    if (disposed) {
      const error = new Error("Kerstel resolver bridge was disposed");
      error.code = "internal";
      throw error;
    }

    start();
    Atomics.store(status, STATUS_INDEX, STATE_PENDING);

    // Every request carries a sequence number that its reply echoes back. If a
    // previous call gave up (the worker overshot its own deadline by more than
    // the two-second grace below) its answer can still land on the port
    // afterwards. Without this tag the next call would drain that stale reply
    // and hand back the PREVIOUS key's secret. Mismatched replies are dropped,
    // so the worst case is a throw, never a wrong value.
    const requestSeq = ++seq;

    channel.port1.postMessage({
      seq: requestSeq,
      scope,
      key,
      pid: process.pid,
      processName: path.basename(process.argv[1] || process.argv[0] || "node"),
    });

    // Block this thread. A slightly longer deadline than the worker's own
    // timeout guarantees the worker gets to answer first when it is alive.
    const waited = Atomics.wait(status, STATUS_INDEX, STATE_PENDING, timeoutMs + 2_000);
    if (waited === "timed-out") {
      const error = new Error(
        `Kerstel: timed out resolving kerstel://${scope}/${key}. Is the daemon running? Try \`kerstel doctor\`.`,
      );
      error.code = "timeout";
      throw error;
    }

    const message = drainResult(requestSeq);
    if (!message) {
      const error = new Error(`Kerstel: no reply while resolving kerstel://${scope}/${key}`);
      error.code = "internal";
      throw error;
    }

    const payload = JSON.parse(message.payload);
    if (!message.ok) {
      const error = new Error(`Kerstel: ${payload.message} (kerstel://${scope}/${key})`);
      error.code = payload.code;
      throw error;
    }
    return payload.value;
  }

  /**
   * Reads the worker's reply without turning this thread's event loop, which
   * never got a chance to run while Atomics.wait held it. receiveMessageOnPort
   * drains a MessagePort queue synchronously, which is exactly what is needed
   * here — a `worker.on("message")` handler could not fire in time.
   */
  function drainResult(requestSeq) {
    for (;;) {
      const received = receiveMessageOnPort(channel.port1);
      if (!received) return null;
      const message = received.message;
      // Anything that is not this request's own reply is a leftover from an
      // abandoned call; discard it and keep draining.
      if (message && message.type === "result" && message.seq === requestSeq) return message;
    }
  }

  function dispose() {
    disposed = true;
    channel.port1.close();
    channel.port2.close();
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  return { resolveSync, dispose };
}

module.exports = { createBridge };
