import { expect, test } from "bun:test";
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
};

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
    ...overrides,
  };
}

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
  // secret-tool only exists to fix this on Linux; elsewhere the file backend
  // was chosen on purpose (KERSTEL_KEYCHAIN_BACKEND=file), not a problem.
  if (process.platform === "linux") {
    expect(vault?.fix).toBe("install secret-tool (libsecret) and re-run");
  } else {
    expect(vault?.fix).toBeUndefined();
  }
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

test("Daemon warn: not running, fix uses the invoked name", () => {
  const checks = gatherChecks(allPassFacts({ daemonRunning: false, cli: "ks" }));
  expect(checkFor(checks, "Daemon")).toEqual({
    group: "machine",
    status: "warn",
    label: "Daemon",
    detail: "not running",
    fix: "ks daemon start",
  });
});

test("Daemon warn: fix says kerstel when invoked as kerstel", () => {
  const checks = gatherChecks(allPassFacts({ daemonRunning: false, cli: "kerstel" }));
  expect(checkFor(checks, "Daemon")?.fix).toBe("kerstel daemon start");
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

test("Shortcut warn: a different program, no fix", () => {
  const checks = gatherChecks(allPassFacts({ shortcut: "other" }));
  expect(checkFor(checks, "Shortcut")).toEqual({
    group: "machine",
    status: "warn",
    label: "Shortcut",
    detail: "ks on your PATH is a different program",
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
