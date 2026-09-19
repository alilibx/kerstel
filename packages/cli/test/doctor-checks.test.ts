import { expect, test } from "bun:test";
import { howItWorksNote } from "../src/commands/doctor";
import { backendLabel, exitCode, gatherChecks, type DoctorFacts } from "../src/doctor/checks";
import type { ProjectStatus } from "../src/init/status";

const HOME = "/home/kerstel/.kerstel";
const TOKEN = `${HOME}/session.token`;
const SOCKET = `${HOME}/kerstel.sock`;

const passingProject: ProjectStatus = {
  root: "/project",
  scope: "whasal",
  runtime: "node",
  packageManager: "npm",
  envFiles: [".env"],
  scripts: { wrappable: 3, wired: 3 },
  references: { total: 9, resolvable: 9, unresolved: [] },
  unreadable: [],
  shadowed: [],
};

test("Wrapper: a kerstel in node_modules/.bin is a problem, and absent otherwise", () => {
  expect(checkFor(gatherChecks(allPassFacts()), "Wrapper")).toBeUndefined();
  const shadowed = ["/project/node_modules/.bin/kerstel"];
  const checks = gatherChecks(allPassFacts({ project: { ...passingProject, shadowed } }));
  const check = checkFor(checks, "Wrapper");
  expect(check?.status).toBe("problem");
  expect(check?.detail).toContain("/project/node_modules/.bin/kerstel");
  expect(exitCode(checks)).toBe(1);
});

function allPassFacts(overrides: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    backend: "macos",
    secretCount: 12,
    daemonRunning: true,
    hook: { installed: true },
    modes: [
      { path: HOME, actual: 0o700, expected: 0o700 },
      { path: TOKEN, actual: 0o600, expected: 0o600 },
      { path: SOCKET, actual: 0o600, expected: 0o600 },
    ],
    shortcut: "linked",
    project: passingProject,
    cli: "ks",
    platform: "darwin",
    home: "~/.kerstel",
    version: "0.1.0",
    latestVersion: "0.1.0",
    bunOptions: null,
    ...overrides,
  };
}

test("Environment: warns when BUN_OPTIONS is set, and is absent otherwise", () => {
  expect(checkFor(gatherChecks(allPassFacts()), "Environment")).toBeUndefined();
  const check = checkFor(gatherChecks(allPassFacts({ bunOptions: "--preload /tmp/x.js" })), "Environment");
  expect(check?.status).toBe("warn");
  expect(check?.detail).toContain("BUN_OPTIONS");
  expect(check?.fix).toContain("unset BUN_OPTIONS");
  // The value itself is never echoed: a preload path can be a long, private one.
  expect(check?.detail).not.toContain("/tmp/x.js");
});

function checkFor(checks: ReturnType<typeof gatherChecks>, label: string) {
  return checks.find((check) => check.label === label);
}

test("a fully healthy machine and project pass every check", () => {
  const checks = gatherChecks(allPassFacts());
  expect(checks.length).toBeGreaterThan(0);
  for (const check of checks) expect(check.status).toBe("pass");
  expect(exitCode(checks)).toBe(0);
});

test("Vault pass: names the credential store", () => {
  const checks = gatherChecks(allPassFacts({ backend: "macos", secretCount: 12 }));
  expect(checkFor(checks, "Vault")).toEqual({
    group: "machine",
    status: "pass",
    label: "Vault",
    detail: "12 secrets, unlocked with your macOS Keychain",
  });
});

test("Vault warn: the file backend is in use", () => {
  const checks = gatherChecks(allPassFacts({ backend: "file", secretCount: 5 }));
  const vault = checkFor(checks, "Vault");
  expect(vault?.status).toBe("warn");
  expect(vault?.detail).toBe("5 secrets, key kept in a file");
});

test.each([
  ["darwin", "the macOS Keychain"],
  ["linux", "Secret Service"],
  ["win32", "Windows Credential Manager"],
] as const)("Vault warn on %s: the fix pins the file backend, never a switch to %s", (platform, store) => {
  const vault = checkFor(gatherChecks(allPassFacts({ backend: "file", platform })), "Vault");
  expect(vault?.fix).toBe(
    `keep KERSTEL_KEYCHAIN_BACKEND=file set in your shell profile; Kerstel can't move this key into ${store}`,
  );
});

