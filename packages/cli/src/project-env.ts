import { readFileSync } from "node:fs";
import { discoverEnvFiles } from "./init/detect";
import { entries, parseDotenv } from "./init/dotenv-file";

/**
 * Kerstel's own settings must never come from the project it is protecting.
 *
 * The compiled binary is a Bun runtime, and Bun loads an `.env` from the
 * working directory into `process.env` before any of this code runs (measured
 * on Bun 1.4.2; no build flag or environment variable turns it off). Kerstel's
 * whole model is "your `.env` holds only references, so commit it" -- which
 * makes a cloned repository's `.env` attacker-influenced input that would
 * otherwise configure Kerstel itself:
 *
 *   KERSTEL_HOME=./.kerstel-local          a vault inside the repo
 *   KERSTEL_KEYCHAIN_BACKEND=file          its key in a file beside it
 *   KERSTEL_IDLE_MS=9999999999             a daemon that never relocks
 *   KERSTEL_RELEASES_URL=http://…          `update` pointed elsewhere
 *
 * So a `KERSTEL_*` that an env file here NAMES is dropped before any command
 * reads it, and named once on stderr.
 *
 * THE TEST IS THE NAME, NOT THE VALUE. Comparing values looks more precise --
 * Bun only injects a variable the real environment lacks, so a value that
 * matches the file is the injected one -- but it cannot be done correctly.
 * Reproducing what Bun puts in `process.env` means reproducing its parser:
 * `KERSTEL_IDLE_MS=$ATTACK` expands (verified), `"...\r"` decodes, and this
 * repo's parser deliberately does neither, because it has to round-trip a file
 * it rewrites. Every gap between the two parsers is a way to smuggle a setting
 * past the check, so the check does not depend on them agreeing.
 *
 * The cost is a variable you set yourself, in a project whose env file happens
 * to name it: that is dropped too, and Kerstel falls back to its default. The
 * warning says which file to take the line out of. The alternative -- honouring
 * a value a repository chose -- is the one outcome that must not happen.
 */
export interface IgnoredSetting {
  name: string;
  file: string;
}

/** Every `KERSTEL_*` set in `env` that an env file under `cwd` also names. */
export function projectSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): IgnoredSetting[] {
  const found: IgnoredSetting[] = [];
  const seen = new Set<string>();

  for (const info of discoverEnvFiles(cwd)) {
    let parsed;
    try {
      parsed = parseDotenv(readFileSync(info.path, "utf8"));
    } catch {
      // Unreadable here is not this module's problem to report: `init` and
      // `doctor` both name such a file. Nothing was injected from it either.
      continue;
    }
    for (const pair of entries(parsed)) {
      if (!pair.key.startsWith("KERSTEL_")) continue;
      if (env[pair.key] === undefined) continue;
      if (seen.has(pair.key)) continue;
      seen.add(pair.key);
      found.push({ name: pair.key, file: info.name });
    }
  }

  return found;
}

/**
 * Drops those settings from `process.env` and returns them, so the caller can
 * say so. Runs before any command, and before anything reads a `KERSTEL_*`.
 */
export function ignoreProjectSettings(cwd: string = process.cwd()): IgnoredSetting[] {
  const ignored = projectSettings(cwd);
  for (const setting of ignored) delete process.env[setting.name];
  return ignored;
}
