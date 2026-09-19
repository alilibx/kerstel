/**
 * The environment a detached `daemon serve` is started with.
 *
 * An allowlist, never the caller's environment. The daemon holds the vault
 * data key in memory for hours, and two things ride along in an inherited
 * environment that must not reach it:
 *
 * - `BUN_OPTIONS`. The compiled `kerstel` binary is a Bun runtime and honours
 *   it, so `BUN_OPTIONS="--preload evil.js"` set anywhere in the caller's
 *   session runs JavaScript inside the process that unlocks the vault, without
 *   touching the binary or the hook. `NODE_OPTIONS` and `BUN_INSPECT*` go for
 *   the same reason.
 * - Plaintext. Under a nested `kerstel exec` (turbo, concurrently, a wired
 *   script calling another) the outer hook has already turned every reference
 *   in the environment into its value by the time the inner CLI spawns the
 *   daemon, so an inherited environment would park every referenced secret in
 *   the daemon's `ps -E` output for its lifetime.
 *
 * What passes: enough for the Bun runtime and the credential-store helpers
 * to work, and Kerstel's own settings.
 */
const PASS_THROUGH = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // Secret Service on Linux answers over the session bus, and may show a
  // prompt on the display.
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  // Windows.
  "SystemRoot",
  "windir",
  "SystemDrive",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "PATHEXT",
  "ComSpec",
];

/** Kerstel's own settings the daemon reads. Not `KERSTEL_TOKEN` or `KERSTEL_SOCKET`: it mints and binds those itself. */
const KERSTEL_SETTINGS = ["KERSTEL_HOME", "KERSTEL_KEYCHAIN_BACKEND", "KERSTEL_KEYCHAIN_SERVICE", "KERSTEL_IDLE_MS"];

/**
 * Set in every environment this module builds, and nowhere else. `daemon
 * serve` run by hand in a shell checks for it and, when absent, re-executes
 * itself through `daemonEnv` so a foreground daemon is as clean as a spawned
 * one. A marker rather than a key-set comparison, so the check cannot loop if
 * the platform adds a variable of its own to a child.
 */
export const SCRUBBED_MARKER = "KERSTEL_DAEMON_SCRUBBED";

export function daemonEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...PASS_THROUGH, ...KERSTEL_SETTINGS]) {
    const value = base[name];
    if (typeof value === "string") env[name] = value;
  }
  env[SCRUBBED_MARKER] = "1";
  return env;
}

/** Whether `base` is one `daemonEnv` built, so the process holding it may open the vault. */
export function isScrubbedEnvironment(base: NodeJS.ProcessEnv = process.env): boolean {
  return base[SCRUBBED_MARKER] === "1";
}