test("Vault warn on a platform with no native store still carries a fix", () => {
  const vault = checkFor(
    gatherChecks(allPassFacts({ backend: "file", platform: "freebsd", home: "/srv/kerstel" })),
    "Vault",
  );
  expect(vault?.fix).toBe("keep /srv/kerstel private; a key file is the only store Kerstel supports here");
});

test("Vault: one secret is singular", () => {
  expect(checkFor(gatherChecks(allPassFacts({ secretCount: 1 })), "Vault")?.detail).toBe(
    "1 secret, unlocked with your macOS Keychain",
  );
  expect(checkFor(gatherChecks(allPassFacts({ backend: "file", secretCount: 1 })), "Vault")?.detail).toBe(
    "1 secret, key kept in a file",
  );
});

test("Daemon pass: running", () => {
  const checks = gatherChecks(allPassFacts({ daemonRunning: true }));
  expect(checkFor(checks, "Daemon")).toEqual({
    group: "machine",
    status: "pass",
    label: "Daemon",
    detail: "running",
  });
});

test("Daemon info: idle is the normal state, not a warning, and needs no fix", () => {
  const checks = gatherChecks(allPassFacts({ daemonRunning: false, cli: "ks" }));
  expect(checkFor(checks, "Daemon")).toEqual({
    group: "machine",
    status: "info",
    label: "Daemon",
    detail: "idle — starts on its own the first time a script needs a secret",
  });
  expect(exitCode(checks)).toBe(0);
});

test("Runtime hook pass: installed", () => {
  const checks = gatherChecks(allPassFacts({ hook: { installed: true } }));
  expect(checkFor(checks, "Runtime hook")).toEqual({
    group: "machine",
    status: "pass",
    label: "Runtime hook",
    detail: "installed",
  });
});

test("Runtime hook warn: carries the error and a reassurance, not a command", () => {
  const checks = gatherChecks(
    allPassFacts({ hook: { installed: false, error: "EACCES: permission denied" }, cli: "ks" }),
  );
  expect(checkFor(checks, "Runtime hook")).toEqual({
    group: "machine",
    status: "warn",
    label: "Runtime hook",
    detail: "not installed: EACCES: permission denied",
    fix: "ks run -- <command> works without it",
  });
});

test("Permissions pass: every path matches its expected mode", () => {
  const checks = gatherChecks(allPassFacts());
  expect(checkFor(checks, "Permissions")).toEqual({
    group: "machine",
    status: "pass",
    label: "Permissions",
    detail: "~/.kerstel, token, and socket are private",
  });
});

test("Permissions pass: names a custom home by its real path", () => {
  const checks = gatherChecks(allPassFacts({ home: "/tmp/other-home" }));
  expect(checkFor(checks, "Permissions")?.detail).toBe("/tmp/other-home, token, and socket are private");
});

test("Permissions problem: a looser path names itself and the chmod that fixes it", () => {
  const checks = gatherChecks(
    allPassFacts({
      modes: [
        { path: HOME, actual: 0o755, expected: 0o700 },
        { path: TOKEN, actual: 0o600, expected: 0o600 },
        { path: SOCKET, actual: 0o600, expected: 0o600 },
      ],
    }),
  );
  expect(checkFor(checks, "Permissions")).toEqual({
    group: "machine",
    status: "problem",
    label: "Permissions",
    detail: `${HOME} is 0755, should be 0700`,
    fix: `chmod 0700 ${HOME}`,
  });
});

test("Permissions: a missing path (null actual) is never a problem", () => {
  const checks = gatherChecks(
    allPassFacts({
      modes: [
        { path: HOME, actual: 0o700, expected: 0o700 },
        { path: TOKEN, actual: 0o600, expected: 0o600 },
        { path: SOCKET, actual: null, expected: 0o600 },
      ],
    }),
  );
  expect(checkFor(checks, "Permissions")?.status).toBe("pass");
});

test("Version pass: the latest release is this one", () => {
  const checks = gatherChecks(allPassFacts({ version: "0.1.0", latestVersion: "0.1.0" }));
  expect(checkFor(checks, "Version")).toEqual({
    group: "machine",
    status: "pass",
    label: "Version",
    detail: "0.1.0, up to date",
  });
});

