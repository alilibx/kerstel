import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { backupsDir } from "../paths";
import { cliName } from "../ui/cli-name";
import { decrypt, encrypt } from "../vault/crypto";

/**
 * The undo for everything `init` rewrites (spec §13). Originals are encrypted
 * with the vault data key, so a backup of a plaintext `.env` does not quietly
 * become a second plaintext copy of every secret the wizard just removed.
 *
 * On-disk layout:
 *   ~/.kerstel/backups/<scope>/<timestamp>/<original name>.enc
 *   ~/.kerstel/backups/<scope>/<timestamp>/manifest.json
 *
 * The manifest is plaintext ON PURPOSE and carries no file contents: names,
 * byte counts and sha256 digests only, so `doctor` and a future `uninstall`
 * can list and verify backups without unlocking the vault.
 *
 * Blob format: the 12-byte nonce, then the ciphertext with its GCM tag. One
 * file, one encryption, no framing to get wrong.
 *
 * Writes are staged in a hidden sibling directory (named `.tmp-<timestamp>-*`)
 * and renamed into place only once every file and the manifest are down -- a
 * crash or thrown error midway through a multi-file backup leaves an orphaned
 * `.tmp-*` directory instead of a `<timestamp>` directory that looks real but
 * is missing files `restoreBackup` would need. That staging directory can
 * itself contain a fully-written `manifest.json` (a kill between the manifest
 * write and the rename), so `listBackups` cannot rely on manifest presence
 * alone -- it also excludes any entry still named `.tmp-*`, so a half-written
 * backup never looks complete no matter where in the write it was interrupted.
 */

const NONCE_BYTES = 12;

export interface BackupFileEntry {
  name: string;
  /** Byte length of the PLAINTEXT original. */
  bytes: number;
  /** sha256 of the plaintext original, hex. Proves a restore is faithful. */
  sha256: string;
}

export interface BackupManifest {
  version: 1;
  scope: string;
  timestamp: string;
  createdAt: number;
  files: BackupFileEntry[];
}

export interface BackupResult {
  dir: string;
  timestamp: string;
  files: BackupFileEntry[];
}

/** An ISO timestamp with the colons replaced, so it is a legal path segment. */
export function backupTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/:/g, "-");
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // mkdirSync's `mode` applies only on creation and is masked by the umask
  // even then, so assert it every time -- the same rule ensureHome() follows.
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function writePrivate(path: string, data: Buffer | string): void {
  writeFileSync(path, data, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function createBackup(options: {
  scope: string;
  dataKey: Buffer;
  files: { name: string; contents: string }[];
  timestamp?: string;
}): BackupResult {
  const timestamp = options.timestamp ?? backupTimestamp();
  const scopeDir = join(backupsDir(), options.scope);
  const finalDir = join(scopeDir, timestamp);
  const tempDir = join(scopeDir, `.tmp-${timestamp}-${randomBytes(4).toString("hex")}`);
  ensureDir(tempDir);

  try {
    const entries: BackupFileEntry[] = [];
    for (const file of options.files) {
      const { ciphertext, nonce } = encrypt(file.contents, options.dataKey);
      writePrivate(join(tempDir, `${file.name}.enc`), Buffer.concat([nonce, ciphertext]));
      entries.push({
        name: file.name,
        bytes: Buffer.byteLength(file.contents),
        sha256: createHash("sha256").update(file.contents, "utf8").digest("hex"),
      });
    }

    const manifest: BackupManifest = {
      version: 1,
      scope: options.scope,
      timestamp,
      createdAt: Date.now(),
      files: entries,
    };
    writePrivate(join(tempDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    // Rename is the commit point: everything up to here only touched the
    // hidden staging directory, so a failure above never produces a
    // `<timestamp>` directory that looks complete but isn't.
    renameSync(tempDir, finalDir);
    return { dir: finalDir, timestamp, files: entries };
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

export function listBackups(scope: string): string[] {
  const dir = join(backupsDir(), scope);
  if (!existsSync(dir)) return [];
  try {
    // Timestamps are ISO, so lexicographic order is chronological order.
    // A completed backup is a directory that (a) is not still a `.tmp-*`
    // staging name and (b) has a manifest. Checking manifest presence alone
    // is not enough: a staging directory can be killed after its manifest was
    // written but before createBackup's renameSync committed it, which would
    // otherwise slip a raw `.tmp-<timestamp>-<random>` string past this
    // filter and out as a "timestamp" -- breaking the sort order and any
    // caller doing `new Date(timestamp)`.
    return readdirSync(dir)
      .filter((name) => !name.startsWith(".tmp-") && existsSync(join(dir, name, "manifest.json")))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Decrypts one backup's originals IN MEMORY and returns them, writing nothing.
 *
 * Every blob is checked against the digest the manifest recorded, so a wrong
 * key or a corrupted blob throws rather than handing back garbage. `uninstall`
 * reads the latest backup this way to find values that exist nowhere else.
 */
export function readBackup(
  scope: string,
  timestamp: string,
  dataKey: Buffer,
): { name: string; contents: string }[] {
  const dir = join(backupsDir(), scope, timestamp);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No Kerstel backup at ${dir}. Run \`${cliName()} doctor\` to see what is there.`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  const files: { name: string; contents: string }[] = [];

  for (const entry of manifest.files) {
    const blob = readFileSync(join(dir, `${entry.name}.enc`));
    const contents = decrypt(
      { nonce: blob.subarray(0, NONCE_BYTES), ciphertext: blob.subarray(NONCE_BYTES) },
      dataKey,
    );
    const digest = createHash("sha256").update(contents, "utf8").digest("hex");
    if (digest !== entry.sha256) {
      throw new Error(
        `Kerstel backup ${timestamp} is corrupt: ${entry.name} does not match its recorded hash.`,
      );
    }
    files.push({ name: entry.name, contents });
  }
  return files;
}

/**
 * Writes one backup's originals into `targetDir`.
 *
 * Every file is decrypted BEFORE anything is written (see `readBackup`): a
 * wrong key or a corrupted blob must fail with nothing half-restored, because
 * the thing being overwritten is the developer's live `.env`.
 */
export function restoreBackup(
  scope: string,
  timestamp: string,
  targetDir: string,
  dataKey: Buffer,
): string[] {
  const restored = readBackup(scope, timestamp, dataKey).map((file) => ({
    path: join(targetDir, file.name),
    contents: file.contents,
  }));
  for (const file of restored) writePrivate(file.path, file.contents);
  return restored.map((file) => file.path);
}
