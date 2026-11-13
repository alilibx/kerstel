import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

test("timerEnv always pins the home, so a manager's KERSTEL_HOME can't pick another vault", () => {
  // Unset in the shell: the default home, written out, not left to the manager.
  expect(timerEnv({ PATH: "/usr/bin" })).toEqual({ KERSTEL_HOME: join(homedir(), ".kerstel"), KERSTEL_DAEMON_SCRUBBED: "1" });
  expect(timerEnv({ KERSTEL_HOME: "" }).KERSTEL_HOME).toBe(join(homedir(), ".kerstel"));
  // The home the timer is for wins over the shell's.
  expect(timerEnv({ KERSTEL_HOME: "/elsewhere" }, "/h/.kerstel").KERSTEL_HOME).toBe("/h/.kerstel");
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

test("the plist runs from /, so no .env in a home directory loads", () => {
  const plist = renderLaunchdPlist({ label: "dev.kerstel.sync", argv, env: { KERSTEL_HOME: "/h" } });
  expect(plist).toMatch(/<key>WorkingDirectory<\/key>\s*<string>\/<\/string>/);
});

test("the systemd service runs from /, discards output, and unsets the runtime options", () => {
  const { service } = renderSystemdUnits({ name: "kerstel-sync", argv, env: { KERSTEL_HOME: "/h" } });
  const lines = service.split("\n");
  // Not $HOME (the user-service default), where Bun would load a ~/.env into a scrubbed process.
  expect(lines).toContain("WorkingDirectory=/");
  expect(lines).toContain("StandardOutput=null");
  expect(lines).toContain("StandardError=null");
  // Variables imported into the user manager must not reach a process marked scrubbed,
  // and a keychain setting this shell left unset must not come from the manager either.
  expect(lines).toContain("UnsetEnvironment=BUN_OPTIONS NODE_OPTIONS KERSTEL_KEYCHAIN_BACKEND KERSTEL_KEYCHAIN_SERVICE");
});

test("the systemd service unsets only the keychain settings the shell did not set", () => {
  const { service } = renderSystemdUnits({
    name: "kerstel-sync",
    argv,
    env: { KERSTEL_HOME: "/h", KERSTEL_KEYCHAIN_BACKEND: "file" },
  });
  const lines = service.split("\n");
  expect(lines).toContain("UnsetEnvironment=BUN_OPTIONS NODE_OPTIONS KERSTEL_KEYCHAIN_SERVICE");
  expect(lines).toContain('Environment="KERSTEL_KEYCHAIN_BACKEND=file"');
  // Applied after Environment=, so nothing the unit sets may be on it.
  expect(lines.filter((l) => l.startsWith("UnsetEnvironment=")).join(" ")).not.toContain("KERSTEL_KEYCHAIN_BACKEND");
});

/** The strings in a plist's ProgramArguments array. */
function programArguments(plist: string): string[] {
  const block = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)![1]!;
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!);
}

test("the plist clears the runtime options and unset keychain settings with env -u", () => {
  // EnvironmentVariables only adds: `launchctl setenv BUN_OPTIONS` would otherwise reach the vault.
  const plist = renderLaunchdPlist({ label: "dev.kerstel.sync", argv, env: { KERSTEL_HOME: "/h" } });
  expect(programArguments(plist)).toEqual([
    "/usr/bin/env",
    "-u",
    "BUN_OPTIONS",
    "-u",
    "NODE_OPTIONS",
    "-u",
    "KERSTEL_KEYCHAIN_BACKEND",
    "-u",
    "KERSTEL_KEYCHAIN_SERVICE",
    ...argv,
  ]);
  const set = renderLaunchdPlist({ label: "l", argv, env: { KERSTEL_HOME: "/h", KERSTEL_KEYCHAIN_SERVICE: "svc" } });
  expect(programArguments(set)).toEqual([
    "/usr/bin/env",
    "-u",
    "BUN_OPTIONS",
    "-u",
    "NODE_OPTIONS",
    "-u",
    "KERSTEL_KEYCHAIN_BACKEND",
    ...argv,
  ]);
  expect(set).toContain("<key>KERSTEL_KEYCHAIN_SERVICE</key>");
});

