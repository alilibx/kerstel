import { Database } from "bun:sqlite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectRecord } from "./store";

/**
 * Checkouts spec §6: one project row per folder, many rows per scope. The
 * rules here decide what a folder is to a scope, for `init`, `ks move`, and
 * `doctor`. Pure apart from reading a row's package.json when the row predates
 * schema 3 and has no `package_name`.
 */

/**
 * The folder as registered. On macOS the temp dir and many working
 * directories are reached through a symlink (/var -> /private/var), and a
 * root recorded through the link must compare equal to the real one. A root
 * that no longer exists is returned as given.
 */
export function canonicalRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The projects table, read without the data key: it is not encrypted, and
 * `init --dry-run` must not open the vault. Works on a vault not yet migrated
 * to schema 3 (no `package_name` column), returning the rows it will keep.
 * Absent or unreadable is empty.
 */
export function readProjectRows(file: string): ProjectRecord[] {
  if (!existsSync(file)) return [];
  let db: Database | null = null;
  try {
    db = new Database(file, { readonly: true });
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(projects)").all().map((c) => c.name);
    if (columns.length === 0) return [];
    const packageColumn = columns.includes("package_name") ? "package_name" : "NULL AS package_name";
    return db
      .query<{ name: string; root_path: string; package_name: string | null; created_at: number }, []>(
        // Before the first open migrates a v2 vault, one folder can have two
        // rows (`init --scope a`, then `--scope b`). Keep the newest per
        // folder, by the same rule as migration 3, so this run sees the row
        // the migration will keep.
        `SELECT name, root_path, ${packageColumn}, created_at FROM projects p
         WHERE NOT EXISTS (
           SELECT 1 FROM projects q
           WHERE q.root_path = p.root_path
             AND (q.created_at > p.created_at OR (q.created_at = p.created_at AND q.id > p.id))
         )
         ORDER BY name, root_path`,
      )
      .all()
      .map((r) => ({ name: r.name, rootPath: r.root_path, packageName: r.package_name, createdAt: r.created_at }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** This folder's row, if `init` or `ks move` registered it. */
export function projectForRoot(projects: ProjectRecord[], root: string): ProjectRecord | null {
  const target = canonicalRoot(root);
  return projects.find((p) => canonicalRoot(p.rootPath) === target) ?? null;
}

export type ScopeOwner =
  | { kind: "new" }
  | { kind: "same-checkout" }
  | { kind: "another-checkout"; roots: string[] }
  | { kind: "different-package"; packageName: string | null; root: string };

/**
 * The package name a row stands for: its `package_name`, else the name in
 * the package.json at its root (null when that has no name), else undefined
 * when the folder or its package.json is gone.
 */
function rowPackageName(row: ProjectRecord): string | null | undefined {
  if (row.packageName !== null) return row.packageName;
  try {
    const name = JSON.parse(readFileSync(join(row.rootPath, "package.json"), "utf8"))?.name;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return undefined;
  }
}

/** Spec §6.2 "the same package". */
function isSamePackage(row: ProjectRecord, root: string, packageName: string | null): boolean {
  const theirs = rowPackageName(row);
  const sameBasename = basename(canonicalRoot(row.rootPath)) === basename(canonicalRoot(root));
  // The folder is gone: the old rule's best guess.
  if (theirs === undefined) return packageName === null && sameBasename;
  if (theirs !== null && packageName !== null) return theirs === packageName;
  return theirs === null && packageName === null && sameBasename;
}

/** Spec §6.2: the first line of the table that matches decides. */
export function checkScopeOwner(
  projects: ProjectRecord[],
  scope: string,
  root: string,
  packageName: string | null,
): ScopeOwner {
  const rows = projects.filter((p) => p.name === scope);
  if (rows.length === 0) return { kind: "new" };
  const here = canonicalRoot(root);
  if (rows.some((r) => canonicalRoot(r.rootPath) === here)) return { kind: "same-checkout" };
  const same = rows.filter((r) => isSamePackage(r, root, packageName));
  if (same.length > 0) return { kind: "another-checkout", roots: same.map((r) => r.rootPath) };
  const other = rows[0]!;
  return { kind: "different-package", packageName: rowPackageName(other) ?? null, root: other.rootPath };
}

function describeOwner(owner: { packageName: string | null; root: string }): string {
  return owner.packageName ? `${owner.packageName} at ${owner.root}` : `the package at ${owner.root}`;
}

/**
 * `remedy` lets a caller other than `init` name its own way to give the
 * package its own scope (`init` only takes `--scope` on the command line
 * itself; `move` has no such flag and must point at `init --scope` instead).
 */
export function scopeCollisionMessage(
  scope: string,
  owner: { packageName: string | null; root: string },
  remedy = "Re-run with --scope <name> to give this package its own.",
): string {
  return `The scope "${scope}" belongs to ${describeOwner(owner)}. ${remedy}`;
}

export function scopeShareMessage(scope: string, owner: { packageName: string | null; root: string }): string {
  return `The scope "${scope}" is also used by ${describeOwner(owner)}; this folder will share its secrets.`;
}
