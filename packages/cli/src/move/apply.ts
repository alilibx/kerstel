import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createBackup, type BackupResult, type BackupVaultValue } from "../init/backup";
import type { SecretRef } from "../reference";
import type { Vault } from "../vault/store";
import { refId, type FileRewrite, type MovePlan, type VaultWrite } from "./plan";

/**
 * Spec §5: backup, vault writes, file rewrites, deletions, project record, in
 * that order. A failure in the writes undoes them; a failure after them loses
 * nothing and is reported.
 */

export const TEMP_SUFFIX = ".kerstel-tmp";

/** `.env` → `..env.kerstel-tmp`: hidden, and not an env file discoverEnvFiles would pick up. */
function tempPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}${TEMP_SUFFIX}`);
}

/**
 * Writes `contents` so a crash leaves the old file or the new one, never half
 * of each: a temp file in the same directory, flushed, then renamed over the
 * original. The original's permission bits carry over.
 *
 * `path` may be a symlink (`init` writes through them): resolving to the real
 * target first, and putting the temp file and the rename beside that target,
 * means the rename replaces the target's contents rather than replacing the
 * link itself with a plain file.
 */
export function writeFileAtomic(path: string, contents: string): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const temp = tempPathFor(target);
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  try {
    // A leftover temp (possibly itself a symlink, from a prior crash) must
    // never be opened -- only ever a fresh file this call created.
    rmSync(temp, { force: true });
    const fd = openSync(temp, "wx", mode);
    try {
      writeSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // openSync's mode is masked by the umask; the rename must not widen or
    // narrow what the developer had.
    if (process.platform !== "win32") chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Temp files a crashed move left in `root`. Returns the names it removed. */
export function removeStaleTemps(root: string): string[] {
  const stale = readdirSync(root).filter((name) => name.startsWith("..env") && name.endsWith(TEMP_SUFFIX));
  for (const name of stale) rmSync(join(root, name), { force: true });
  return stale;
}

export interface ApplyOptions {
  vault: Vault;
  dataKey: Buffer;
  /** The project scope; backups live under it. */
  scope: string;
  root: string;
  recordedRoot: string | null;
  /** Tests inject a failing writer here. */
  writeFile?: (path: string, contents: string) => void;
}

export interface ApplyResult {
  backup: BackupResult;
  deleted: SecretRef[];
  registered: boolean;
  /** Step 4 and 5 failures: reported, never fatal. */
  problems: string[];
}

export class MoveApplyError extends Error {
  constructor(
    message: string,
    readonly backupDir: string,
  ) {
    super(message);
    this.name = "MoveApplyError";
  }
}

/** Internal: names the vault ref or file whose write threw, for the rollback message. */
class StepFailure extends Error {
  constructor(
    readonly entryName: string,
    readonly original: Error,
  ) {
    super(original.message);
  }
}

/** Spec §5.1: every value the move will delete or overwrite. */
export function backupVaultValues(plan: MovePlan): BackupVaultValue[] {
  return [
    ...plan.deletions.map((d) => ({ scope: d.ref.scope, key: d.ref.key, value: d.value })),
    ...plan.vaultWrites
      .filter((w) => w.previous !== null)
      .map((w) => ({ scope: w.ref.scope, key: w.ref.key, value: w.previous! })),
  ];
}

export function applyMove(plan: MovePlan, options: ApplyOptions): ApplyResult {
  if (plan.conflicts.length > 0) throw new Error("applyMove was given a plan with unanswered conflicts.");
  const { vault } = options;
  const write = options.writeFile ?? writeFileAtomic;

  // 1. Backup, before anything else changes.
  const backup = createBackup({
    scope: options.scope,
    dataKey: options.dataKey,
    files: plan.files.map((f) => ({ name: f.name, contents: f.before })),
    vault: backupVaultValues(plan),
  });

  // 2 and 3. Vault writes, then files; undone together on any failure.
  const written: VaultWrite[] = [];
  const rewritten: FileRewrite[] = [];
  try {
    for (const w of plan.vaultWrites) {
      try {
        vault.setSecret(w.ref, w.value);
      } catch (error) {
        throw new StepFailure(refId(w.ref), error as Error);
      }
      written.push(w);
    }
    for (const f of plan.files) {
      try {
        write(f.path, f.after);
      } catch (error) {
        throw new StepFailure(f.name, error as Error);
      }
      rewritten.push(f);
    }
  } catch (error) {
    // Every rollback step runs even if an earlier one throws: a Keychain or
    // disk failure mid-rollback must not abandon the rest of the undo, and
    // must never surface as a bare Error without `backupDir` -- the backup
    // is the only way back once that happens.
    const unrestored: string[] = [];
    for (const w of written.reverse()) {
      try {
        if (w.previous === null) vault.removeSecret(w.ref);
        else vault.setSecret(w.ref, w.previous);
      } catch {
        unrestored.push(refId(w.ref));
      }
    }
    // `before` is byte-for-byte what the backup holds, already in memory.
    for (const f of rewritten.reverse()) {
      try {
        writeFileAtomic(f.path, f.before);
      } catch {
        unrestored.push(f.name);
      }
    }
    const cause = error instanceof StepFailure ? `${error.original.message} (${error.entryName})` : (error as Error).message;
    const restoreNote =
      unrestored.length > 0
        ? `Some changes could not be undone (${unrestored.join(", ")}); the backup is in ${backup.dir}.`
        : `Nothing was changed; the backup is in ${backup.dir}.`;
    throw new MoveApplyError(`${cause}. ${restoreNote}`, backup.dir);
  }

  const problems: string[] = [];

  // 4. Deletions.
  const deleted: SecretRef[] = [];
  for (const d of plan.deletions) {
    try {
      if (vault.removeSecret(d.ref)) deleted.push(d.ref);
    } catch (error) {
      problems.push(`Could not remove ${refId(d.ref)} from the vault: ${(error as Error).message}`);
    }
  }

  // 5. Project record, only when there is none. Never overwrite another root.
  let registered = false;
  if (options.recordedRoot === null) {
    try {
      vault.registerProject(options.scope, options.root);
      registered = true;
    } catch (error) {
      problems.push(`Could not record ${options.scope} in the vault: ${(error as Error).message}`);
    }
  }

  return { backup, deleted, registered, problems };
}
