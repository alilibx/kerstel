/**
 * Runs a Kerstel daemon in its own process for the bridge tests.
 *
 * `resolveSync` blocks the calling thread on Atomics.wait. A daemon started in
 * the test process would sit on that same blocked event loop and could never
 * accept the worker's connection, so every lookup would deadlock until the
 * worker's own timeout fired. The daemon therefore has to be a separate
 * process, exactly as it is in production.
 *
 * Usage: bun daemon-process.ts <socketPath> <vaultFile>
 * with KERSTEL_TEST_TOKEN and KERSTEL_TEST_KEY (hex) in the environment.
 * Prints a single "ready" line once the socket is listening.
 */
import { startDaemon } from "../../../cli/src/daemon/server";
import { openVault } from "../../../cli/src/vault/store";

const socketPath = process.argv[2];
const vaultFile = process.argv[3];
const token = process.env.KERSTEL_TEST_TOKEN;
const keyHex = process.env.KERSTEL_TEST_KEY;

if (!socketPath || !vaultFile || !token || !keyHex) {
  throw new Error("daemon-process.ts needs <socketPath> <vaultFile> plus KERSTEL_TEST_TOKEN/KERSTEL_TEST_KEY");
}

const vault = openVault(Buffer.from(keyHex, "hex"), vaultFile);
await startDaemon({ vault, socketPath, token, backendName: "file" });
process.stdout.write("ready\n");
