import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  renderLaunchdPlist,
  renderSystemdUnits,
  SYNC_INTERVAL_SEC,
  timerEnv,
  timerName,
} from "../src/sync/timer";

test("timerEnv keeps only the allowlist", () => {
  const env = timerEnv({
    KERSTEL_HOME: "rel/home",
    HTTPS_PROXY: "http://proxy:3128",
    KERSTEL_TOKEN: "s3cret",
    KERSTEL_TEST_NO_SYNC_TIMER: "1",
    NODE_OPTIONS: "--inspect",
    PATH: "/usr/bin",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/x",
    STRIPE_KEY: "sk_live_x",
  });
  expect(Object.keys(env).sort()).toEqual(["HTTPS_PROXY", "KERSTEL_DAEMON_SCRUBBED", "KERSTEL_HOME"]);
  expect(env.KERSTEL_HOME).toBe(resolve("rel/home"));
  expect(env.KERSTEL_DAEMON_SCRUBBED).toBe("1");
});

test("timerEnv passes the keychain settings when set", () => {
  const env = timerEnv({ KERSTEL_KEYCHAIN_BACKEND: "file", KERSTEL_KEYCHAIN_SERVICE: "svc" });
  expect(env.KERSTEL_KEYCHAIN_BACKEND).toBe("file");
  expect(env.KERSTEL_KEYCHAIN_SERVICE).toBe("svc");
});

test("names differ per home", () => {
  const d = "/home/a/.kerstel";
  expect(timerName(d, d, "launchd")).toBe("dev.kerstel.sync");
  expect(timerName(d, d, "systemd")).toBe("kerstel-sync");
  const a = timerName("/tmp/one", d, "launchd");
  const b = timerName("/tmp/two", d, "launchd");
  expect(a).toMatch(/^dev\.kerstel\.sync\.[0-9a-f]{8}$/);
  expect(b).toMatch(/^dev\.kerstel\.sync\.[0-9a-f]{8}$/);
  expect(a).not.toBe(b);
  expect(timerName("/tmp/one", d, "systemd")).toMatch(/^kerstel-sync-[0-9a-f]{8}$/);
});

const argv = ["/usr/local/bin/kerstel", "sync", "--background", "--timer"];

test("plist has the schedule", () => {
  const plist = renderLaunchdPlist({ label: "dev.kerstel.sync", argv, env: { KERSTEL_HOME: "/h" } });
  expect(SYNC_INTERVAL_SEC).toBe(300);
  expect(plist).toMatch(/<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  for (const word of argv) expect(plist).toContain(`<string>${word}</string>`);
  expect(plist).toContain("<key>EnvironmentVariables</key>");
  expect(plist).toContain("<key>KERSTEL_HOME</key>");
  expect(plist).toContain("<key>ProcessType</key>");
  expect(plist).toContain("<string>Background</string>");
  expect(plist).toContain("<key>StandardOutPath</key>");
});

test("systemd units have the schedule", () => {
  const { service, timer } = renderSystemdUnits({
    name: "kerstel-sync",
    argv,
    env: { KERSTEL_HOME: "/h", HTTPS_PROXY: "http://p" },
  });
  expect(service).toContain("Type=oneshot");
  expect(service).toContain("ExecStart=");
  expect(service).toContain('Environment="KERSTEL_HOME=/h"');
  expect(service).toContain('Environment="HTTPS_PROXY=http://p"');
  expect(timer).toContain("OnStartupSec=1min");
  expect(timer).toContain("OnUnitActiveSec=5min");
  expect(timer).toContain("Unit=kerstel-sync.service");
  expect(timer).toContain("WantedBy=timers.target");
});

const tricky = ["/Users/a b/K&R <x>/kerstel", "sync", "--background", "--timer"];

test("renders a path with spaces and XML specials", () => {
  const plist = renderLaunchdPlist({ label: "l", argv: tricky, env: { KERSTEL_HOME: "/h/a&b" } });
  expect(plist).toContain("K&amp;R &lt;x&gt;");
  expect(plist).not.toContain("&R");
  expect(plist).not.toContain("<x>");
  expect(plist).toContain("/h/a&amp;b");

  const { service } = renderSystemdUnits({ name: "n", argv: tricky, env: { KERSTEL_HOME: '/h/a"b\\c 100%' } });
  expect(service).toContain('ExecStart="/Users/a b/K&R <x>/kerstel" sync --background --timer');
  expect(service).toContain('Environment="KERSTEL_HOME=/h/a\\"b\\\\c 100%%"');
  expect(renderSystemdUnits({ name: "n", argv: ["/p/50%/k", "x"], env: {} }).service).toContain("ExecStart=/p/50%%/k x");
});

test.skipIf(process.platform !== "darwin")("the plist passes plutil -lint", () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-plist-"));
  try {
    const file = join(dir, "t.plist");
    writeFileSync(file, renderLaunchdPlist({ label: "dev.kerstel.sync", argv: tricky, env: { KERSTEL_HOME: "/h/a&b" } }));
    expect(Bun.spawnSync(["plutil", "-lint", file]).exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