test.skipIf(process.platform !== "darwin")("the env -u prefix clears what the session set", () => {
  const plist = renderLaunchdPlist({ label: "l", argv: ["/usr/bin/printenv"], env: { KERSTEL_HOME: "/h" } });
  const r = Bun.spawnSync(programArguments(plist), {
    env: { PATH: "/usr/bin:/bin", BUN_OPTIONS: "--preload /x.js", NODE_OPTIONS: "--inspect", KERSTEL_KEYCHAIN_BACKEND: "file", KEPT: "1" },
    stdout: "pipe",
  });
  const out = r.stdout.toString();
  expect(r.exitCode).toBe(0);
  expect(out).toContain("KEPT=1");
  expect(out).not.toContain("BUN_OPTIONS");
  expect(out).not.toContain("NODE_OPTIONS");
  expect(out).not.toContain("KERSTEL_KEYCHAIN_BACKEND");
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

function fixture(
  over: Partial<TimerDeps> = {},
  o: { showEnv?: number; showEnvOut?: string; noGui?: boolean; failLaunchctl?: boolean; failBootstrapTimes?: number; failEnable?: boolean } = {},
) {
  const userHome = over.userHome ?? mkdtempSync(join(tmpdir(), "kt-timer-"));
  if (!over.userHome) made.push(userHome);
  const calls: string[][] = [];
  let bootstrapFails = o.failBootstrapTimes ?? 0;
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
      if (argv[0] === "systemctl" && argv[2] === "show-environment") return { code: o.showEnv ?? 0, stdout: o.showEnvOut ?? "" };
      if (argv[0] === "launchctl" && argv[1] === "print") return { code: o.noGui ? 113 : 0, stdout: "" };
      if (o.failLaunchctl && argv[0] === "launchctl" && argv[1] === "bootstrap") return { code: 5, stdout: "" };
      if (argv[0] === "launchctl" && argv[1] === "bootstrap" && bootstrapFails-- > 0) return { code: 5, stdout: "" };
      if (o.failEnable && argv[0] === "systemctl" && argv[2] === "enable") return { code: 1, stdout: "" };
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
    // Private: a proxy setting may carry a user name and password.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(calls).toContainEqual(["launchctl", "print", "gui/501"]);
    expect(calls).toContainEqual(["launchctl", "bootstrap", "gui/501", file]);
    expect(t.status()).toEqual({ state: "installed", kind: "launchd", current: true });
    expect(t.ensure({ rewrite: false })).toBe("unchanged");
  });

  test("a failed launchctl bootstrap is unavailable, not a throw", () => {
    const { deps } = fixture({}, { failLaunchctl: true });
    const t = syncTimer(deps);
    expect(t.ensure({ rewrite: false })).toBe("unavailable");
    expect(t.status().state).toBe("missing");
  });

  test("a bootstrap that fails once is retried", () => {
    const { calls, deps } = fixture({}, { failBootstrapTimes: 1 });
    const t = syncTimer(deps);
    expect(t.ensure({ rewrite: false })).toBe("installed");
    expect(calls.filter((c) => c[1] === "bootstrap")).toHaveLength(2);
    expect(t.status()).toEqual({ state: "installed", kind: "launchd", current: true });
  });

  test("a failed systemd enable removes the units", () => {
    const { userHome, deps } = fixture({ platform: "linux" }, { failEnable: true });
    const t = syncTimer(deps);
    expect(t.ensure({ rewrite: false })).toBe("unavailable");
    expect(t.status()).toEqual({ state: "missing", kind: "systemd" });
    expect(existsSync(join(userHome, ".config", "systemd", "user", "kerstel-sync.timer"))).toBe(false);
  });

  test("a run that throws (no systemctl) is unavailable", () => {
    const { deps } = fixture({
      platform: "linux",
      run: () => {
        throw new Error("ENOENT");
      },
    });
    const t = syncTimer(deps);
    expect(t.status()).toEqual({ state: "unavailable", reason: "no systemd user session" });
    expect(t.ensure({ rewrite: false })).toBe("unavailable");
  });

  test("installs a systemd user timer", () => {
    const { userHome, calls, deps } = fixture({ platform: "linux", env: { XDG_CONFIG_HOME: "" } });
    const t = syncTimer(deps);
    expect(t.ensure({ rewrite: false })).toBe("installed");
    expect(calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(calls).toContainEqual(["systemctl", "--user", "enable", "--now", "kerstel-sync.timer"]);
    const dir = join(userHome, ".config", "systemd", "user");
    expect(statSync(join(dir, "kerstel-sync.service")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "kerstel-sync.timer")).mode & 0o777).toBe(0o600);
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

  test("no GUI login session", () => {
    // Over SSH, or a Mac nobody is logged in to: there is no gui/<uid> domain to bootstrap into.
    const { userHome, calls, deps } = fixture({}, { noGui: true });
    const t = syncTimer(deps);
    expect(t.status()).toEqual({ state: "unavailable", reason: "no GUI login session" });
    expect(t.ensure({ rewrite: true })).toBe("unavailable");
    expect(existsSync(join(userHome, "Library"))).toBe(false);
    expect(calls.filter((c) => c[1] === "bootstrap")).toEqual([]);
  });

  test("a launchctl that throws is no GUI login session", () => {
    const { deps } = fixture({
      run: () => {
        throw new Error("ENOENT");
      },
    });
    const t = syncTimer(deps);
    expect(t.status()).toEqual({ state: "unavailable", reason: "no GUI login session" });
    expect(t.ensure({ rewrite: false })).toBe("unavailable");
  });

  test("the systemd units go where the user manager's XDG_CONFIG_HOME says, not the shell's", () => {
    const userHome = mkdtempSync(join(tmpdir(), "kt-timer-"));
    made.push(userHome);
    const shellOnly = join(userHome, "shell-only");
    const custom = join(userHome, "conf");
    const { deps } = fixture(
      { userHome, platform: "linux", env: { XDG_CONFIG_HOME: shellOnly } },
      { showEnvOut: `PATH=/usr/bin\nXDG_CONFIG_HOME=${custom}\nLANG=C.UTF-8\n` },
    );
    const t = syncTimer(deps);
    expect(t.ensure({ rewrite: false })).toBe("installed");
    expect(existsSync(join(custom, "systemd", "user", "kerstel-sync.timer"))).toBe(true);
    expect(existsSync(shellOnly)).toBe(false);
    expect(t.status()).toEqual({ state: "installed", kind: "systemd", current: true });
    expect(t.remove()).toBe(true);
    expect(existsSync(join(custom, "systemd", "user", "kerstel-sync.timer"))).toBe(false);

    // systemctl quotes a value with a space in it.
    const spaced = join(userHome, "my conf");
    const quoted = fixture({ userHome, platform: "linux", env: {} }, { showEnvOut: `XDG_CONFIG_HOME="${spaced}"\n` });
    expect(syncTimer(quoted.deps).ensure({ rewrite: false })).toBe("installed");
    expect(existsSync(join(spaced, "systemd", "user", "kerstel-sync.timer"))).toBe(true);
  });

  test("without XDG_CONFIG_HOME in the user manager, the units go in ~/.config", () => {
    const userHome = mkdtempSync(join(tmpdir(), "kt-timer-"));
    made.push(userHome);
    const shellOnly = join(userHome, "shell-only");
    const { deps } = fixture({ userHome, platform: "linux", env: { XDG_CONFIG_HOME: shellOnly } }, { showEnvOut: "HOME=/home/a\n" });
    const t = syncTimer(deps);
    expect(t.ensure({ rewrite: false })).toBe("installed");
    expect(existsSync(join(userHome, ".config", "systemd", "user", "kerstel-sync.service"))).toBe(true);
    expect(existsSync(shellOnly)).toBe(false);
    expect(t.remove()).toBe(true);
    expect(existsSync(join(userHome, ".config", "systemd", "user", "kerstel-sync.service"))).toBe(false);
  });

  test("another platform is unavailable", () => {
    const { deps } = fixture({ platform: "win32" });
    expect(syncTimer(deps).status()).toEqual({ state: "unavailable", reason: "not supported on win32" });
  });

  test("the units always carry the timer's home, even when the shell sets none", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { userHome, deps } = fixture({ platform, env: {} });
      expect(syncTimer(deps).ensure({ rewrite: false })).toBe("installed");
      const text =
        platform === "darwin"
          ? readFileSync(join(userHome, "Library", "LaunchAgents", "dev.kerstel.sync.plist"), "utf8")
          : readFileSync(join(userHome, ".config", "systemd", "user", "kerstel-sync.service"), "utf8");
      const home = join(userHome, ".kerstel");
      expect(text).toContain(platform === "darwin" ? `<string>${home}</string>` : `Environment="KERSTEL_HOME=${home}"`);
    }
  });

  test("a shell that names the default home and one that leaves it unset agree the timer is current", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { deps } = fixture({ platform });
      const home = deps.home!;
      expect(syncTimer({ ...deps, env: { KERSTEL_HOME: home } }).ensure({ rewrite: false })).toBe("installed");
      for (const env of [{}, { KERSTEL_HOME: "" }, { KERSTEL_HOME: `${home}/` }, { KERSTEL_HOME: home }]) {
        const t = syncTimer({ ...deps, env });
        expect({ platform, env, status: t.status() }).toEqual({
          platform,
          env,
          status: { state: "installed", kind: platform === "darwin" ? "launchd" : "systemd", current: true },
        });
        expect(t.ensure({ rewrite: true })).toBe("unchanged");
      }
      // A keychain setting still changes the unit, so it is not current.
      expect(syncTimer({ ...deps, env: { KERSTEL_KEYCHAIN_BACKEND: "file" } }).status()).toMatchObject({ current: false });
    }
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

  test("a launchd update that will not load puts the old plist back and loads it", () => {
    const { userHome, deps } = fixture();
    const file = join(userHome, "Library", "LaunchAgents", "dev.kerstel.sync.plist");
    expect(syncTimer(deps).ensure({ rewrite: false })).toBe("installed");
    const before = readFileSync(file, "utf8");
    const loaded: (string | null)[] = [];
    let bootstrapFails = 2;
    const moved = syncTimer({
      ...deps,
      argv: ["/opt/kerstel", "sync", "--background", "--timer"],
      run: (argv) => {
        if (argv[1] !== "bootstrap") return { code: 0, stdout: "" };
        loaded.push(existsSync(file) ? readFileSync(file, "utf8") : null);
        return { code: bootstrapFails-- > 0 ? 5 : 0, stdout: "" };
      },
    });
    expect(moved.ensure({ rewrite: true })).toBe("unavailable");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Two tries of the new plist, then one of the old.
    expect(loaded).toHaveLength(3);
    expect(loaded[2]).toBe(before);
  });

  test("a systemd update that will not load puts the old units back and loads them", () => {
    const { userHome, deps } = fixture({ platform: "linux" });
    const dir = join(userHome, ".config", "systemd", "user");
    expect(syncTimer(deps).ensure({ rewrite: false })).toBe("installed");
    const service = readFileSync(join(dir, "kerstel-sync.service"), "utf8");
    const timer = readFileSync(join(dir, "kerstel-sync.timer"), "utf8");
    const calls: string[][] = [];
    const enabledWith: string[] = [];
    let enableFails = 1;
    const moved = syncTimer({
      ...deps,
      argv: ["/opt/kerstel", "sync", "--background", "--timer"],
      run: (argv) => {
        calls.push(argv);
        if (argv[2] !== "enable") return { code: 0, stdout: "" };
        enabledWith.push(readFileSync(join(dir, "kerstel-sync.service"), "utf8"));
        return { code: enableFails-- > 0 ? 1 : 0, stdout: "" };
      },
    });
    expect(moved.ensure({ rewrite: true })).toBe("unavailable");
    expect(readFileSync(join(dir, "kerstel-sync.service"), "utf8")).toBe(service);
    expect(readFileSync(join(dir, "kerstel-sync.timer"), "utf8")).toBe(timer);
    // The new units once, then the old ones, each after a daemon-reload.
    expect(enabledWith).toHaveLength(2);
    expect(enabledWith[0]).toContain("/opt/kerstel");
    expect(enabledWith[1]).toBe(service);
    const lastEnable = calls.findLastIndex((c) => c[2] === "enable");
    const lastReload = calls.findLastIndex((c) => c[2] === "daemon-reload");
    expect(lastReload).toBeGreaterThan(-1);
    expect(lastReload).toBeLessThan(lastEnable);
    expect(calls[lastEnable]).toEqual(["systemctl", "--user", "enable", "--now", "kerstel-sync.timer"]);
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

  test("launchd remove deletes the plist before bootout, which may end the calling job", () => {
    const { userHome, deps } = fixture();
    const file = join(userHome, "Library", "LaunchAgents", "dev.kerstel.sync.plist");
    const seen: boolean[] = [];
    const t = syncTimer({
      ...deps,
      run: (argv) => {
        // bootout of the job that is running this code ends it: anything after never runs.
        if (argv[1] === "bootout") seen.push(existsSync(file));
        return { code: 0, stdout: "" };
      },
    });
    expect(t.ensure({ rewrite: false })).toBe("installed");
    seen.length = 0;
    expect(t.remove()).toBe(true);
    expect(seen).toEqual([false]);
    expect(existsSync(file)).toBe(false);
    expect(t.remove()).toBe(false);
  });

  test("test runs never install", () => {
    expect(process.env.KERSTEL_TEST_NO_SYNC_TIMER).toBe("1");
    const t = syncTimer();
    expect(t.status()).toEqual({ state: "unavailable", reason: "disabled in tests" });
    expect(t.ensure({ rewrite: true })).toBe("unavailable");
    expect(t.remove()).toBe(false);
  });
});