test("Version pass: a build newer than the latest release is not an update", () => {
  const checks = gatherChecks(allPassFacts({ version: "0.2.0", latestVersion: "0.1.9" }));
  expect(checkFor(checks, "Version")?.status).toBe("pass");
});

test("Version warn: a newer release exists, with the update command as the fix", () => {
  const checks = gatherChecks(allPassFacts({ version: "0.1.0", latestVersion: "0.1.1", cli: "ks" }));
  expect(checkFor(checks, "Version")).toEqual({
    group: "machine",
    status: "warn",
    label: "Version",
    detail: "0.1.0, 0.1.1 available",
    fix: "ks update",
  });
  expect(exitCode(checks)).toBe(0);
});

test("Version info: an unreachable release page is reported, not failed", () => {
  const checks = gatherChecks(allPassFacts({ version: "0.1.0", latestVersion: null }));
  expect(checkFor(checks, "Version")).toEqual({
    group: "machine",
    status: "info",
    label: "Version",
    detail: "0.1.0 (could not check for updates)",
  });
  expect(exitCode(checks)).toBe(0);
});

test("Version is the first machine check", () => {
  const checks = gatherChecks(allPassFacts());
  expect(checks[0]?.label).toBe("Version");
});

test("Shortcut pass: linked", () => {
  const checks = gatherChecks(allPassFacts({ shortcut: "linked" }));
  expect(checkFor(checks, "Shortcut")).toEqual({
    group: "machine",
    status: "pass",
    label: "Shortcut",
    detail: "ks runs this Kerstel",
  });
});

test("Shortcut warn: missing, with a fix", () => {
  const checks = gatherChecks(allPassFacts({ shortcut: "missing" }));
  expect(checkFor(checks, "Shortcut")).toEqual({
    group: "machine",
    status: "warn",
    label: "Shortcut",
    detail: "ks isn't on your PATH",
    fix: "re-run the installer",
  });
});

test("Shortcut warn: a different program, with a fix", () => {
  const checks = gatherChecks(allPassFacts({ shortcut: "other" }));
  expect(checkFor(checks, "Shortcut")).toEqual({
    group: "machine",
    status: "warn",
    label: "Shortcut",
    detail: "ks on your PATH is a different program",
    fix: "use kerstel, or remove the other ks from your PATH",
  });
});

test("Shortcut not-applicable: omitted entirely", () => {
  const checks = gatherChecks(allPassFacts({ shortcut: "not-applicable" }));
  expect(checkFor(checks, "Shortcut")).toBeUndefined();
});

test("Project Scope: omitted when derived", () => {
  const checks = gatherChecks(allPassFacts({ project: { ...passingProject, scope: "whasal" } }));
  expect(checkFor(checks, "Scope")).toBeUndefined();
});

test("Project Scope: warn when it could not be derived", () => {
  const checks = gatherChecks(allPassFacts({ project: { ...passingProject, scope: null }, cli: "ks" }));
  expect(checkFor(checks, "Scope")).toEqual({
    group: "project",
    status: "warn",
    label: "Scope",
    detail: "could not be derived from package.json",
    fix: "ks init --scope <name>",
  });
});

test("Project Scripts: pass when every wrappable script is wired", () => {
  const checks = gatherChecks(allPassFacts({ project: { ...passingProject, scripts: { wrappable: 3, wired: 3 } } }));
  expect(checkFor(checks, "Scripts")).toEqual({
    group: "project",
    status: "pass",
    label: "Scripts",
    detail: "3 of 3 go through Kerstel",
  });
});

test("Project Scripts: warn with a count and a fix when some are not wired", () => {
  const checks = gatherChecks(
    allPassFacts({ project: { ...passingProject, scripts: { wrappable: 3, wired: 1 } }, cli: "ks" }),
  );
  expect(checkFor(checks, "Scripts")).toEqual({
    group: "project",
    status: "warn",
    label: "Scripts",
    detail: "1 of 3 go through Kerstel",
    fix: "ks init",
  });
});

