import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonError, connectDaemon, isDaemonRunning } from "../src/daemon/client";
import { MAX_LINE_CHARS } from "../src/daemon/protocol";
import type { DaemonHandle } from "../src/daemon/server";
import type { Vault } from "../src/vault/store";
import { bootDaemon, cleanupDaemons, releaseDaemon } from "./helpers/boot-daemon";

const TOKEN = "client-test-token-12345";

afterEach(cleanupDaemons);

async function boot(): Promise<{ sock: string; vault: Vault; handle: DaemonHandle }> {
  return bootDaemon({ prefix: "client", token: TOKEN });
}

test("resolve returns the secret value", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "value-1");

  const client = await connectDaemon({ socketPath: sock, token: TOKEN });
  expect(await client.resolve("global", "K")).toBe("value-1");
  client.close();
});

test("concurrent resolves on one connection match their own replies", async () => {
  const { sock, vault } = await boot();
  for (let i = 0; i < 20; i++) vault.setSecret({ scope: "global", key: `K${i}` }, `value-${i}`);

  const client = await connectDaemon({ socketPath: sock, token: TOKEN });
  const values = await Promise.all(
    Array.from({ length: 20 }, (_, i) => client.resolve("global", `K${i}`)),
  );
  expect(values).toEqual(Array.from({ length: 20 }, (_, i) => `value-${i}`));
  client.close();
});

test("a missing secret rejects with a not_found DaemonError", async () => {
  const { sock } = await boot();
  const client = await connectDaemon({ socketPath: sock, token: TOKEN });

  await expect(client.resolve("global", "MISSING")).rejects.toThrow(DaemonError);
  await client.resolve("global", "MISSING").catch((error: DaemonError) => {
    expect(error.code).toBe("not_found");
  });
  client.close();
});

test("a wrong token rejects with unauthorized", async () => {
  const { sock } = await boot();
  const client = await connectDaemon({ socketPath: sock, token: "nope-nope-nope-nope-1" });
  await client.resolve("global", "K").catch((error: DaemonError) => {
    expect(error.code).toBe("unauthorized");
  });
  client.close();
});

test("status reports the running daemon", async () => {
  const { sock } = await boot();
  const client = await connectDaemon({ socketPath: sock, token: TOKEN });
  const status = await client.status();
  expect(status.unlocked).toBe(true);
  expect(status.pid).toBeGreaterThan(0);
  client.close();
});

test("isDaemonRunning distinguishes a live socket from a dead one", async () => {
  const { sock, handle } = await boot();
  expect(await isDaemonRunning(sock)).toBe(true);

  await releaseDaemon(handle).close();
  expect(await isDaemonRunning(sock)).toBe(false);
});

test("connecting to a nonexistent socket rejects quickly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-nosock-"));
  const sock = process.platform === "win32" ? "\\\\.\\pipe\\kerstel-absent" : join(dir, "absent.sock");
  await expect(connectDaemon({ socketPath: sock, token: TOKEN, timeoutMs: 300 })).rejects.toThrow();
});

// The decoder throws past MAX_LINE_CHARS, and on the client that throw happens
// inside a "data" listener, where an escape is an UNCAUGHT EXCEPTION that takes
// the whole process down -- not just the request. Serve an oversized line from
// a bare socket server (the real daemon refuses to store a value this big, by
// design) and assert the client survives it as a rejected promise.
test.skipIf(process.platform === "win32")(
  "an oversized reply rejects the request instead of crashing the process",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "kerstel-huge-"));
    const sock = join(dir, "k.sock");

    const server = createServer((socket) => {
      socket.on("data", () => {
        // No newline: pure buffer growth, past the cap, exactly what a daemon
        // streaming an over-large value would produce.
        socket.write("x".repeat(MAX_LINE_CHARS + 1));
      });
    });
    await new Promise<void>((resolve) => server.listen(sock, () => resolve()));

    try {
      const client = await connectDaemon({ socketPath: sock, token: TOKEN });
      const error = await client.resolve("global", "HUGE").then(
        () => null,
        (e: unknown) => e as DaemonError,
      );
      expect(error).toBeInstanceOf(DaemonError);
      expect(error?.message).toContain("larger than the protocol allows");
      client.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("a request issued after close rejects instead of hanging", async () => {
  const { sock } = await boot();
  const client = await connectDaemon({ socketPath: sock, token: TOKEN });
  client.close();

  // Let the socket's own "close" event fire and fully drain the (empty)
  // pending map before issuing a *new* request. This reproduces the real
  // race: send() must not queue into a pending map whose settling events
  // have already fired and will never fire again.
  await new Promise((r) => setTimeout(r, 50));

  // Bound the assertion so a regression that reintroduces the hang fails this
  // test in ~1s instead of hanging the whole suite forever.
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out waiting for the post-close request to reject")), 1_000);
  });

  try {
    await expect(Promise.race([client.resolve("global", "K"), timeout])).rejects.toThrow(DaemonError);
  } finally {
    clearTimeout(timer);
  }
});
