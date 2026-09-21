import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Embedded as text: `bun build --compile` inlines a `type: "text"` import, so
// the binary carries the launcher's source and `init` can write it into any
// project without a Kerstel source tree. From source the same import reads
// the file beside this one.
import launcherText from "./launcher.cjs" with { type: "text" };

/**
 * Spec 2026-09-21 §4: the committed launcher. `init` writes it at the package
 * root, every wired script runs through it, and it decides at run time
 * whether Kerstel is on this machine.
 */

/** Relative to the package root, with forward slashes, as it appears in scripts. */
export const LAUNCHER_RELATIVE_PATH = ".kerstel/exec.cjs";
export const LAUNCHER_DIR = ".kerstel";
export const LAUNCHER_FILE = "exec.cjs";

/** Changes only when the file's behaviour changes, never with a CLI release. */
export const LAUNCHER_FORMAT = 1;

const MARKER = /^\/\/ Kerstel launcher, format (\d+)\./;

/** The launcher this Kerstel writes, byte for byte. */
export function launcherSource(): string {
  return launcherText;
}

export function launcherPath(root: string): string {
  return join(root, LAUNCHER_DIR, LAUNCHER_FILE);
}

export type LauncherStatus =
  /** Byte-identical to what this Kerstel writes. */
  | { kind: "current" }
  | { kind: "missing" }
  /** Kerstel's marker names an older format. */
  | { kind: "stale"; format: number }
  /** Kerstel's marker, current format, but the body differs: a hand edit or a tampered copy. */
  | { kind: "edited" }
  /** No Kerstel marker on the first line: not ours. */
  | { kind: "foreign" };

export function launcherStatus(root: string): LauncherStatus {
  const path = launcherPath(root);
  if (!existsSync(path)) return { kind: "missing" };
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return { kind: "foreign" };
  }
  return classifyLauncher(contents);
}

export function classifyLauncher(contents: string): LauncherStatus {
  if (contents === launcherSource()) return { kind: "current" };
  const match = MARKER.exec(contents);
  if (!match) return { kind: "foreign" };
  const format = Number(match[1]);
  if (format < LAUNCHER_FORMAT) return { kind: "stale", format };
  return { kind: "edited" };
}

/** True when the file is Kerstel's to overwrite or delete: any marker line, whatever follows. */
export function isKerstelLauncher(contents: string): boolean {
  return MARKER.test(contents);
}

export interface LauncherPlan {
  path: string;
  /** What is there now, or null when the file does not exist. */
  before: string | null;
  after: string;
  status: LauncherStatus;
}

/**
 * The write `init` needs for this package, or null when the launcher on disk
 * already matches. A foreign file is overwritten too: the scripts are about to
 * be pointed at this path, and a file that is not the launcher would run in
 * its place. The plan carries the status so the wizard can say which case it
 * is.
 */
export function planLauncher(root: string): LauncherPlan | null {
  const status = launcherStatus(root);
  if (status.kind === "current") return null;
  const path = launcherPath(root);
  const before = status.kind === "missing" ? null : readFileSync(path, "utf8");
  return { path, before, after: launcherSource(), status };
}