test("Project References: pass with the resolvable count", () => {
  const checks = gatherChecks(
    allPassFacts({ project: { ...passingProject, references: { total: 9, resolvable: 9, unresolved: [] } } }),
  );
  expect(checkFor(checks, "References")).toEqual({
    group: "project",
    status: "pass",
    label: "References",
    detail: "9 of 9 resolve",
  });
});

test("Project References: problem names what can't be found and how to fix it", () => {
  const checks = gatherChecks(
    allPassFacts({
      project: {
        ...passingProject,
        references: { total: 9, resolvable: 8, unresolved: ["kerstel://whasal/DATABASE_URL"] },
      },
      cli: "ks",
    }),
  );
  expect(checkFor(checks, "References")).toEqual({
    group: "project",
    status: "problem",
    label: "References",
    detail: "1 of 9 can't be found: kerstel://whasal/DATABASE_URL",
    fix: "ks init",
  });
});

test("Project Env files: omitted when every file was readable", () => {
  const checks = gatherChecks(allPassFacts({ project: { ...passingProject, unreadable: [] } }));
  expect(checkFor(checks, "Env files")).toBeUndefined();
});

test("Project Env files: warn names the unreadable file and how to fix it", () => {
  const checks = gatherChecks(allPassFacts({ project: { ...passingProject, unreadable: [".env.production"] } }));
  expect(checkFor(checks, "Env files")).toEqual({
    group: "project",
    status: "warn",
    label: "Env files",
    detail: ".env.production could not be read",
    fix: "check the file permissions",
  });
});

test("exitCode: 0 when nothing is a problem, even with warnings", () => {
  const checks = gatherChecks(allPassFacts({ daemonRunning: false, shortcut: "missing" }));
  expect(checks.some((check) => check.status === "warn")).toBe(true);
  expect(exitCode(checks)).toBe(0);
});

test("exitCode: 1 when anything is a problem", () => {
  const checks = gatherChecks(
    allPassFacts({
      project: { ...passingProject, references: { total: 1, resolvable: 0, unresolved: ["kerstel://whasal/X"] } },
    }),
  );
  expect(exitCode(checks)).toBe(1);
});

test("backendLabel names every backend", () => {
  expect(backendLabel("macos")).toBe("macOS Keychain");
  expect(backendLabel("linux")).toBe("Secret Service");
  expect(backendLabel("windows")).toBe("Windows Credential Manager");
  expect(backendLabel("file")).toBe("a key file");
});

test("every warning and problem carries a Fix line", () => {
  for (const platform of ["darwin", "linux", "win32", "freebsd"] as const) {
    for (const shortcut of ["missing", "other"] as const) {
      const checks = gatherChecks(
        allPassFacts({ backend: "file", platform, shortcut, daemonRunning: false, hook: { installed: false } }),
      );
      for (const check of checks.filter((c) => c.status === "warn" || c.status === "problem")) {
        expect(check.fix).toBeTruthy();
      }
    }
  }
});

test("Permissions fix quotes a path the shell would split", () => {
  const spaced = "/Users/me/My Secrets/.kerstel";
  const checks = gatherChecks(
    allPassFacts({
      modes: [
        { path: spaced, actual: 0o755, expected: 0o700 },
        { path: TOKEN, actual: 0o600, expected: 0o600 },
        { path: SOCKET, actual: 0o600, expected: 0o600 },
      ],
    }),
  );
  expect(checkFor(checks, "Permissions")?.fix).toBe(`chmod 0700 '${spaced}'`);
});

test("the how-it-works note appears outside a project and in an unwired one, never in a wired one", () => {
  const outside = howItWorksNote({ project: null, cli: "ks" });
  expect(outside).toContain("starts on its own");
  expect(outside).toContain("Run `ks init` inside a project");

  const unwired = howItWorksNote({
    project: { ...passingProject, scripts: { wrappable: 2, wired: 0 }, references: { total: 0, resolvable: 0, unresolved: [] } },
    cli: "kerstel",
  });
  expect(unwired).toContain("`kerstel init`");
  expect(unwired).not.toContain("inside a project to get started");

  expect(howItWorksNote({ project: passingProject, cli: "ks" })).toBeNull();
  // No scripts to wire, but references already resolve: init has been here.
  expect(
    howItWorksNote({ project: { ...passingProject, scripts: { wrappable: 0, wired: 0 } }, cli: "ks" }),
  ).toBeNull();
});
