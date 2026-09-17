import { openContext } from "../context";
import { connectDaemon, isDaemonRunning } from "../daemon/client";
import { startDaemon, type DaemonHandle } from "../daemon/server";
import { fail, info, ok } from "../output";
import { socketPath } from "../paths";

const START_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

/**
 * Opens the vault and blocks in the foreground, serving requests until the
 * idle timer fires or a client sends `shutdown`. This is the process that
 * actually holds the vault open for the life of the daemon; `daemon start`
 * spawns it detached, and a user may also run it directly to watch it.
 *
 * Deliberately does NOT use the normal try/finally-around-the-whole-function
 * shape every other command uses -- the vault must stay open for as long as
 * this process is serving requests, which is most of this function's life.
 * It IS closed on every path that actually ends this process's reason to
 * keep running: if startDaemon() itself fails (the vault was opened but
 * never started serving), and once the shutdown-detection loop below ends
 * (the vault is no longer needed and this function is about to return).
 */
async function serveCommand(): Promise<number> {
  const ctx = await openContext();

  let handle: DaemonHandle;
  try {
    // `handle` is assigned by the time this fires (idle is hours away by
    // default) -- same closure-over-the-not-yet-assigned-binding shape as
    // `startDaemon`'s own caller in `daemon start`'s spawned child.
    handle = await startDaemon({
      vault: ctx.vault,
      socketPath: socketPath(),
      token: ctx.token,
      backendName: ctx.backend,
      onIdle: () => {
        // Idle timeout only locks the vault by default; closing the server is
        // what actually ends this process's reason to keep running.
        void handle.close();
      },
    });
  } catch (error) {
    ctx.vault.close();
    throw error;
  }

  ok(`Kerstel daemon listening on ${handle.socketPath}`);

  // A remote `daemon stop` closes the server directly inside startDaemon()
  // with no callback back into this process, so watch for the socket going
  // away rather than waiting on a promise or event we're not given.
  while (await isDaemonRunning(handle.socketPath)) {
    await Bun.sleep(POLL_INTERVAL_MS * 5);
  }
  ctx.vault.close();
  return 0;
}

/**
 * Ensures a daemon is listening. If one already answers, this is a no-op.
 * Otherwise it spawns a detached `kerstel daemon serve` (the process that
 * actually owns the vault) and polls until it answers, so this CLI
 * invocation can return without taking the daemon down with it.
 */
async function startCommand(): Promise<number> {
  if (await isDaemonRunning()) {
    info("Kerstel daemon is already running.");
    return 0;
  }

  Bun.spawn([process.execPath, "daemon", "serve"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    if (await isDaemonRunning()) {
      ok(`Kerstel daemon listening on ${socketPath()}`);
      return 0;
    }
  }

  fail(
    "Could not start the Kerstel daemon within 10s. Run `kerstel daemon serve` directly to see what went wrong.",
  );
  return 1;
}

async function stopCommand(): Promise<number> {
  if (!(await isDaemonRunning())) {
    info("Kerstel daemon is not running.");
    return 0;
  }
  const client = await connectDaemon();
  await client.shutdown();
  client.close();
  ok("Kerstel daemon stopped.");
  return 0;
}

async function statusCommand(): Promise<number> {
  if (!(await isDaemonRunning())) {
    fail("Kerstel daemon is not running. Start it with `kerstel daemon start`.");
    return 1;
  }
  const client = await connectDaemon();
  const status = await client.status();
  client.close();
  ok(
    `Kerstel daemon running (pid ${status.pid}, ${status.unlocked ? "unlocked" : "locked"}, ` +
      `${status.secretCount} secrets, keychain: ${status.backend})`,
  );
  return 0;
}

export async function daemonCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? "status";

  if (sub === "serve") return serveCommand();
  if (sub === "start") return startCommand();
  if (sub === "stop") return stopCommand();
  if (sub === "status") return statusCommand();

  fail("Usage: kerstel daemon <serve|start|stop|status>");
  return 2;
}
