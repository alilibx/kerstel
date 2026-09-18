import type { ProjectStatus } from "../init/status";

/** Spec §6: three states, rendered as ✓ / ! / ✗. */
export type CheckStatus = "pass" | "warn" | "problem";

export interface Check {
  group: "machine" | "project";
  status: CheckStatus;
  label: string;
  detail: string;
  /** The exact command (or instruction) that resolves this check. Omitted on pass. */
  fix?: string;
}

/**
 * Everything `gatherChecks` needs, already gathered. Kept separate from the
 * gathering itself so the rules above -- what counts as a pass, a warning, or
 * a problem -- can be unit tested against plain data, with no vault, daemon,
 * or filesystem in the loop.
 */
export interface DoctorFacts {
  backend: string;
  secretCount: number;
  daemonRunning: boolean;
  hook: { installed: boolean; error?: string };
  modes: { path: string; actual: number | null; expected: number }[];
  shortcut: "linked" | "missing" | "other" | "not-applicable";
  project: ProjectStatus | null;
  cli: "ks" | "kerstel";
}

/** "macos" -> "macOS Keychain", etc. Falls back to the raw name if new. */
export function backendLabel(backend: string): string {
  switch (backend) {
    case "macos":
      return "macOS Keychain";
    case "linux":
      return "Secret Service";
    case "windows":
      return "Windows Credential Manager";
    case "file":
      return "a key file";
    default:
      return backend;
  }
}

function vaultCheck(facts: DoctorFacts): Check {
  if (facts.backend === "file") {
    return {
      group: "machine",
      status: "warn",
      label: "Vault",
      detail: `${facts.secretCount} secrets, key kept in a file`,
      // Linux is the only platform with a native store `secret-tool` can
      // stand in for; macOS and Windows ship their credential store, so
      // landing on the file backend there means it was chosen on purpose
      // (KERSTEL_KEYCHAIN_BACKEND=file), not something to "fix".
      fix: process.platform === "linux" ? "install secret-tool (libsecret) and re-run" : undefined,
    };
  }
  return {
    group: "machine",
    status: "pass",
    label: "Vault",
    detail: `${facts.secretCount} secrets, unlocked with your ${backendLabel(facts.backend)}`,
  };
}

function daemonCheck(facts: DoctorFacts): Check {
  if (facts.daemonRunning) {
    return { group: "machine", status: "pass", label: "Daemon", detail: "running" };
  }
  return {
    group: "machine",
    status: "warn",
    label: "Daemon",
    detail: "not running",
    fix: `${facts.cli} daemon start`,
  };
}

function runtimeHookCheck(facts: DoctorFacts): Check {
  if (facts.hook.installed) {
    return { group: "machine", status: "pass", label: "Runtime hook", detail: "installed" };
  }
  return {
    group: "machine",
    status: "warn",
    label: "Runtime hook",
    detail: `not installed: ${facts.hook.error ?? "unknown error"}`,
    fix: `${facts.cli} run -- <command> works without it`,
  };
}

/**
 * Reports the first path that is looser than Kerstel intends, if any. One
 * problem line is enough to point at `doctor --verbose` for the rest --
 * stacking every offending path here would just repeat what the fix already
 * says to do for each of them, one chmod at a time.
 */
function permissionsCheck(facts: DoctorFacts): Check {
  const offending = facts.modes.find(
    (mode) => mode.actual !== null && (mode.actual & ~mode.expected) !== 0,
  );
  if (!offending || offending.actual === null) {
    return {
      group: "machine",
      status: "pass",
      label: "Permissions",
      detail: "~/.kerstel, token, and socket are private",
    };
  }
  const actualOctal = offending.actual.toString(8).padStart(4, "0");
  const expectedOctal = offending.expected.toString(8).padStart(4, "0");
  return {
    group: "machine",
    status: "problem",
    label: "Permissions",
    detail: `${offending.path} is ${actualOctal}, should be ${expectedOctal}`,
    fix: `chmod ${expectedOctal} ${offending.path}`,
  };
}

function shortcutCheck(facts: DoctorFacts): Check | null {
  switch (facts.shortcut) {
    case "not-applicable":
      return null;
    case "linked":
      return { group: "machine", status: "pass", label: "Shortcut", detail: "ks runs this Kerstel" };
    case "missing":
      return {
        group: "machine",
        status: "warn",
        label: "Shortcut",
        detail: "ks isn't on your PATH",
        fix: "re-run the installer",
      };
    case "other":
      return {
        group: "machine",
        status: "warn",
        label: "Shortcut",
        detail: "ks on your PATH is a different program",
      };
  }
}

/**
 * Omitted entirely when the scope was derived: the scope already names the
 * project group ("This project · whasal"), so a passing check here would
 * just repeat that header.
 */
function scopeCheck(project: ProjectStatus, cli: "ks" | "kerstel"): Check | null {
  if (project.scope !== null) return null;
  return {
    group: "project",
    status: "warn",
    label: "Scope",
    detail: "could not be derived from package.json",
    fix: `${cli} init --scope <name>`,
  };
}

function scriptsCheck(project: ProjectStatus, cli: "ks" | "kerstel"): Check {
  const { wired, wrappable } = project.scripts;
  const detail = `${wired} of ${wrappable} go through Kerstel`;
  if (wired === wrappable) {
    return { group: "project", status: "pass", label: "Scripts", detail };
  }
  return { group: "project", status: "warn", label: "Scripts", detail, fix: `${cli} init` };
}

function referencesCheck(project: ProjectStatus, cli: "ks" | "kerstel"): Check {
  const { total, resolvable, unresolved } = project.references;
  if (unresolved.length === 0) {
    return { group: "project", status: "pass", label: "References", detail: `${resolvable} of ${total} resolve` };
  }
  return {
    group: "project",
    status: "problem",
    label: "References",
    detail: `${unresolved.length} of ${total} can't be found: ${unresolved.join(", ")}`,
    fix: `${cli} init`,
  };
}

/** Omitted entirely when every env file was readable -- nothing to warn about. */
function envFilesCheck(project: ProjectStatus): Check | null {
  if (project.unreadable.length === 0) return null;
  return {
    group: "project",
    status: "warn",
    label: "Env files",
    detail: `${project.unreadable.join(", ")} could not be read`,
    fix: "check the file permissions",
  };
}

/** Spec §6. Order matches the mockup: machine checks, then project checks. */
export function gatherChecks(facts: DoctorFacts): Check[] {
  const checks: Check[] = [vaultCheck(facts), daemonCheck(facts), runtimeHookCheck(facts), permissionsCheck(facts)];

  const shortcut = shortcutCheck(facts);
  if (shortcut) checks.push(shortcut);

  if (facts.project) {
    const scope = scopeCheck(facts.project, facts.cli);
    if (scope) checks.push(scope);
    checks.push(scriptsCheck(facts.project, facts.cli));
    checks.push(referencesCheck(facts.project, facts.cli));
    const envFiles = envFilesCheck(facts.project);
    if (envFiles) checks.push(envFiles);
  }

  return checks;
}

/** 1 when anything is `✗`; warnings alone still exit 0. */
export function exitCode(checks: Check[]): 0 | 1 {
  return checks.some((check) => check.status === "problem") ? 1 : 0;
}
