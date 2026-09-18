import { openContext } from "../context";
import { connectDaemon, isDaemonRunning } from "../daemon/client";
import { startDaemon, type DaemonHandle } from "../daemon/server";
import { daemonServeCommand } from "../daemon/spawn";
import { fail, info, ok } from "../output";
import { socketPath } from "../paths";
import { cliName } from "../ui/cli-name";

const START_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

/**
 * Spec §7: "Idles out after a configurable period." Configured here, at the
 * one place that actually starts a long-lived server, so `startDaemon`'s
 * default stays a library default rather than a policy.
 * A non-numeric, zero or negative value is ignored in favour of that default:
 * an idle timeout of zero would relock the vault before the first request.
 */
function configuredIdleMs(): number | undefined {
  const raw = process.env.KERSTEL_IDLE_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    info(`Ignoring KERSTEL_IDLE_MS="${raw}": expected a positive whole number of milliseconds.`);
    return undefined;
  }
  return parsed;
}

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
 * never started serving), and once the server signals it has closed (the
 * vault is no longer needed and this function is about to return).
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
      idleMs: configuredIdleMs(),
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

  // A remote `daemon stop` closes the server from inside startDaemon() with no
  // callback back into this function, so the handle carries a signal we can
  // wait on. It reports THIS server's own shutdown -- unlike probing the socket
  // path, which answers "is something listening" and would keep this process
  // parked forever, holding an open vault, if another daemon bound the path.
  await handle.closed;
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

  Bun.spawn(daemonServeCommand(), {
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
    `Could not start the Kerstel daemon within 10s. Run \`${cliName()} daemon serve\` directly to see what went wrong.`,
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
    fail(`Kerstel daemon is not running. Start it with \`${cliName()} daemon start\`.`);
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
