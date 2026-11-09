import { lstatSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isBackupEnvFileName, isEnvFileName, isTemplateEnvFileName } from "../init/detect";

/**
 * The walk behind `kerstel scan`. Spec `2026-11-09-kerstel-scan-design.md` §3.
 * It only lists: reading and judging files is `report.ts`.
 */

export type FileKind = "env" | "template" | "backup";

export interface FoundFile {
  /** Absolute path. */
  path: string;
  /** The folder holding it. */
  dir: string;
  name: string;
  kind: FileKind;
}

export interface WalkResult {
  root: string;
  files: FoundFile[];
  /** Every folder read, the root included. */
  folders: number;
  /** Folders the walk could not read, such as another user's. */
  unreadable: string[];
  /** Folders holding a `package.json` file. */
  packageDirs: Set<string>;
  /** Folders holding a `.git` directory or file: the tops of work trees. */
  repoDirs: Set<string>;
}

/**
 * Never entered. Dependencies, version control, caches, and Kerstel's own home
 * (its backups are encrypted). Each is either huge or holds nothing a person
 * wrote, and a home directory scan would spend nearly all its time in them.
 */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".kerstel",
  ".cache",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".bun",
  ".nvm",
  ".cargo",
  ".rustup",
  ".gradle",
  ".m2",
  ".venv",
  "__pycache__",
  ".tox",
  ".Trash",
]);

export function fileKind(name: string): FileKind | null {
  if (isBackupEnvFileName(name)) return "backup";
  if (isTemplateEnvFileName(name)) return "template";
  if (isEnvFileName(name)) return "env";
  return null;
}

export interface WalkOptions {
  /** Called every so often with the number of folders read so far. */
  onProgress?: (folders: number) => void;
  /** For tests: the home folder whose `Library` is skipped on macOS. */
  home?: string;
  platform?: NodeJS.Platform;
}

/**
 * Depth first, in name order so the output is the same on every run. Never
 * follows a symlinked folder, and never leaves the root's filesystem, the rule
 * `find -xdev` follows: no network mounts, no `/Volumes`, no `/proc`.
 */
export function walk(root: string, options: WalkOptions = {}): WalkResult {
  const home = options.home ?? homedir();
  const macLibrary = (options.platform ?? process.platform) === "darwin" ? join(home, "Library") : null;
  // The folder's own device, through a symlink if the root is one: `scan ~/code`
  // where ~/code links to another disk must compare against that disk.
  const device = statSync(root).dev;

  const result: WalkResult = {
    root,
    files: [],
    folders: 0,
    unreadable: [],
    packageDirs: new Set(),
    repoDirs: new Set(),
  };

  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // Gone since its parent was read: nothing to report.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.unreadable.push(dir);
      continue;
    }
    result.folders += 1;
    if (options.onProgress && result.folders % 500 === 0) options.onProgress(result.folders);

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.name === ".git") result.repoDirs.add(dir);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || path === macLibrary) continue;
        let dev: number;
        try {
          dev = lstatSync(path).dev;
        } catch {
          continue;
        }
        if (dev !== device) continue;
        subdirs.push(path);
        continue;
      }
      if (entry.name === "package.json" && entry.isFile()) result.packageDirs.add(dir);

      const kind = fileKind(entry.name);
      if (!kind) continue;
      if (entry.isSymbolicLink()) {
        // A symlinked env file is read, as `init` reads one; a link to a
        // folder, or a dangling link, is not a file to judge.
        try {
          if (!statSync(path).isFile()) continue;
        } catch {
          continue;
        }
      } else if (!entry.isFile()) {
        continue;
      }
      result.files.push({ path, dir, name: entry.name, kind });
    }
    // Reverse, so popping the stack visits them in name order.
    for (let i = subdirs.length - 1; i >= 0; i -= 1) stack.push(subdirs[i]!);
  }
  return result;
}
