import { readFileSync } from "node:fs";
import { parseReference, type SecretRef } from "../reference";
import type { EnvFileInfo } from "./detect";
import { entries, lookup, parseDotenv, type DotenvFile } from "./dotenv-file";

export interface LoadedEnvFile {
  info: EnvFileInfo;
  /** The file's bytes as read. The backup and every diff start from this. */
  original: string;
  file: DotenvFile;
}

export interface CollectedKey {
  key: string;
  /** The winning value: the one from the highest-precedence file. */
  value: string;
  /** The file that supplied it. */
  source: string;
  /** Every file this key appears in, highest precedence first. */
  files: string[];
  /** Lower-precedence files whose value DIFFERS from the winner. */
  conflicts: string[];
  /** Set when the winning value is already a kerstel:// reference. */
  reference: SecretRef | null;
}

export function loadEnvFiles(files: EnvFileInfo[]): LoadedEnvFile[] {
  return files.map((info) => {
    const original = readFileSync(info.path, "utf8");
    return { info, original, file: parseDotenv(original) };
  });
}

/**
 * Merges every `.env*` file into one key list, highest precedence first.
 *
 * v1 has no environments (spec §10), so a key defined in several files
 * collapses to ONE vault entry: the value from the highest-precedence file.
 * The other values survive only in the encrypted backup, and `init` warns
 * about every one of them by name -- silently dropping a value the developer
 * wrote would be the single worst thing this wizard could do.
 */
export function collectKeys(loaded: LoadedEnvFile[]): CollectedKey[] {
  const byKey = new Map<string, CollectedKey>();

  for (const entry of loaded) {
    for (const pair of entries(entry.file)) {
      // Within one file the LAST assignment wins, which is what lookup() gives.
      const value = lookup(entry.file, pair.key) ?? pair.value;
      const existing = byKey.get(pair.key);

      if (!existing) {
        byKey.set(pair.key, {
          key: pair.key,
          value,
          source: entry.info.name,
          files: [entry.info.name],
          conflicts: [],
          reference: parseReference(value),
        });
        continue;
      }

      // A key assigned twice inside one file is one occurrence of that file.
      if (existing.files.includes(entry.info.name)) continue;
      existing.files.push(entry.info.name);
      if (value !== existing.value) existing.conflicts.push(entry.info.name);
    }
  }

  return [...byKey.values()];
}
