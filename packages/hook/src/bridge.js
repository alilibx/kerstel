"use strict";

const path = require("node:path");
const { Worker, receiveMessageOnPort, MessageChannel } = require("node:worker_threads");
const { locateHook } = require("./locate.js");

const STATUS_INDEX = 0;
const STATE_PENDING = 0;

/**
 * Bridges the daemon's async socket into a synchronous call.
 *
 * The main thread posts a request to the worker, then parks on
 * Atomics.wait(). postMessage is delivered through the worker's own event
 * loop, which keeps running while this thread is blocked, so the worker can do
 * its socket round trip and wake us with Atomics.notify(). The reply itself
 * travels over a MessagePort so its size is not capped by shared memory.
 *
 * @param options.workerFile Absolute path to the resolver worker. preload.js
 * computes this once via locateHook() and passes it down. Omitted (bridge.test.js
 * driving this module directly) it is located on first use by the same runtime
 * lookup — never from a compile-time path, which the bundler rewrites to the
 * build machine's. See locate.js.
 */
function createBridge(options) {
  const socketPath = options.socketPath;
  const token = options.token;
  const timeoutMs = options.timeoutMs || 5_000;
  const configuredWorkerFile = options.workerFile;

  // Shared memory carries the wake-up signal and nothing else. The reply itself
  // goes over the MessagePort, so no length or status field belongs here.
  const control = new SharedArrayBuffer(4);
  const status = new Int32Array(control);

  const channel = new MessageChannel();
  let worker = null;
  let workerError = null;
  let disposed = false;
  let seq = 0;

  function start() {
    if (worker) return worker;

    // Resolved at RUNTIME, from the loader's view of where this code actually
    // lives. Deriving it from __dirname/__filename would ship every user the
    // build machine's source path — see locate.js for what the bundler bakes.
    const workerFile = configuredWorkerFile || locateHook().workerFile;

    worker = new Worker(workerFile, {
      workerData: { socketPath, token, timeoutMs, control, port: channel.port2 },
      transferList: [channel.port2],
      stdout: false,
      stderr: false,
    });
    // The worker must never hold the host process open.
    worker.unref();
    // A worker that failed to boot (a missing worker.cjs after bundling, say)
    // will never answer anything. Record it so the NEXT resolveSync fails
    // immediately instead of parking for the full deadline: an app with fifteen
    // references would otherwise stall for over a minute before failing.
    worker.on("error", (error) => {
      workerError = error;
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
    if (workerError) {
      const error = new Error(`Kerstel: resolver worker failed: ${workerError.message}`);
      error.code = "internal";
      throw error;
    }

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

    // Fixed ONCE, before the loop. The control word carries no request
    // identity, so an abandoned request settling late wakes whoever is parked
    // now. Recomputing the budget per wake-up would let a stream of stale
    // wake-ups extend a call's deadline without bound.
    const deadline = Date.now() + timeoutMs + 2_000;

    for (;;) {
      // Reset BEFORE draining, not after. A reply that lands between the drain
      // and the wait would otherwise have its STATE_DONE overwritten by the
      // reset, and this thread would park on a wake-up that has already been
      // spent — sleeping out the full deadline with the answer sitting in the
      // port queue. Resetting first means any reply after this point either is
      // taken by the drain below or leaves STATE_DONE standing, which makes the
      // wait return "not-equal" at once.
      Atomics.store(status, STATUS_INDEX, STATE_PENDING);

      const message = drainResult(requestSeq);
      if (message) {
        const payload = JSON.parse(message.payload);
        if (!message.ok) {
          // "unreachable" means no daemon answered the socket. Measured on
          // macOS 26 / Node 24: the worker's failAll settles this in ~14ms for
          // the whole process, references included, so this is a prompt, honest
          // failure rather than a stall -- but the message has to say what to
          // DO about it, or the user is left with a bare connect(2) errno.
          const hint =
            payload.code === "unreachable"
              ? " Is the Kerstel daemon running? Start it with `kerstel daemon start`."
              : "";
          const error = new Error(`Kerstel: ${payload.message} (kerstel://${scope}/${key}).${hint}`);
          error.code = payload.code;
          throw error;
        }
        return payload.value;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const error = new Error(
          `Kerstel: timed out resolving kerstel://${scope}/${key}. Is the daemon running? Try \`kerstel doctor\`.`,
        );
        error.code = "timeout";
        throw error;
      }

      // Block this thread for what is left of the budget. The deadline is
      // longer than the worker's own timeout, so a live worker always answers
      // first and the caller gets a real error code rather than this generic
      // one.
      Atomics.wait(status, STATUS_INDEX, STATE_PENDING, remaining);
    }
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
