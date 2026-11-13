import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  renderLaunchdPlist,
  renderSystemdUnits,
  SYNC_INTERVAL_SEC,
  syncTimer,
  type TimerDeps,
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
  expect(renderSystemdUnits({ name: "n", argv: ["/p/$x/k", "\${y}"], env: {} }).service).toContain("ExecStart=/p/$$x/k $${y}");
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

// ---- syncTimer -------------------------------------------------------------

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(over: Partial<TimerDeps> = {}, o: { showEnv?: number; failLaunchctl?: boolean } = {}) {
  const userHome = over.userHome ?? mkdtempSync(join(tmpdir(), "kt-timer-"));
  if (!over.userHome) made.push(userHome);
  const calls: string[][] = [];
  const deps: Partial<TimerDeps> = {
    platform: "darwin",
    userHome,
    home: join(userHome, ".kerstel"),
    defaultHome: join(userHome, ".kerstel"),
    env: { KERSTEL_HOME: join(userHome, ".kerstel") },
    argv: ["/usr/local/bin/kerstel", "sync", "--background", "--timer"],
    uid: 501,
    run: (argv) => {
      calls.push(argv);
      if (argv[0] === "systemctl" && argv[2] === "show-environment") return { code: o.showEnv ?? 0, stdout: "" };
      if (o.failLaunchctl && argv[0] === "launchctl" && argv[1] === "bootstrap") return { code: 5, stdout: "" };
      return { code: 0, stdout: "" };
    },
    ...over,
  };
  return { userHome, calls, deps };
}

describe("syncTimer", () => {
  test("installs a launch agent", () => {
    const { userHome, calls, deps } = fixture();
    const t = syncTimer(deps);
    expect(t.ensure({ rewrite: false })).toBe("installed");
    const file = join(userHome, "Library", "LaunchAgents", "dev.kerstel.sync.plist");
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(calls).toContainEqual(["launchctl", "bootstrap", "gui/501", file]);
    expect(t.status()).toEqual({ state: "installed", kind: "launchd", current: true });
    expect(t.ensure({ rewrite: false })).toBe("unchanged");
  });

  test("a failed launchctl bootstrap is unavailable, not a throw", () => {
    const { deps } = fixture({}, { failLaunchctl: true });
    expect(syncTimer(deps).ensure({ rewrite: false })).toBe("unavailable");
  });

  test("installs a systemd user timer", () => {
    const { userHome, calls, deps } = fixture({ platform: "linux", env: { XDG_CONFIG_HOME: "" } });
    const t = syncTimer(deps);
    expect(t.ensure({ rewrite: false })).toBe("installed");
    expect(calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(calls).toContainEqual(["systemctl", "--user", "enable", "--now", "kerstel-sync.timer"]);
    const dir = join(userHome, ".config", "systemd", "user");
    expect(existsSync(join(dir, "kerstel-sync.service"))).toBe(true);
    expect(existsSync(join(dir, "kerstel-sync.timer"))).toBe(true);
    expect(t.status()).toEqual({ state: "installed", kind: "systemd", current: true });
    expect(t.remove()).toBe(true);
    expect(existsSync(join(dir, "kerstel-sync.timer"))).toBe(false);
    expect(calls).toContainEqual(["systemctl", "--user", "disable", "--now", "kerstel-sync.timer"]);
  });

  test("no systemd user session", () => {
    const { userHome, deps } = fixture({ platform: "linux" }, { showEnv: 1 });
    const t = syncTimer(deps);
    expect(t.status()).toEqual({ state: "unavailable", reason: "no systemd user session" });
    expect(t.ensure({ rewrite: true })).toBe("unavailable");
    expect(existsSync(join(userHome, ".config"))).toBe(false);
  });

  test("another platform is unavailable", () => {
    const { deps } = fixture({ platform: "win32" });
    expect(syncTimer(deps).status()).toEqual({ state: "unavailable", reason: "not supported on win32" });
  });

  test("status is not current when argv differs", () => {
    const { userHome, deps } = fixture();
    syncTimer(deps).ensure({ rewrite: false });
    const file = join(userHome, "Library", "LaunchAgents", "dev.kerstel.sync.plist");
    const moved = syncTimer({ ...deps, argv: ["/opt/kerstel", "sync", "--background", "--timer"] });
    expect(moved.status()).toEqual({ state: "installed", kind: "launchd", current: false });
    const before = readFileSync(file, "utf8");
    expect(moved.ensure({ rewrite: false })).toBe("unchanged");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(moved.ensure({ rewrite: true })).toBe("updated");
    expect(readFileSync(file, "utf8")).toContain("/opt/kerstel");
    expect(moved.status()).toMatchObject({ current: true });
  });

  test("remove leaves another home's timer", () => {
    const { userHome, deps } = fixture();
    const homeB = join(userHome, "other");
    const a = syncTimer(deps);
    const b = syncTimer({ ...deps, home: homeB, env: { KERSTEL_HOME: homeB } });
    a.ensure({ rewrite: false });
    b.ensure({ rewrite: false });
    const dir = join(userHome, "Library", "LaunchAgents");
    const bFile = join(dir, `${timerName(homeB, deps.defaultHome!, "launchd")}.plist`);
    expect(existsSync(bFile)).toBe(true);
    expect(a.remove()).toBe(true);
    expect(existsSync(join(dir, "dev.kerstel.sync.plist"))).toBe(false);
    expect(existsSync(bFile)).toBe(true);
    expect(a.remove()).toBe(false);
  });

  test("test runs never install", () => {
    expect(process.env.KERSTEL_TEST_NO_SYNC_TIMER).toBe("1");
    const t = syncTimer();
    expect(t.status()).toEqual({ state: "unavailable", reason: "disabled in tests" });
    expect(t.ensure({ rewrite: true })).toBe("unavailable");
    expect(t.remove()).toBe(false);
  });
});
