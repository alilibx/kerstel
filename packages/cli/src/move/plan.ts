import type { LoadedEnvFile } from "../init/collect";
import {
  entries,
  lookup,
  parseDotenv,
  restoreLineValue,
  serializeDotenv,
  setLineValue,
  type DotenvPair,
} from "../init/dotenv-file";
import { GLOBAL_SCOPE, formatReference, parseReference, type SecretRef } from "../reference";
import type { GitFileStatus } from "./git";
import type { Place, ScannedRow } from "./scan";

/**
 * Spec §3: what a move does, decided with no I/O. The command feeds it the
 * vault lookups, the recorded root and git's answers; `apply.ts` carries the
 * result out. Values live in the plan because apply and the backup need them;
 * nothing here prints.
 */

export interface MoveRequest {
  row: ScannedRow;
  to: Place;
}

export type ConflictChoice = "keep" | "replace";

/** What happened at the destination. `conflict` means no choice has been made yet. */
export type Outcome = "new" | "same" | "kept" | "replaced" | "conflict" | "plaintext";

export interface PlanInput {
  scope: string;
  root: string;
  loaded: LoadedEnvFile[];
  requests: MoveRequest[];
  vaultValue: (ref: SecretRef) => string | null;
  /** The vault's recorded root for `scope`, or null when it has no record. */
  recordedRoot: string | null;
  /** Keyed by the destination's `kerstel://` reference. */
  choices: Map<string, ConflictChoice>;
  gitStatus: (fileName: string) => GitFileStatus | null;
}

export interface PlannedMove {
  key: string;
  from: Place;
  to: Place;
  files: string[];
  fromRef: SecretRef | null;
  toRef: SecretRef | null;
  /** Length of the value being moved. Never the value. */
  length: number;
  outcome: Outcome;
}

export interface FileRewrite {
  name: string;
  path: string;
  before: string;
  after: string;
}

export interface VaultWrite {
  ref: SecretRef;
  value: string;
  /** The value this write replaces, for the backup and the rollback. */
  previous: string | null;
}

export interface Deletion {
  ref: SecretRef;
  value: string;
}

export interface KeptCopy {
  ref: SecretRef;
  reason: "referenced" | "other-checkout";
  /** The other checkout's root, for "other-checkout". */
  root: string | null;
}

export interface Conflict {
  key: string;
  ref: SecretRef;
  existingLength: number;
}

export interface GitWarning {
  file: string;
  key: string;
  status: "tracked" | "not-ignored";
}

export interface MergeWarning {
  key: string;
  used: string;
  others: string[];
}

export interface Skipped {
  key: string;
  ref: SecretRef;
}

/**
 * A to-plaintext move whose value has no dotenv spelling in one of its
 * lines' quoting: `restoreLineValue` falls back to `renderValue`'s escaped
 * form, which the parser reads back as a DIFFERENT value (e.g. a value
 * holding both `'` and `"`, or a single-quoted line's value holding `'` and
 * `\`). Writing it would silently change the value and delete the only
 * other copy, so the row is not moved at all; it stays in the vault.
 */
export interface Unwritable {
  key: string;
  ref: SecretRef;
  files: string[];
}

/**
 * An incoming plain-text value that lost to a kept destination. Its files are
 * rewritten to the destination's reference, so without this the backup would
 * hold it only as a file line uninstall does not look for. Spec §5.1.
 */
export interface Discarded {
  /** The destination it lost to. */
  ref: SecretRef;
  value: string;
}

export interface MovePlan {
  moves: PlannedMove[];
  files: FileRewrite[];
  vaultWrites: VaultWrite[];
  deletions: Deletion[];
  discarded: Discarded[];
  kept: KeptCopy[];
  conflicts: Conflict[];
  gitWarnings: GitWarning[];
  mergeWarnings: MergeWarning[];
  skipped: Skipped[];
  unwritable: Unwritable[];
  noReferencesLeft: boolean;
}

export function refId(ref: SecretRef): string {
  return formatReference(ref.scope, ref.key);
}

/**
 * Whether `restoreLineValue` would put `value` back on `line` such that
 * reading the file again yields `value` byte-identical. Checked on a
 * throwaway single-line parse so the real working copy is never touched
 * until every covered line is known to round-trip. `restoreLineValue`
 * itself verifies its first (verbatim-quoting) attempt this way, but its
 * fallback to `renderValue`'s escaped form is not read back by
 * `decodeDoubleQuoted` (which only undoes `\n`, not `\\`, `\"`, `\r`), so
 * that fallback can silently change the value; this catches that case
 * before anything is written.
 */
function wouldRestorePlainly(line: DotenvPair, value: string): boolean {
  const throwaway = parseDotenv(line.text + line.eol);
  if (throwaway.lines.length !== 1 || throwaway.unsupported.length !== 0) return false;
  restoreLineValue(throwaway, 0, value);
  const reparsed = parseDotenv(serializeDotenv(throwaway));
  return reparsed.unsupported.length === 0 && lookup(reparsed, line.key) === value;
}

