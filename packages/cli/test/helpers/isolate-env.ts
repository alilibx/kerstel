import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every KERSTEL_* variable any test touches.
 *
 * The restore has to cover the whole set, not just the ones a given file sets:
 * these run in one process, and a variable left behind by one file silently
 * reconfigures every file after it -- a stray KERSTEL_KEYCHAIN_BACKEND is the
 * difference between the file backend and a developer's real login Keychain.
 */
const MANAGED = [
  "KERSTEL_HOME",
  "KERSTEL_KEYCHAIN_BACKEND",
  "KERSTEL_KEYCHAIN_SERVICE",
  "KERSTEL_SOCKET",
  "KERSTEL_TOKEN_FILE",
  "KERSTEL_IDLE_MS",
  "KERSTEL_RELEASES_URL",
] as const;

const snapshot = new Map<string, string | undefined>(
  MANAGED.map((name) => [name, process.env[name]]),
);

export interface IsolateOptions {
  /** Distinguishes this file's temp directories from every other's. */
  prefix?: string;
  /** Defaults to the file backend, which needs no OS credential store. */
  backend?: string;
  /**
   * Defaults to `dev.kerstel.vault.test`. The macOS backend ignores
   * KERSTEL_HOME -- its item lives in the login Keychain, not under the home
   * directory -- so overriding the service name is the only thing standing
   * between these tests and a developer's real, machine-global
   * `dev.kerstel.vault` item and its one and only data key.
   */
  service?: string;
}

/** Points Kerstel at a fresh throwaway home and returns it. */
export function isolateEnv(options: IsolateOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), `kerstel-${options.prefix ?? "test"}-`));
  process.env.KERSTEL_HOME = dir;
  process.env.KERSTEL_KEYCHAIN_BACKEND = options.backend ?? "file";
  process.env.KERSTEL_KEYCHAIN_SERVICE = options.service ?? "dev.kerstel.vault.test";
  // Port 9 (discard) refuses connections at once on a normal machine, so
  // every `doctor` and `--version` in the suite reports "could not check"
  // instead of calling github.com.
  process.env.KERSTEL_RELEASES_URL = "http://127.0.0.1:9";
  return dir;
}

/** Restores every managed variable to what it was when this module loaded. */
export function restoreEnv(): void {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
