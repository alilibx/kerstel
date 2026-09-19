import { expect, test } from "bun:test";
import { daemonEnv } from "../src/daemon/env";

const caller: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/ada",
  LANG: "en_GB.UTF-8",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  KERSTEL_HOME: "/Users/ada/.kerstel-test",
  KERSTEL_KEYCHAIN_BACKEND: "file",
  KERSTEL_KEYCHAIN_SERVICE: "dev.kerstel.vault.test",
  KERSTEL_IDLE_MS: "60000",
  // What must not reach the daemon.
  BUN_OPTIONS: "--preload /tmp/evil.js",
  BUN_INSPECT: "1",
  NODE_OPTIONS: "--require /tmp/evil.cjs",
  KERSTEL_TOKEN: "an-outer-token",
  KERSTEL_SOCKET: "/somewhere/else.sock",
  DATABASE_URL: "postgres://user:plaintext-password@db/app",
  STRIPE_SECRET_KEY: "sk_live_plaintext",
  npm_lifecycle_event: "dev",
};

test("the daemon gets the runtime, session bus, and Kerstel settings it needs", () => {
  const env = daemonEnv(caller);
  expect(env.PATH).toBe("/usr/bin:/bin");
  expect(env.HOME).toBe("/Users/ada");
  expect(env.LANG).toBe("en_GB.UTF-8");
  expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
  expect(env.KERSTEL_HOME).toBe("/Users/ada/.kerstel-test");
  expect(env.KERSTEL_KEYCHAIN_BACKEND).toBe("file");
  expect(env.KERSTEL_KEYCHAIN_SERVICE).toBe("dev.kerstel.vault.test");
  expect(env.KERSTEL_IDLE_MS).toBe("60000");
});

test("runtime injection variables never reach the daemon", () => {
  const env = daemonEnv(caller);
  expect(env).not.toHaveProperty("BUN_OPTIONS");
  expect(env).not.toHaveProperty("BUN_INSPECT");
  expect(env).not.toHaveProperty("NODE_OPTIONS");
});

test("the caller's own variables, tokens, and plaintext never reach the daemon", () => {
  const env = daemonEnv(caller);
  expect(env).not.toHaveProperty("DATABASE_URL");
  expect(env).not.toHaveProperty("STRIPE_SECRET_KEY");
  expect(env).not.toHaveProperty("npm_lifecycle_event");
  expect(env).not.toHaveProperty("KERSTEL_TOKEN");
  expect(env).not.toHaveProperty("KERSTEL_SOCKET");
  expect(JSON.stringify(env)).not.toContain("plaintext");
});

test("unset variables are left out rather than passed as empty strings", () => {
  const env = daemonEnv({ PATH: "/bin" });
  expect(Object.keys(env)).toEqual(["PATH"]);
});