export function planMove(input: PlanInput): MovePlan {
  const plan: MovePlan = {
    moves: [],
    files: [],
    vaultWrites: [],
    deletions: [],
    discarded: [],
    kept: [],
    conflicts: [],
    gitWarnings: [],
    mergeWarnings: [],
    skipped: [],
    unwritable: [],
    noReferencesLeft: false,
  };

  // Fresh parses: the loaded ones belong to the caller, and a plan must be
  // re-runnable after a conflict answer without seeing its own edits.
  const working = input.loaded.map((entry) => ({ entry, file: parseDotenv(entry.original) }));
  const byName = new Map(working.map((w) => [w.entry.info.name, w.file]));
  const destinations = new Set<string>();
  // Two rows in one plan can target the same destination (e.g. a plaintext
  // row and a project row both moving to global/KEY). The first request
  // decides the destination; later requests compare against what it decided
  // rather than re-reading the vault, so a destination gets at most one
  // VaultWrite and at most one Conflict per plan.
  const plannedDestinations = new Map<string, { value: string | "pending"; firstFiles: string[] }>();

  for (const { row, to } of input.requests) {
    if (row.place === to) continue;

    const value = row.ref ? input.vaultValue(row.ref) : row.value;
    if (value === null) {
      plan.skipped.push({ key: row.key, ref: row.ref! });
      continue;
    }

    let toRef: SecretRef | null = null;
    let outcome: Outcome = "plaintext";
    let length = value.length;
    if (to !== "plaintext") {
      toRef = { scope: to === "global" ? GLOBAL_SCOPE : input.scope, key: row.key };
      const id = refId(toRef);
      destinations.add(id);
      const planned = plannedDestinations.get(id);
      if (planned) {
        if (planned.value === "pending") {
          outcome = "conflict";
        } else if (planned.value === value) {
          outcome = "same";
        } else {
          plan.mergeWarnings.push({ key: row.key, used: planned.firstFiles[0]!, others: row.files });
          outcome = "kept";
          length = planned.value.length;
          if (row.place === "plaintext") plan.discarded.push({ ref: toRef, value });
        }
      } else {
        const existing = input.vaultValue(toRef);
        if (existing === null) {
          plan.vaultWrites.push({ ref: toRef, value, previous: null });
          outcome = "new";
          plannedDestinations.set(id, { value, firstFiles: row.files });
        } else if (existing === value) {
          outcome = "same";
          plannedDestinations.set(id, { value, firstFiles: row.files });
        } else {
          const choice = input.choices.get(id);
          if (choice === "replace") {
            plan.vaultWrites.push({ ref: toRef, value, previous: existing });
            outcome = "replaced";
            plannedDestinations.set(id, { value, firstFiles: row.files });
          } else if (choice === "keep") {
            outcome = "kept";
            length = existing.length;
            if (row.place === "plaintext") plan.discarded.push({ ref: toRef, value });
            plannedDestinations.set(id, { value: existing, firstFiles: row.files });
          } else {
            plan.conflicts.push({ key: row.key, ref: toRef, existingLength: existing.length });
            outcome = "conflict";
            plannedDestinations.set(id, { value: "pending", firstFiles: row.files });
          }
        }
      }
      if (row.place === "plaintext" && row.conflicts.length > 0) {
        plan.mergeWarnings.push({ key: row.key, used: row.files[0]!, others: row.conflicts });
      }
    }

    if (!toRef) {
      // To plaintext: refuse the whole row if `value` has no dotenv
      // spelling in even one covered line's own quoting. Nothing about this
      // row has been recorded above (outcome/vaultWrites only run for
      // `to !== "plaintext"`), so bailing here leaves no trace to undo.
      let writable = true;
      outer: for (const name of row.files) {
        const file = byName.get(name)!;
        for (const line of file.lines) {
          if (line.kind !== "pair" || line.key !== row.key) continue;
          if (!wouldRestorePlainly(line, value)) {
            writable = false;
            break outer;
          }
        }
      }
      if (!writable) {
        plan.unwritable.push({ key: row.key, ref: row.ref!, files: row.files });
        continue;
      }
    }

    const text = toRef ? refId(toRef) : value;
    for (const name of row.files) {
      const file = byName.get(name)!;
      file.lines.forEach((line, i) => {
        if (line.kind !== "pair" || line.key !== row.key) return;
        // A value goes back in the line's own quoting, as uninstall does; a
        // reference fits any quoting, as init writes it.
        if (toRef) setLineValue(file, i, text);
        else restoreLineValue(file, i, text);
      });
      if (!toRef) {
        const status = input.gitStatus(name);
        if (status === "tracked" || status === "not-ignored") {
          plan.gitWarnings.push({ file: name, key: row.key, status });
        }
      }
    }

    plan.moves.push({
      key: row.key,
      from: row.place,
      to,
      files: row.files,
      fromRef: row.ref,
      toRef,
      length,
      outcome,
    });
  }

  const stillReferenced = new Set<string>();
  for (const { entry, file } of working) {
    const after = serializeDotenv(file);
    if (after !== entry.original) {
      plan.files.push({ name: entry.info.name, path: entry.info.path, before: entry.original, after });
    }
    for (const pair of entries(file)) {
      const ref = parseReference(pair.value);
      if (ref) stillReferenced.add(refId(ref));
    }
  }
  plan.noReferencesLeft = plan.moves.length > 0 && stillReferenced.size === 0;

  // Spec §3.1. Only project copies; global is never deleted by a move.
  const decided = new Set<string>();
  for (const move of plan.moves) {
    if (move.from !== "project" || !move.fromRef) continue;
    const id = refId(move.fromRef);
    if (decided.has(id) || destinations.has(id)) continue;
    decided.add(id);
    if (stillReferenced.has(id)) {
      plan.kept.push({ ref: move.fromRef, reason: "referenced", root: null });
    } else if (input.recordedRoot !== null && input.recordedRoot !== input.root) {
      plan.kept.push({ ref: move.fromRef, reason: "other-checkout", root: input.recordedRoot });
    } else {
      const value = input.vaultValue(move.fromRef);
      if (value !== null) plan.deletions.push({ ref: move.fromRef, value });
    }
  }

  return plan;
}
