import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
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
 */
export function writeFileAtomic(path: string, contents: string): void {
  const temp = tempPathFor(path);
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  try {
    const fd = openSync(temp, "w", mode);
    try {
      writeSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // openSync's mode is masked by the umask; the rename must not widen or
    // narrow what the developer had.
    if (process.platform !== "win32") chmodSync(temp, mode);
    renameSync(temp, path);
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
      vault.setSecret(w.ref, w.value);
      written.push(w);
    }
    for (const f of plan.files) {
      write(f.path, f.after);
      rewritten.push(f);
    }
  } catch (error) {
    for (const w of written.reverse()) {
      if (w.previous === null) vault.removeSecret(w.ref);
      else vault.setSecret(w.ref, w.previous);
    }
    // `before` is byte-for-byte what the backup holds, already in memory.
    for (const f of rewritten.reverse()) writeFileAtomic(f.path, f.before);
    throw new MoveApplyError(
      `${(error as Error).message}. Nothing was changed; the backup is in ${backup.dir}.`,
      backup.dir,
    );
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
