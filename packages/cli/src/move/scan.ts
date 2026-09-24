import type { Suggestion } from "../init/classify";
import type { LoadedEnvFile } from "../init/collect";
import { entries, lookup } from "../init/dotenv-file";
import { GLOBAL_SCOPE, parseReference, type SecretRef } from "../reference";

/**
 * Where a key lives now, in the same three words `init` uses for where it
 * could go. Spec §2.1 step 1.
 *
 * Not `collectKeys`: that keeps one winner per key and only the NAMES of files
 * that disagree, so `.env` pointing at `whasal/K` and `.env.local` pointing at
 * `global/K` would collapse into one row and one of the two would never move.
 */
export type Place = Suggestion;

export const PLACE_LABELS: Record<Place, string> = {
  project: "Vault, this project",
  global: "Vault, shared",
  plaintext: "Plain text",
};

export interface ScannedRow {
  /** `${key}:${place}`: unique, and the value the key menu returns. */
  id: string;
  key: string;
  place: Place;
  /** The reference, for "project" and "global" rows. */
  ref: SecretRef | null;
  /** For "plaintext" rows: the value in the highest-precedence file. */
  value: string | null;
  /** Every file this row covers, highest precedence first. */
  files: string[];
  /** "plaintext" rows only: covered files whose value differs from `value`. */
  conflicts: string[];
}

/** A reference to a scope that is neither this project's nor `global`. */
export interface ForeignReference {
  key: string;
  reference: string;
  files: string[];
}

export interface ScanResult {
  rows: ScannedRow[];
  foreign: ForeignReference[];
}

/**
 * The scope `init` used for this project. `init --scope` can pick a name the
 * package does not have, so the files' own references are the better witness:
 * exactly one non-global scope there wins; none, or several, fall back to the
 * derived name.
 */
export function resolveProjectScope(loaded: LoadedEnvFile[], derived: string): string {
  const scopes = new Set<string>();
  for (const entry of loaded) {
    for (const pair of entries(entry.file)) {
      const ref = parseReference(pair.value);
      if (ref && ref.scope !== GLOBAL_SCOPE) scopes.add(ref.scope);
    }
  }
  return scopes.size === 1 ? [...scopes][0]! : derived;
}

export function scanRows(loaded: LoadedEnvFile[], scope: string): ScanResult {
  const rows: ScannedRow[] = [];
  const byId = new Map<string, ScannedRow>();
  const foreign = new Map<string, ForeignReference>();

  for (const entry of loaded) {
    const name = entry.info.name;
    const seen = new Set<string>();
    for (const pair of entries(entry.file)) {
      if (seen.has(pair.key)) continue;
      seen.add(pair.key);

      // Within one file the LAST assignment wins, as dotenv does.
      const value = lookup(entry.file, pair.key)!;
      const ref = parseReference(value);
      const place: Place | null =
        ref === null ? "plaintext" : ref.scope === GLOBAL_SCOPE ? "global" : ref.scope === scope ? "project" : null;

      if (place === null) {
        const id = `${pair.key}:${value}`;
        const known = foreign.get(id);
        if (known) known.files.push(name);
        else foreign.set(id, { key: pair.key, reference: value, files: [name] });
        continue;
      }

      const id = `${pair.key}:${place}`;
      const existing = byId.get(id);
      if (!existing) {
        const row: ScannedRow = {
          id,
          key: pair.key,
          place,
          ref,
          value: ref === null ? value : null,
          files: [name],
          conflicts: [],
        };
        byId.set(id, row);
        rows.push(row);
        continue;
      }
      existing.files.push(name);
      if (place === "plaintext" && value !== existing.value) existing.conflicts.push(name);
    }
  }

  return { rows, foreign: [...foreign.values()] };
}
