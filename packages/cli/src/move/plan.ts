import type { LoadedEnvFile } from "../init/collect";
import { entries, parseDotenv, restoreLineValue, serializeDotenv, setLineValue } from "../init/dotenv-file";
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

export interface MovePlan {
  moves: PlannedMove[];
  files: FileRewrite[];
  vaultWrites: VaultWrite[];
  deletions: Deletion[];
  kept: KeptCopy[];
  conflicts: Conflict[];
  gitWarnings: GitWarning[];
  mergeWarnings: MergeWarning[];
  skipped: Skipped[];
  noReferencesLeft: boolean;
}

export function refId(ref: SecretRef): string {
  return formatReference(ref.scope, ref.key);
}

export function planMove(input: PlanInput): MovePlan {
  const plan: MovePlan = {
    moves: [],
    files: [],
    vaultWrites: [],
    deletions: [],
    kept: [],
    conflicts: [],
    gitWarnings: [],
    mergeWarnings: [],
    skipped: [],
    noReferencesLeft: false,
  };

  // Fresh parses: the loaded ones belong to the caller, and a plan must be
  // re-runnable after a conflict answer without seeing its own edits.
  const working = input.loaded.map((entry) => ({ entry, file: parseDotenv(entry.original) }));
  const byName = new Map(working.map((w) => [w.entry.info.name, w.file]));
  const destinations = new Set<string>();

  for (const { row, to } of input.requests) {
    if (row.place === to) continue;

    const value = row.ref ? input.vaultValue(row.ref) : row.value;
    if (value === null) {
      plan.skipped.push({ key: row.key, ref: row.ref! });
      continue;
    }

    let toRef: SecretRef | null = null;
    let outcome: Outcome = "plaintext";
    if (to !== "plaintext") {
      toRef = { scope: to === "global" ? GLOBAL_SCOPE : input.scope, key: row.key };
      const id = refId(toRef);
      destinations.add(id);
      const existing = input.vaultValue(toRef);
      if (existing === null) {
        plan.vaultWrites.push({ ref: toRef, value, previous: null });
        outcome = "new";
      } else if (existing === value) {
        outcome = "same";
      } else {
        const choice = input.choices.get(id);
        if (choice === "replace") {
          plan.vaultWrites.push({ ref: toRef, value, previous: existing });
          outcome = "replaced";
        } else if (choice === "keep") {
          outcome = "kept";
        } else {
          plan.conflicts.push({ key: row.key, ref: toRef, existingLength: existing.length });
          outcome = "conflict";
        }
      }
      if (row.place === "plaintext" && row.conflicts.length > 0) {
        plan.mergeWarnings.push({ key: row.key, used: row.files[0]!, others: row.conflicts });
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
      length: value.length,
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
