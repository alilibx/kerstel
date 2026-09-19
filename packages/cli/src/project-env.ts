import { readFileSync } from "node:fs";
import { discoverEnvFiles } from "./init/detect";
import { entries, parseDotenv, type DotenvPair } from "./init/dotenv-file";

/**
 * Kerstel's own settings must never come from the project it is protecting.
 *
 * The compiled binary is a Bun runtime, and Bun loads an `.env` from the
 * working directory into `process.env` before any of this code runs. Kerstel's
 * whole model is "your `.env` holds only references, so commit it" -- which
 * makes a cloned repository's `.env` attacker-influenced input that would
 * otherwise configure Kerstel itself:
 *
 *   KERSTEL_HOME=./.kerstel-local          a vault inside the repo
 *   KERSTEL_KEYCHAIN_BACKEND=file          its key in a file beside it
 *   KERSTEL_IDLE_MS=9999999999             a daemon that never relocks
 *   KERSTEL_RELEASES_URL=http://…          `update` pointed elsewhere
 *
 * So any `KERSTEL_*` whose value matches what an env file here defines is
 * dropped before a command reads it, and named once on stderr.
 *
 * THE RULE IS A VALUE MATCH, not provenance: nothing in `process.env` records
 * where a variable came from. A developer who exports the same value in their
 * shell AND has it in the project's `.env` therefore loses it too. That is the
 * safe direction (the alternative is honouring a value the repository chose),
 * it is rare, and the warning says exactly which file to look at.
 */
export interface IgnoredSetting {
  name: string;
  file: string;
}

/**
 * Every string Bun could have put in `process.env` for this assignment.
 *
 * `parseDotenv` decodes only `\n`, because it has to round-trip a file it
 * rewrites (see its own notes on which escapes each runtime decodes). Bun
 * decodes more than that, so comparing against the parser's value alone would
 * let `KERSTEL_HOME="/tmp/evil\r"` through: Bun stores a carriage return, the
 * parser reports a literal backslash-r, the two differ, and the injected
 * setting survives. Offering Bun's decoding as an alternative closes that,
 * without widening the match for anything that has no escapes.
 */
function candidateValues(pair: DotenvPair): string[] {
  const values = [pair.value];
  if (pair.quote === '"') {
    const body = pair.text.slice(pair.valueStart + 1, pair.valueEnd - 1);
    values.push(
      body.replace(/\\(.)/g, (match, char: string) => {
        if (char === "n") return "\n";
        if (char === "r") return "\r";
        if (char === "$") return "$";
        return match;
      }),
    );
  }
  return values;
}

/** Every `KERSTEL_*` in `env` that an env file under `cwd` defines to the same value. */
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
    // EVERY occurrence, not the first. A loader takes the last assignment of a
    // repeated key, so a file that opens with a harmless `KERSTEL_HOME=/tmp/ok`
    // and repeats it further down would otherwise have only the decoy compared
    // and the real one skipped.
    for (const pair of entries(parsed)) {
      if (!pair.key.startsWith("KERSTEL_")) continue;
      const value = env[pair.key];
      if (value === undefined) continue;
      if (!candidateValues(pair).includes(value)) continue;
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
