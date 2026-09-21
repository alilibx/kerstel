import { LAUNCHER_FORMAT, LAUNCHER_RELATIVE_PATH } from "../init/launcher";
import { SKIP_REASON_TEXT } from "../init/script-shell";
import type { ProjectStatus } from "../init/status";
import { compareVersions } from "../update/versions";

/** A path as the shell needs it pasted: unchanged when safe, single-quoted otherwise. */
function shellQuote(path: string): string {
  return /^[A-Za-z0-9_\/.~:@%+=,-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/** Spec §6: ✓ / ! / ✗, plus `·` for a fact that needs no action, like an idle daemon. */
export type CheckStatus = "pass" | "warn" | "problem" | "info";

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
  /** `process.platform`, as a fact so each platform's wording is testable anywhere. */
  platform: NodeJS.Platform;
  /** Kerstel's home as the user should read it: `~/.kerstel` when it is the default. */
  home: string;
  /** This binary's version. */
  version: string;
  /** The newest release on GitHub, or null when the check could not reach it. */
  latestVersion: string | null;
  /** `BUN_OPTIONS` as this process saw it, or null when unset. */
  bunOptions: string | null;
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

/** The credential store Kerstel would use on `platform`, or `null` if it has none. */
function nativeStore(platform: NodeJS.Platform): string | null {
  switch (platform) {
    case "darwin":
      return "the macOS Keychain";
    case "linux":
      return "Secret Service";
    case "win32":
      return "Windows Credential Manager";
    default:
      return null;
  }
}

/**
 * `·` rather than `!` when the release page was unreachable: an offline
 * machine is not a fault in Kerstel, and `doctor` must never fail for it.
 * A build newer than the latest release (a dev build, or a release whose
 * page has not propagated yet) counts as up to date.
 */
function versionCheck(facts: DoctorFacts): Check {
  if (facts.latestVersion === null) {
    return {
      group: "machine",
      status: "info",
      label: "Version",
      detail: `${facts.version} (could not check for updates)`,
    };
  }
  if (compareVersions(facts.version, facts.latestVersion) < 0) {
    return {
      group: "machine",
      status: "warn",
      label: "Version",
      detail: `${facts.version}, ${facts.latestVersion} available`,
      fix: `${facts.cli} update`,
    };
  }
  return { group: "machine", status: "pass", label: "Version", detail: `${facts.version}, up to date` };
}

function vaultCheck(facts: DoctorFacts): Check {
  const secrets = `${facts.secretCount} secret${facts.secretCount === 1 ? "" : "s"}`;
  if (facts.backend === "file") {
    // The file backend is in use because KERSTEL_KEYCHAIN_BACKEND=file asked
    // for it, or because the native store was unreachable (a locked login
    // Keychain over SSH, no secret-tool) when the vault was first opened.
    // Either way vault_meta has recorded "file" by now, and context.ts refuses
    // to open this vault with any other backend -- so "unlock the Keychain" or
    // "install secret-tool" would turn this warning into a vault that won't
    // open. The truthful fix is to pin the backend, which keeps every session,
    // including one that CAN reach the native store, on this key.
    const store = nativeStore(facts.platform);
    return {
      group: "machine",
      status: "warn",
      label: "Vault",
      detail: `${secrets}, key kept in a file`,
      fix: store
        ? `keep KERSTEL_KEYCHAIN_BACKEND=file set in your shell profile; Kerstel can't move this key into ${store}`
        : `keep ${facts.home} private; a key file is the only store Kerstel supports here`,
    };
  }
  return {
    group: "machine",
    status: "pass",
    label: "Vault",
    detail: `${secrets}, unlocked with your ${backendLabel(facts.backend)}`,
  };
}

function daemonCheck(facts: DoctorFacts): Check {
  if (facts.daemonRunning) {
    return { group: "machine", status: "pass", label: "Daemon", detail: "running" };
  }
  // Not running is the normal resting state: the daemon starts on its own the
  // first time a wired script or `resolve` needs a secret, and after a reboot
  // it simply has not been needed yet. Telling the user to start it by hand
  // made an idle daemon look like a fault.
  return {
    group: "machine",
    status: "info",
    label: "Daemon",
    detail: "idle — starts on its own the first time a script needs a secret",
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
      detail: `${facts.home}, token, and socket are private`,
    };
  }
  const actualOctal = offending.actual.toString(8).padStart(4, "0");
  const expectedOctal = offending.expected.toString(8).padStart(4, "0");
  return {
    group: "machine",
    status: "problem",
    label: "Permissions",
    detail: `${offending.path} is ${actualOctal}, should be ${expectedOctal}`,
    fix: `chmod ${expectedOctal} ${shellQuote(offending.path)}`,
  };
}

/**
 * The compiled `kerstel` is a Bun runtime and honours `BUN_OPTIONS`, so a
 * `--preload` there runs inside every Kerstel process, including the ones that
 * hold the vault key, before any Kerstel code does. The daemon is started with
 * a scrubbed environment, so this reaches only the one-shot commands, but a
 * developer who set it for their own Bun projects should know it reaches
 * Kerstel too. Only reported when set: an unset variable is not a check.
 */
function environmentCheck(facts: DoctorFacts): Check | null {
  if (facts.bunOptions === null) return null;
  return {
    group: "machine",
    status: "warn",
    label: "Environment",
    detail: `BUN_OPTIONS is set, and Kerstel's own process honours it`,
    fix: `unset BUN_OPTIONS before running ${facts.cli}; the daemon already ignores it`,
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
        fix: "use kerstel, or remove the other ks from your PATH",
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

/**
 * Spec 2026-09-21 §6. A script the wirer refuses (a `cd`, a redirection, ...)
 * is named with its reason but does not count against the pass: `init` would
 * refuse it too, so there is nothing a re-run could fix.
 */
function scriptsCheck(project: ProjectStatus, cli: "ks" | "kerstel"): Check {
  const { wired, wrappable, oldForm, partlyWired, skipped } = project.scripts;
  const notes: string[] = [];
  if (oldForm.length > 0) notes.push(`old form: ${oldForm.join(", ")}`);
  if (partlyWired.length > 0) notes.push(`partly wired: ${partlyWired.join(", ")}`);
  if (skipped.length > 0) {
    notes.push(`skipped: ${skipped.map((skip) => `${skip.name} (${SKIP_REASON_TEXT[skip.reason]})`).join(", ")}`);
  }
  const detail = `${wired} of ${wrappable} go through Kerstel${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`;
  if (wired === wrappable) {
    return { group: "project", status: "pass", label: "Scripts", detail };
  }
  return { group: "project", status: "warn", label: "Scripts", detail, fix: `${cli} init` };
}

/**
 * Spec 2026-09-21 §6: the committed launcher, judged against the text this
 * Kerstel writes. Only shown once something is wired, since until then there
 * is nothing for it to launch.
 */
function launcherCheck(project: ProjectStatus, cli: "ks" | "kerstel"): Check | null {
  const status = project.launcher;
  if (status === null) return null;
  const label = "Launcher";
  const file = LAUNCHER_RELATIVE_PATH;
  const fix = `${cli} init`;
  switch (status.kind) {
    case "current":
      return { group: "project", status: "pass", label, detail: `${file} is current` };
    case "missing":
      return { group: "project", status: "problem", label, detail: `${file} is missing`, fix };
    case "stale":
      return {
        group: "project",
        status: "warn",
        label,
        detail: `${file} is format ${status.format}, current is ${LAUNCHER_FORMAT}`,
        fix,
      };
    case "edited":
      return { group: "project", status: "warn", label, detail: `${file} differs from what ${cli} init writes`, fix };
    case "foreign":
      return { group: "project", status: "warn", label, detail: `${file} is not Kerstel's (no marker line)`, fix };
  }
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

/**
 * A `kerstel` under node_modules/.bin runs instead of Kerstel for every wired
 * script (npm puts that directory first on PATH), so it is a problem, not a
 * warning: `exec` refuses in that project until the file is gone. Omitted when
 * there is none. See init/shadow.ts.
 */
function shadowCheck(project: ProjectStatus): Check | null {
  if (project.shadowed.length === 0) return null;
  return {
    group: "project",
    status: "problem",
    label: "Wrapper",
    detail: `${project.shadowed.join(", ")} would run in place of Kerstel`,
    fix: "remove the dependency that installs it, then delete the file",
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
  const checks: Check[] = [
    versionCheck(facts),
    vaultCheck(facts),
    daemonCheck(facts),
    runtimeHookCheck(facts),
    permissionsCheck(facts),
  ];

  const environment = environmentCheck(facts);
  if (environment) checks.push(environment);

  const shortcut = shortcutCheck(facts);
  if (shortcut) checks.push(shortcut);

  if (facts.project) {
    const scope = scopeCheck(facts.project, facts.cli);
    if (scope) checks.push(scope);
    checks.push(scriptsCheck(facts.project, facts.cli));
    const launcher = launcherCheck(facts.project, facts.cli);
    if (launcher) checks.push(launcher);
    const shadow = shadowCheck(facts.project);
    if (shadow) checks.push(shadow);
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
