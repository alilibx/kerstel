# Per-checkout registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register every checkout of a project by its folder, so two copies of one package (such as git worktrees) both work, `ks move` never deletes a copy another checkout reads, and `uninstall` restores every checkout. Closes #13.

**Architecture:** Schema version 3 makes `projects.root_path` unique instead of `name`, and adds `package_name`. A new module, `vault/projects.ts`, holds the pure rules shared by `init`, `ks move`, and `doctor`: finding this folder's row, and classifying a scope's rows as new, the same checkout, another checkout, or a different package. `init` gains the collision check and reuses values the vault already holds; `ks move` reads the other checkouts' env files before deleting a copy.

**Tech Stack:** Bun 1.4.2, TypeScript, `bun:sqlite`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-19-monorepo-and-checkouts-design.md` §6 (checkouts only; §3–§5 are #34 and are not built here), and `docs/superpowers/specs/2026-09-24-move-keys-between-vault-and-plaintext-design.md` §3, §3.1, §5 step 5.

## Global Constraints

- Work in `.claude/worktrees/checkouts` on branch `feat/checkouts`. Never commit to `main`.
- Conventional Commits. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Tests must never print a secret value, and every temp tree, vault, and `KERSTEL_HOME` is removed in `afterEach`.
- `bun run test` builds the hook first; running one file with `bun test packages/cli/test/<file>` needs `bun run --cwd packages/hook build` to have run once.
- Status lines go through `ok`/`fail`/`info` in `packages/cli/src/output.ts` (all `console.log`), never `console.error`.
- Never edit a shipped migration in `schema.ts`; append.
- Never call Kerstel "v2", and never mention version labels like "v1" for product stages.
- CI fails a PR that changes `packages/*/src` without a `CHANGELOG.md` line, and fails when `docs/` is stale after a website source change.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/cli/src/vault/schema.ts` | modify | migration 3: rebuild `projects` |
| `packages/cli/src/vault/store.ts` | modify | `ProjectRecord.packageName`; `registerProject` upserts on `root_path` |
| `packages/cli/src/vault/projects.ts` | create | `canonicalRoot`, `readProjectRows`, `projectForRoot`, `checkScopeOwner`, messages |
| `packages/cli/src/commands/init.ts` | modify | scope from this folder's row, collision check, registration with package name, §6.3 values the vault holds |
| `packages/cli/src/init/overview.ts` | modify | optional `note` column (`already in the vault`, …) |
| `packages/cli/src/move/checkouts.ts` | create | references read by other checkouts |
| `packages/cli/src/move/plan.ts` | modify | `otherCheckoutRefs` replaces `recordedRoot` |
| `packages/cli/src/move/apply.ts` | modify | register when this folder has no row |
| `packages/cli/src/commands/move.ts` | modify | collision check, build `otherCheckoutRefs`, preview wording |
| `packages/cli/src/init/status.ts` | modify | scope from this folder's row, `otherCheckouts` |
| `packages/cli/src/doctor/checks.ts` | modify | `Checkouts` info line |
| docs | modify | `apps/website/src/pages/docs/cli.md`, `CHANGELOG.md`, `ROADMAP.md`, `docs/` rebuild |

---

### Task 1: Schema version 3 and per-folder registration

**Files:**
- Modify: `packages/cli/src/vault/schema.ts` (append to `MIGRATIONS`, bump `SCHEMA_VERSION`)
- Modify: `packages/cli/src/vault/store.ts:16-20` (`ProjectRecord`), `:36` (interface), `:134-149` (`registerProject`, `listProjects`)
- Test: `packages/cli/test/vault.test.ts`

**Interfaces:**
- Produces: `ProjectRecord { name: string; rootPath: string; packageName: string | null; createdAt: number }`; `Vault.registerProject(name: string, rootPath: string, packageName?: string | null): void` (upsert on `root_path`; updates `name` and `package_name`); `Vault.listProjects(): ProjectRecord[]` ordered by `name, root_path`; `SCHEMA_VERSION === 3`.

- [ ] **Step 1: Replace the old registration test and add the new ones**

In `packages/cli/test/vault.test.ts`, replace the test `"projects register idempotently and update their path"` with:

```ts
test("each folder is its own project row, and re-registering a folder updates it", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.registerProject("my-app", "/tmp/a", "@acme/my-app");
  v.registerProject("my-app", "/tmp/b", "@acme/my-app");
  v.registerProject("renamed", "/tmp/a", null);
  expect(v.listProjects().map(({ name, rootPath, packageName }) => ({ name, rootPath, packageName }))).toEqual([
    { name: "my-app", rootPath: "/tmp/b", packageName: "@acme/my-app" },
    { name: "renamed", rootPath: "/tmp/a", packageName: null },
  ]);
});

test("a version-2 vault upgrades with every project row intact", () => {
  const dir = tempDir();
  const file = join(dir, "vault.db");
  const db = new Database(file, { create: true });
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      root_path TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, key TEXT NOT NULL,
      value_ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, environment TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(scope, key));
    CREATE INDEX secrets_scope_idx ON secrets(scope);
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, event TEXT NOT NULL,
      scope TEXT NOT NULL, key TEXT NOT NULL, pid INTEGER, process_name TEXT,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL);
    CREATE INDEX audit_log_ts_idx ON audit_log(ts DESC);
    CREATE TABLE vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO projects (id, name, root_path, created_at) VALUES (4, 'web', '/src/web', 100);
    INSERT INTO projects (id, name, root_path, created_at) VALUES (9, 'api', '/src/api', 200);
    -- init --scope a, then init --scope b, in one folder: the newer row wins.
    INSERT INTO projects (id, name, root_path, created_at) VALUES (11, 'old', '/src/same', 300);
    INSERT INTO projects (id, name, root_path, created_at) VALUES (12, 'new', '/src/same', 400);
    PRAGMA user_version = 2;
  `);
  db.close();

  const v = vaultIn(dir, generateDataKey());
  expect(v.listProjects()).toEqual([
    { name: "api", rootPath: "/src/api", packageName: null, createdAt: 200 },
    { name: "new", rootPath: "/src/same", packageName: null, createdAt: 400 },
    { name: "web", rootPath: "/src/web", packageName: null, createdAt: 100 },
  ]);
  v.close();
  open.pop();

  const check = new Database(file, { readonly: true });
  try {
    expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(SCHEMA_VERSION);
    const ids = check.query<{ id: number }, []>("SELECT id FROM projects ORDER BY id").all().map((r) => r.id);
    expect(ids).toEqual([4, 9, 12]);
    // secrets and audit_log still point at the rebuilt table, not a renamed copy.
    const sql = check
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name IN ('secrets', 'audit_log')")
      .all()
      .map((r) => r.sql);
    for (const text of sql) expect(text).toContain("REFERENCES projects(id)");
  } finally {
    check.close();
  }
});
```

Also add `expect(SCHEMA_VERSION).toBe(3)` to whichever existing test asserts the schema version (search the file for `SCHEMA_VERSION`); if none does, add:

```ts
test("the schema is at version 3", () => {
  expect(SCHEMA_VERSION).toBe(3);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test packages/cli/test/vault.test.ts`
Expected: FAIL — the new tests fail (one row per name, no `packageName`, version 2).

- [ ] **Step 3: Append migration 3**

In `packages/cli/src/vault/schema.ts`, set `export const SCHEMA_VERSION = 3;` and append to `MIGRATIONS`:

```ts
  // v3: one row per checkout (#13, checkouts spec §6.1).
  //
  // v2 keyed projects on `name`, so a second checkout of one package (a git
  // worktree) replaced the first one's root, and `uninstall` restored only the
  // folder it happened to remember. Now `root_path` is the key and a scope can
  // hold any number of rows. `package_name` tells a second checkout of the same
  // package from an unrelated package whose name slugifies the same.
  //
  // Rebuilt rather than altered: SQLite cannot drop a UNIQUE constraint. The
  // new table is created under another name, filled, and renamed into place
  // AFTER the old one is dropped. Renaming the old table first would rewrite
  // the REFERENCES clauses in `secrets` and `audit_log` to follow it. Every
  // `id` is kept, so those references would still hold (no code writes them
  // today). A v2 vault can hold two rows for one folder (`init --scope a`,
  // then `--scope b`); the newest one per folder is kept.
  `
  CREATE TABLE projects_v3 (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    root_path     TEXT    NOT NULL UNIQUE,
    package_name  TEXT,
    created_at    INTEGER NOT NULL
  );

  INSERT INTO projects_v3 (id, name, root_path, package_name, created_at)
    SELECT id, name, root_path, NULL, created_at FROM projects p
    WHERE NOT EXISTS (
      SELECT 1 FROM projects q
      WHERE q.root_path = p.root_path
        AND (q.created_at > p.created_at OR (q.created_at = p.created_at AND q.id > p.id))
    );

  DROP TABLE projects;
  ALTER TABLE projects_v3 RENAME TO projects;
  CREATE INDEX projects_name_idx ON projects(name);
  `,
```

- [ ] **Step 4: Update the store**

In `packages/cli/src/vault/store.ts`:

```ts
export interface ProjectRecord {
  name: string;
  rootPath: string;
  /** The package.json name when `init` last ran here, or null (no name, or registered before schema 3). */
  packageName: string | null;
  createdAt: number;
}
```

Interface line: `registerProject(name: string, rootPath: string, packageName?: string | null): void;`

Implementation:

```ts
    registerProject(name: string, rootPath: string, packageName: string | null = null): void {
      // One row per folder (checkouts spec §6.1): a second checkout adds a row,
      // and re-running in a folder updates only that folder's row.
      db.query(
        `INSERT INTO projects (name, root_path, package_name, created_at)
         VALUES ($name, $root, $pkg, $ts)
         ON CONFLICT(root_path) DO UPDATE SET
           name         = excluded.name,
           package_name = excluded.package_name`,
      ).run({ $name: name, $root: rootPath, $pkg: packageName, $ts: now() });
    },

    listProjects(): ProjectRecord[] {
      return db
        .query<{ name: string; root_path: string; package_name: string | null; created_at: number }, []>(
          "SELECT name, root_path, package_name, created_at FROM projects ORDER BY name, root_path",
        )
        .all()
        .map((r) => ({ name: r.name, rootPath: r.root_path, packageName: r.package_name, createdAt: r.created_at }));
    },
```

- [ ] **Step 5: Run the vault tests, then the whole suite**

Run: `bun test packages/cli/test/vault.test.ts` — Expected: PASS.
Run: `bun run typecheck && bun run test` — Expected: PASS. `move-apply.test.ts`'s "registered only when the vault has no record" test still passes here (it registers `/elsewhere/app` and never touches `root`); Task 5 rewrites it. If any other test asserted one row per name, fix that test to the new rule, not the code.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/vault/schema.ts packages/cli/src/vault/store.ts packages/cli/test/vault.test.ts
git commit -m "feat(vault): register each checkout by its folder (schema 3)"
```

---

### Task 2: `vault/projects.ts` — the shared checkout rules

**Files:**
- Create: `packages/cli/src/vault/projects.ts`
- Test: `packages/cli/test/vault-projects.test.ts`

**Interfaces:**
- Consumes: `ProjectRecord` (Task 1).
- Produces:
  - `canonicalRoot(path: string): string` — `realpathSync`, or the path unchanged when it does not resolve.
  - `readProjectRows(file: string): ProjectRecord[]` — read-only, no key, works on a v2 or v3 vault, `[]` when absent or unreadable.
  - `projectForRoot(projects: ProjectRecord[], root: string): ProjectRecord | null`
  - `type ScopeOwner = { kind: "new" } | { kind: "same-checkout" } | { kind: "another-checkout"; roots: string[] } | { kind: "different-package"; packageName: string | null; root: string }`
  - `checkScopeOwner(projects: ProjectRecord[], scope: string, root: string, packageName: string | null): ScopeOwner`
  - `scopeCollisionMessage(scope: string, owner: { packageName: string | null; root: string }): string`
  - `scopeShareMessage(scope: string, owner: { packageName: string | null; root: string }): string`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/vault-projects.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDataKey } from "../src/vault/crypto";
import {
  canonicalRoot,
  checkScopeOwner,
  projectForRoot,
  readProjectRows,
  scopeCollisionMessage,
  scopeShareMessage,
} from "../src/vault/projects";
import { openVault, type ProjectRecord } from "../src/vault/store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = canonicalRoot(mkdtempSync(join(tmpdir(), "kerstel-projects-")));
  dirs.push(dir);
  return dir;
}
/** A folder holding a package.json with `name` (or none). */
function pkg(parent: string, folder: string, name: string | null): string {
  const root = join(parent, folder);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify(name === null ? {} : { name }));
  return root;
}
function row(name: string, rootPath: string, packageName: string | null): ProjectRecord {
  return { name, rootPath, packageName, createdAt: 1 };
}

test("no rows with the scope is new", () => {
  expect(checkScopeOwner([row("web", "/x/web", "web")], "api", "/y/api", "@acme/api")).toEqual({ kind: "new" });
});

test("a row for this folder is the same checkout, through a symlink too", () => {
  const base = temp();
  const root = pkg(base, "api", "@acme/api");
  const link = join(base, "link");
  symlinkSync(root, link);
  const rows = [row("api", link, "@acme/api")];
  expect(checkScopeOwner(rows, "api", root, "@acme/api")).toEqual({ kind: "same-checkout" });
  expect(projectForRoot(rows, root)?.name).toBe("api");
});

test("a row for the same package elsewhere is another checkout", () => {
  const rows = [row("api", "/main/api", "@acme/api"), row("api", "/wt/api", "@acme/api")];
  expect(checkScopeOwner(rows, "api", "/third/api", "@acme/api")).toEqual({
    kind: "another-checkout",
    roots: ["/main/api", "/wt/api"],
  });
});

test("a row for a different package is a collision, and names that package", () => {
  const owner = checkScopeOwner([row("api", "/acme/api", "@acme/api")], "api", "/other/api", "@other/api");
  expect(owner).toEqual({ kind: "different-package", packageName: "@acme/api", root: "/acme/api" });
  expect(scopeCollisionMessage("api", { packageName: "@acme/api", root: "/acme/api" })).toBe(
    'The scope "api" belongs to @acme/api at /acme/api. Re-run with --scope <name> to give this package its own.',
  );
  expect(scopeShareMessage("api", { packageName: null, root: "/acme/api" })).toBe(
    'The scope "api" is also used by the package at /acme/api; this folder will share its secrets.',
  );
});

test("a row from before schema 3 is compared through the package.json in its folder", () => {
  const base = temp();
  const same = pkg(base, "main", "@acme/api");
  const other = pkg(base, "elsewhere", "@other/api");
  expect(checkScopeOwner([row("api", same, null)], "api", "/wt/api", "@acme/api").kind).toBe("another-checkout");
  expect(checkScopeOwner([row("api", other, null)], "api", "/wt/api", "@acme/api")).toEqual({
    kind: "different-package",
    packageName: "@other/api",
    root: other,
  });
});

test("an old row whose folder is gone matches only a nameless package with the same basename", () => {
  const gone = "/nowhere/at/all/api";
  expect(checkScopeOwner([row("api", gone, null)], "api", "/wt/api", null).kind).toBe("another-checkout");
  expect(checkScopeOwner([row("api", gone, null)], "api", "/wt/api", "@acme/api").kind).toBe("different-package");
  expect(checkScopeOwner([row("api", gone, null)], "api", "/wt/other", null).kind).toBe("different-package");
});

test("packages with no name on either side match by basename", () => {
  const base = temp();
  const nameless = pkg(base, "api", null);
  expect(checkScopeOwner([row("api", nameless, null)], "api", "/wt/api", null).kind).toBe("another-checkout");
  expect(checkScopeOwner([row("api", nameless, null)], "api", "/wt/web", null).kind).toBe("different-package");
});

test("a row for this folder wins over a row for another package", () => {
  const rows = [row("api", "/acme/api", "@acme/api"), row("api", "/here/api", "@other/api")];
  expect(checkScopeOwner(rows, "api", "/here/api", "@other/api")).toEqual({ kind: "same-checkout" });
});

test("readProjectRows reads a v3 vault without the key, and a missing one as empty", () => {
  const dir = temp();
  const file = join(dir, "vault.db");
  expect(readProjectRows(file)).toEqual([]);
  const v = openVault(generateDataKey(), file);
  v.registerProject("api", "/a/api", "@acme/api");
  v.close();
  expect(readProjectRows(file)).toEqual([
    expect.objectContaining({ name: "api", rootPath: "/a/api", packageName: "@acme/api" }),
  ]);
});

test("readProjectRows reads a v2 vault that has no package_name column", () => {
  const dir = temp();
  const file = join(dir, "vault.db");
  const db = new Database(file, { create: true });
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, root_path TEXT NOT NULL, created_at INTEGER NOT NULL);
           INSERT INTO projects (name, root_path, created_at) VALUES ('api', '/a/api', 5);`);
  db.close();
  expect(readProjectRows(file)).toEqual([{ name: "api", rootPath: "/a/api", packageName: null, createdAt: 5 }]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/cli/test/vault-projects.test.ts`
Expected: FAIL — cannot find module `../src/vault/projects`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/vault/projects.ts`:

```ts
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
 * to schema 3 (no `package_name` column). Absent or unreadable is empty.
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
        `SELECT name, root_path, ${packageColumn}, created_at FROM projects ORDER BY name, root_path`,
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

export function scopeCollisionMessage(scope: string, owner: { packageName: string | null; root: string }): string {
  return `The scope "${scope}" belongs to ${describeOwner(owner)}. Re-run with --scope <name> to give this package its own.`;
}

export function scopeShareMessage(scope: string, owner: { packageName: string | null; root: string }): string {
  return `The scope "${scope}" is also used by ${describeOwner(owner)}; this folder will share its secrets.`;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/cli/test/vault-projects.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/vault/projects.ts packages/cli/test/vault-projects.test.ts
git commit -m "feat(vault): classify a folder against the checkouts of its scope"
```

---

### Task 3: `init` recognises checkouts

**Files:**
- Modify: `packages/cli/src/commands/init.ts` — scope derivation (`const scope = options.scope ?? deriveScope(...)`, around line 656), the step line right after it, and both `registerProject(scope, detected.root)` calls (around lines 817 and 947)
- Test: `packages/cli/test/init.test.ts`

**Interfaces:**
- Consumes: `readProjectRows`, `projectForRoot`, `checkScopeOwner`, `scopeCollisionMessage`, `scopeShareMessage`, `canonicalRoot` (Task 2); `registerProject(name, rootPath, packageName)` (Task 1); `vaultPath()` from `../paths` (already imported for `readStoredReferences`).

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/init.test.ts` (add `import { captureLog } from "./helpers/capture-log";` and `import { DefaultsPrompter } from ...` is already imported):

```ts
const API_PACKAGE = (name: string) => `{\n  "name": "${name}",\n  "scripts": {\n    "dev": "vite"\n  }\n}\n`;

test("a second checkout of the same package is registered beside the first", async () => {
  isolateEnv({ prefix: "init-checkouts" });
  await bootLocalDaemon();
  const main = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-aaaa-1111\n" });
  const worktree = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=kerstel://api/API_TOKEN\n" });

  expect(await runInit({ ...options(main), yes: true }, new DefaultsPrompter())).toBe(0);
  const log = captureLog();
  let code: number;
  try {
    code = await runInit({ ...options(worktree), yes: true }, new DefaultsPrompter());
  } finally {
    log.restore();
  }
  expect(code).toBe(0);
  expect(log.text()).toContain("Another checkout of api is at");

  await openTestVault((vault) => {
    const rows = vault.listProjects().filter((p) => p.name === "api");
    expect(rows.map((p) => p.rootPath).sort()).toEqual([realpathSync(main), realpathSync(worktree)].sort());
    expect(rows.every((p) => p.packageName === "@acme/api")).toBe(true);
    expect(vault.getSecret({ scope: "api", key: "API_TOKEN" })).toBe("tok-aaaa-1111");
  });
});

test("a different package whose name slugifies the same is refused, naming the owner", async () => {
  isolateEnv({ prefix: "init-collision" });
  await bootLocalDaemon();
  const acme = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-aaaa-1111\n" });
  const other = makeProject({ "package.json": API_PACKAGE("@other/api"), ".env": "API_TOKEN=tok-bbbb-2222\n" });
  expect(await runInit({ ...options(acme), yes: true }, new DefaultsPrompter())).toBe(0);

  for (const extra of [[], ["--dry-run"]]) {
    const log = captureLog();
    let code: number;
    try {
      code = await runInit({ ...options(other, extra), yes: true }, new DefaultsPrompter());
    } finally {
      log.restore();
    }
    expect(code).toBe(2);
    expect(log.text()).toContain(`The scope "api" belongs to @acme/api at ${realpathSync(acme)}.`);
    expect(log.text()).not.toContain("tok-bbbb-2222");
  }
  expect(readFileSync(join(other, ".env"), "utf8")).toBe("API_TOKEN=tok-bbbb-2222\n");
});

test("an explicit --scope shares a scope with another package, and says so", async () => {
  isolateEnv({ prefix: "init-share" });
  await bootLocalDaemon();
  const acme = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-aaaa-1111\n" });
  const other = makeProject({ "package.json": API_PACKAGE("@other/api"), ".env": "OTHER_TOKEN=tok-cccc-3333\n" });
  expect(await runInit({ ...options(acme), yes: true }, new DefaultsPrompter())).toBe(0);

  const log = captureLog();
  let code: number;
  try {
    code = await runInit({ ...options(other, ["--scope", "api"]), yes: true }, new DefaultsPrompter());
  } finally {
    log.restore();
  }
  expect(code).toBe(0);
  expect(log.text()).toContain(`The scope "api" is also used by @acme/api at ${realpathSync(acme)}`);
  await openTestVault((vault) => {
    expect(vault.listProjects().filter((p) => p.name === "api")).toHaveLength(2);
  });
});

test("a re-run without --scope keeps the scope this folder was registered under", async () => {
  isolateEnv({ prefix: "init-rerun-scope" });
  await bootLocalDaemon();
  const root = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-aaaa-1111\n" });
  expect(await runInit({ ...options(root, ["--scope", "custom"]), yes: true }, new DefaultsPrompter())).toBe(0);
  writeFileSync(join(root, ".env"), "API_TOKEN=kerstel://custom/API_TOKEN\nNEW_TOKEN=tok-dddd-4444\n");
  expect(await runInit({ ...options(root), yes: true }, new DefaultsPrompter())).toBe(0);

  expect(readFileSync(join(root, ".env"), "utf8")).toContain("NEW_TOKEN=kerstel://custom/NEW_TOKEN");
  await openTestVault((vault) => {
    expect(vault.listProjects().map((p) => p.name)).toEqual(["custom"]);
  });
});
```

Add `realpathSync` to the existing `node:fs` import.

- [ ] **Step 2: Run them to see them fail**

Run: `bun run --cwd packages/hook build && bun test packages/cli/test/init.test.ts -t "checkout|slugifies|explicit --scope|re-run without"`
Expected: FAIL (one row per scope today; no collision refusal; no share line).

- [ ] **Step 3: Implement the scope check**

In `packages/cli/src/commands/init.ts`, import:

```ts
import {
  canonicalRoot,
  checkScopeOwner,
  projectForRoot,
  readProjectRows,
  scopeCollisionMessage,
  scopeShareMessage,
} from "../vault/projects";
```

Replace the `const scope = options.scope ?? deriveScope(...)` block and the `step(...)` that follows it with:

```ts
  // Checkouts spec §6.2. The projects table is readable without the key, so
  // this runs under --dry-run too, before anything is shown or written.
  const projects = readProjectRows(vaultPath());
  const scope =
    options.scope ??
    projectForRoot(projects, detected.root)?.name ??
    deriveScope({ packageName: detected.packageName, rootPath: detected.root }).scope;
  const owner = checkScopeOwner(projects, scope, detected.root, detected.packageName);
  if (owner.kind === "different-package" && options.scope === undefined) {
    fail(scopeCollisionMessage(scope, owner));
    return 2;
  }

  const fileNames = detected.envFiles.map((file) => file.name);
  step(
    [`Setting up ${scope}`, `${detected.framework ?? detected.runtime} on ${detected.packageManager}`]
      .concat(fileNames.length > 0 ? [fileNames.join(", ")] : [])
      .join(" · "),
  );
  if (owner.kind === "another-checkout") info(`Another checkout of ${scope} is at ${owner.roots.join(", ")}.`);
  if (owner.kind === "different-package") info(scopeShareMessage(scope, owner));
```

Check that `options.scope` is `undefined` when not given (see `parseInitArgs`, `scope?: string`); if it is `null` there, compare against that instead. Ensure `info` and `fail` are imported from `../output` (they are used elsewhere in the file; add any missing).

Replace both registration calls:

```ts
ctx.vault.registerProject(scope, canonicalRoot(detected.root), detected.packageName);
```
```ts
vault.registerProject(scope, canonicalRoot(detected.root), detected.packageName);
```

- [ ] **Step 4: Run init tests and the whole suite**

Run: `bun test packages/cli/test/init.test.ts` then `bun run typecheck && bun run test`
Expected: PASS. If an existing test ran `init` twice in one `KERSTEL_HOME` with two different package names that slugify the same, it now exits 2: give that test distinct names rather than changing the rule.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/init.ts packages/cli/test/init.test.ts
git commit -m "feat(init): register a second checkout and refuse a colliding derived scope"
```

---

### Task 4: `init` reuses values the vault already holds

**Files:**
- Modify: `packages/cli/src/init/overview.ts` (`OverviewRow`, `renderOverview`)
- Modify: `packages/cli/src/commands/init.ts` — `Decision` type, `decideTargets`, the call site (around line 760), and `toStore` (around line 940)
- Test: `packages/cli/test/init-overview.test.ts`, `packages/cli/test/init.test.ts`

**Interfaces:**
- Produces: `OverviewRow.note?: string` rendered as a dim fourth column; `Decision.vaultEntry: "same" | "differs" | "unknown" | null` and `Decision.keepVault: boolean`.

Rules (spec §6.3):
- Without a `--keep`/`--global` flag, a plaintext key's initial target is `project` when `<scope>/KEY` exists, else `global` when `global/KEY` exists, else the classifier's suggestion. The reason becomes `already in the vault`.
- After "Look right?" is accepted, each non-plaintext decision is compared with the entry at its final target: equal → `same` (no store); different → `differs`; no entry → `null`. Under `--dry-run` (no `ctx`), an existing entry is `unknown` and nothing is compared.
- Each `differs` key asks `KEY: kerstel://<scope>/KEY already holds a different value. Which one stays?` with `keep` = `Keep the vault's value` (default) and `use` = `Use this file's value`. `DefaultsPrompter` (`--yes`, `--non-interactive`) returns the default.
- `keepVault` is true for `same` and for a `keep` answer; those are not stored. `--keep` still wins (target `plaintext`, never compared).

- [ ] **Step 1: Overview note test**

Append to `packages/cli/test/init-overview.test.ts`:

```ts
test("a row's note is shown after its source", () => {
  const lines = renderOverview(
    [
      { key: "API_TOKEN", value: "x".repeat(12), source: ".env", conflicts: [], target: "project", showValue: false, note: "already in the vault" },
      { key: "DB_URL", value: "y".repeat(20), source: ".env", conflicts: [], target: "project", showValue: false },
    ],
    "api",
    [".env"],
  );
  const text = lines.join("\n");
  expect(text).toContain("already in the vault");
  expect(text).not.toContain("x".repeat(12));
});
```

- [ ] **Step 2: init behaviour tests**

Append to `packages/cli/test/init.test.ts`:

```ts
async function initQuietly(root: string, args: string[], prompter: Prompter) {
  const log = captureLog();
  try {
    return { code: await runInit(options(root, args), prompter), out: log.text() };
  } finally {
    log.restore();
  }
}

test("a value the vault already holds becomes a reference without being stored again", async () => {
  isolateEnv({ prefix: "init-same-value" });
  await bootLocalDaemon();
  await openTestVault((vault) => vault.setSecret({ scope: "api", key: "API_TOKEN" }, "tok-aaaa-1111"));
  const root = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-aaaa-1111\n" });

  const { code, out } = await initQuietly(root, ["--yes"], new DefaultsPrompter());
  expect(code).toBe(0);
  expect(out).toContain("already in the vault");
  expect(out).not.toContain("tok-aaaa-1111");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_TOKEN=kerstel://api/API_TOKEN\n");
});

test("a differing value keeps the vault's by default, and the file's on request", async () => {
  isolateEnv({ prefix: "init-differs" });
  await bootLocalDaemon();
  await openTestVault((vault) => vault.setSecret({ scope: "api", key: "API_TOKEN" }, "tok-vault-0000"));

  const kept = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-file-1111\n" });
  const first = await initQuietly(kept, ["--yes"], new DefaultsPrompter());
  expect(first.code).toBe(0);
  expect(first.out).toContain("differs from the vault");
  expect(first.out).not.toContain("tok-file-1111");
  expect(first.out).not.toContain("tok-vault-0000");
  expect(readFileSync(join(kept, ".env"), "utf8")).toBe("API_TOKEN=kerstel://api/API_TOKEN\n");
  await openTestVault((vault) => expect(vault.getSecret({ scope: "api", key: "API_TOKEN" })).toBe("tok-vault-0000"));

  const used = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-file-2222\n" });
  const prompter = new ScriptedPrompter(["accept", "use", "apply"]);
  expect((await initQuietly(used, [], prompter)).code).toBe(0);
  expect(prompter.asked.some((q) => q.includes("already holds a different value"))).toBe(true);
  await openTestVault((vault) => expect(vault.getSecret({ scope: "api", key: "API_TOKEN" })).toBe("tok-file-2222"));
});

test("an existing global entry sets the destination, and --keep still wins", async () => {
  isolateEnv({ prefix: "init-global-entry" });
  await bootLocalDaemon();
  await openTestVault((vault) => vault.setSecret({ scope: "global", key: "SHARED_TOKEN" }, "tok-shared-5555"));
  const root = makeProject({
    "package.json": API_PACKAGE("@acme/api"),
    ".env": "SHARED_TOKEN=tok-shared-5555\nKEPT_TOKEN=tok-kept-6666\n",
  });
  await openTestVault((vault) => vault.setSecret({ scope: "api", key: "KEPT_TOKEN" }, "tok-other-7777"));

  expect((await initQuietly(root, ["--yes", "--keep", "KEPT_TOKEN"], new DefaultsPrompter())).code).toBe(0);
  const env = readFileSync(join(root, ".env"), "utf8");
  expect(env).toContain("SHARED_TOKEN=kerstel://global/SHARED_TOKEN");
  expect(env).toContain("KEPT_TOKEN=tok-kept-6666");
  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "api", key: "SHARED_TOKEN" })).toBeNull();
    expect(vault.getSecret({ scope: "api", key: "KEPT_TOKEN" })).toBe("tok-other-7777");
  });
});

test("--dry-run marks a key the vault holds without comparing values", async () => {
  isolateEnv({ prefix: "init-dry-entry" });
  await openTestVault((vault) => vault.setSecret({ scope: "api", key: "API_TOKEN" }, "tok-vault-0000"));
  const root = makeProject({ "package.json": API_PACKAGE("@acme/api"), ".env": "API_TOKEN=tok-file-1111\n" });
  const { code, out } = await initQuietly(root, ["--dry-run", "--yes"], new DefaultsPrompter());
  expect(code).toBe(0);
  expect(out).toContain("in the vault");
  expect(out).not.toContain("differs from the vault");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_TOKEN=tok-file-1111\n");
});
```

Add `type Prompter` to the `../src/init/prompts` import.

- [ ] **Step 3: Run them to see them fail**

Run: `bun test packages/cli/test/init-overview.test.ts packages/cli/test/init.test.ts -t "note|already holds|differing|global entry|without comparing"`
Expected: FAIL.

- [ ] **Step 4: Overview note**

In `packages/cli/src/init/overview.ts`, add to `OverviewRow`:

```ts
  /** A short fact about the vault's copy (`already in the vault`, `differs from the vault`). Never a value. */
  note?: string;
```

and in `renderOverview` change the row cells to:

```ts
      members.map((row) => [row.key, valueColumn(row.value, row.showValue), dim(row.source), row.note ? dim(row.note) : ""]),
```

If `renderTable` pads a trailing empty column into trailing spaces that break an existing exact-output test, trim each rendered line's end (`.map((line) => line.trimEnd())`) in `renderOverview`, not in `renderTable`.

- [ ] **Step 5: Decisions in `init.ts`**

Extend the `Decision` interface (find it with `grep -n "interface Decision" packages/cli/src/commands/init.ts`):

```ts
  /** Checkouts spec §6.3: how the vault's entry at the final target compares. Null: no entry. */
  vaultEntry: "same" | "differs" | "unknown" | null;
  /** True when the vault's value stays and nothing is stored for this key. */
  keepVault: boolean;
```

Give `decideTargets` one more parameter, `vault: VaultLookup`, defined above it:

```ts
/**
 * What `decideTargets` may ask the vault. `has` works in a dry run (names
 * only); `value` is null there, since the dry run never opens the vault.
 */
interface VaultLookup {
  has(ref: SecretRef): boolean;
  value(ref: SecretRef): string | null;
  canCompare: boolean;
}
```

In `decideTargets`, build decisions as:

```ts
  const existingTarget = (key: string): Suggestion | null =>
    vault.has({ scope, key }) ? "project" : vault.has({ scope: GLOBAL_SCOPE, key }) ? "global" : null;
  const decisions: Decision[] = keys.map((key) => {
    const { suggestion, reason } = explain(key.key, key.value);
    const base = { key, suggestion, vaultEntry: null, keepVault: false } as const;
    if (options.keepKeys.has(key.key)) return { ...base, target: "plaintext", reason, fixed: true };
    if (options.globalKeys.has(key.key)) return { ...base, target: "global", reason, fixed: true };
    const existing = existingTarget(key.key);
    if (existing) return { ...base, target: existing, reason: "already in the vault", fixed: false };
    return { ...base, target: suggestion, reason, fixed: false };
  });

  const compare = (d: Decision): void => {
    if (d.target === "plaintext") {
      d.vaultEntry = null;
      return;
    }
    const ref = { scope: d.target === "global" ? GLOBAL_SCOPE : scope, key: d.key.key };
    if (!vault.has(ref)) d.vaultEntry = null;
    else if (!vault.canCompare) d.vaultEntry = "unknown";
    else d.vaultEntry = vault.value(ref) === d.key.value ? "same" : "differs";
  };
  const noteFor = (d: Decision): string | undefined =>
    d.vaultEntry === "same"
      ? "already in the vault"
      : d.vaultEntry === "differs"
        ? "differs from the vault"
        : d.vaultEntry === "unknown"
          ? "in the vault"
          : undefined;
```

In `showOverview`, call `decisions.forEach(compare)` first and add `note: noteFor(d)` to each row.

Replace each `return decisions;` in `decideTargets` (the `open.length === 0` early return and the `accept` return) with `return askVaultConflicts(decisions, scope, prompter);`, defined below `decideTargets`:

```ts
/** Checkouts spec §6.3: one question per key whose file value differs from the vault's. */
async function askVaultConflicts(decisions: Decision[], scope: string, prompter: Prompter): Promise<Decision[]> {
  for (const d of decisions) {
    if (d.vaultEntry === "same") d.keepVault = true;
    if (d.vaultEntry !== "differs") continue;
    const reference = formatReference(d.target === "global" ? GLOBAL_SCOPE : scope, d.key.key);
    const answer = await prompter.select(
      `${d.key.key}: ${reference} already holds a different value. Which one stays?`,
      [
        { value: "keep", label: "Keep the vault's value" },
        { value: "use", label: "Use this file's value" },
      ],
      "keep",
    );
    d.keepVault = answer === "keep";
  }
  return decisions;
}
```

At the call site, pass the lookup:

```ts
    const lookup: VaultLookup = {
      has: inVault,
      value: (ref) => (ctx ? ctx.vault.getSecret(ref) : null),
      canCompare: ctx !== null,
    };
    const decisions = plain.length > 0 ? await decideTargets(plain, scope, fileNames, options, prompter, lookup) : [];
```

and exclude kept values from the store:

```ts
    const toStore = decisions.filter((decision) => decision.target !== "plaintext" && !decision.keepVault);
```

Leave the `references` map as it is: every non-plaintext decision still becomes a reference. Check the self-check's probe (around line 1000): it compares the vault's value with `probeDecision`; if it picks a decision with `keepVault`, it must expect the vault's value, not `decision.key.value`. Read that block and make it read the expected value from the vault (`vault.getSecret(...)`) as it already does, not from the decision.

- [ ] **Step 6: Run the tests and the suite**

Run: `bun test packages/cli/test/init-overview.test.ts packages/cli/test/init.test.ts` then `bun run typecheck && bun run test`
Expected: PASS. An existing test whose vault already held a differing value for a key now sees one more question; add `"keep"` to its `ScriptedPrompter` answers at the right position rather than changing the rule.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/init/overview.ts packages/cli/src/commands/init.ts packages/cli/test/init-overview.test.ts packages/cli/test/init.test.ts
git commit -m "feat(init): reuse a value the vault already holds, and ask when it differs"
```

---

### Task 5: `ks move` checks every checkout

**Files:**
- Create: `packages/cli/src/move/checkouts.ts`
- Modify: `packages/cli/src/move/plan.ts` (`PlanInput`, `KeptCopy` doc, the §3.1 block around line 331)
- Modify: `packages/cli/src/move/apply.ts` (options, step 5 around line 231)
- Modify: `packages/cli/src/commands/move.ts` (scope, `renderPreview`'s kept line, the plan/apply calls; drop the local `safeRealpath` for `canonicalRoot`)
- Test: `packages/cli/test/move-plan.test.ts`, `packages/cli/test/move-apply.test.ts`, `packages/cli/test/move.test.ts`, new `packages/cli/test/move-checkouts.test.ts`

**Interfaces:**
- Consumes: `canonicalRoot`, `projectForRoot`, `checkScopeOwner`, `scopeCollisionMessage` (Task 2).
- Produces:
  - `referencesInCheckouts(roots: string[]): Map<string, string>` — `refId` of every `kerstel://` reference in those checkouts' env files → the first root that reads it.
  - `PlanInput.otherCheckoutRefs: Map<string, string>` (replaces `recordedRoot`).
  - `ApplyOptions.registered: boolean` and `ApplyOptions.packageName: string | null` (replace `recordedRoot`); register when `registered` is false.

- [ ] **Step 1: `referencesInCheckouts` test**

Create `packages/cli/test/move-checkouts.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referencesInCheckouts } from "../src/move/checkouts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-checkout-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), '{ "name": "app" }\n');
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  return root;
}

test("collects every reference each checkout reads, first root first", () => {
  const a = checkout({ ".env": "K=kerstel://app/K\nP=plain\n" });
  const b = checkout({ ".env.local": "K=kerstel://app/K\nG=kerstel://global/G\n" });
  const refs = referencesInCheckouts([a, b]);
  expect(refs.get("kerstel://app/K")).toBe(a);
  expect(refs.get("kerstel://global/G")).toBe(b);
  expect(refs.has("kerstel://app/P")).toBe(false);
});

test("a checkout whose folder is gone reads nothing", () => {
  expect(referencesInCheckouts(["/nowhere/at/all"]).size).toBe(0);
});
```

If `refId` in `move/plan.ts` formats differently from `kerstel://scope/KEY`, use `refId({ scope, key })` in the test's keys instead of the literal strings.

- [ ] **Step 2: Implement `move/checkouts.ts`**

```ts
import { existsSync } from "node:fs";
import { loadEnvFiles } from "../init/collect";
import { detectProject } from "../init/detect";
import { entries } from "../init/dotenv-file";
import { parseReference } from "../reference";
import { refId } from "./plan";

/**
 * Move spec §3.1: the references other checkouts of this scope still read,
 * each mapped to the first checkout root that reads it. Read the way
 * `uninstall` reads a checkout, and never written. A folder that is gone, or
 * whose env files cannot be read, reads nothing.
 */
export function referencesInCheckouts(roots: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let loaded: ReturnType<typeof loadEnvFiles>;
    try {
      loaded = loadEnvFiles(detectProject(root).envFiles);
    } catch {
      continue;
    }
    for (const entry of loaded) {
      for (const pair of entries(entry.file)) {
        const ref = parseReference(pair.value);
        if (ref && !found.has(refId(ref))) found.set(refId(ref), root);
      }
    }
  }
  return found;
}
```

Run: `bun test packages/cli/test/move-checkouts.test.ts` — Expected: PASS.

- [ ] **Step 3: Planner — update tests, then code**

In `packages/cli/test/move-plan.test.ts`, change the setup's `recordedRoot?: string | null` option to `otherCheckoutRefs?: Map<string, string>` and pass `otherCheckoutRefs: setup.otherCheckoutRefs ?? new Map()`. Rewrite the two tests at lines ~260–280 as:

```ts
test("a project copy another checkout reads is kept, naming that checkout", () => {
  const result = plan({
    // ...the same env/vault setup the old "other-checkout" test used...
    otherCheckoutRefs: new Map([["kerstel://app/K", "/elsewhere/app"]]),
  });
  expect(result.deletions).toEqual([]);
  expect(result.kept).toEqual([{ ref: { scope: "app", key: "K" }, reason: "other-checkout", root: "/elsewhere/app" }]);
});

test("a project copy no checkout reads is deleted", () => {
  const result = plan({
    // ...the same setup...
    otherCheckoutRefs: new Map([["kerstel://app/OTHER", "/elsewhere/app"]]),
  });
  expect(result.deletions.map((d) => d.ref)).toEqual([{ scope: "app", key: "K" }]);
});
```

Keep the setup fields of the two old tests exactly (read them first); only the `recordedRoot` field changes.

In `packages/cli/src/move/plan.ts`, replace the `recordedRoot` field of `PlanInput` with:

```ts
  /**
   * References the other registered checkouts of `scope` still read, by
   * `refId`, each with the first checkout root that reads it (move spec §3.1).
   */
  otherCheckoutRefs: Map<string, string>;
```

and the branch at line ~331 with:

```ts
    } else if (input.otherCheckoutRefs.has(id)) {
      plan.kept.push({ ref: move.fromRef, reason: "other-checkout", root: input.otherCheckoutRefs.get(id)! });
```

Update the file's top comment ("the recorded root") to "the other checkouts' references".

Run: `bun test packages/cli/test/move-plan.test.ts` — Expected: PASS.

- [ ] **Step 4: Apply — update tests, then code**

In `packages/cli/test/move-apply.test.ts`: the `makePlan` helper's `recordedRoot` parameter becomes `otherCheckoutRefs: Map<string, string> = new Map()`; every `applyMove(..., recordedRoot: root)` becomes `registered: true, packageName: "app"`. Replace the two registration tests (lines ~236–250) with:

```ts
test("this folder is registered when it has no row, beside another checkout's", () => {
  const { root, vault, dataKey } = setup({ ".env": "A=plain\n" }, {});
  vault.registerProject("app", "/elsewhere/app", "app");
  const plan = makePlan(root, vault, [["A:plaintext", "project"]], {});
  const result = applyMove(plan, { vault, dataKey, scope: "app", root, registered: false, packageName: "app" });
  expect(result.registered).toBe(true);
  expect(vault.listProjects().map((p) => p.rootPath).sort()).toEqual(["/elsewhere/app", root].sort());
});

test("a folder that already has a row is not registered again", () => {
  const { root, vault, dataKey } = setup({ ".env": "A=plain\n" }, {});
  vault.registerProject("custom", root, "app");
  const plan = makePlan(root, vault, [["A:plaintext", "project"]], {});
  const result = applyMove(plan, { vault, dataKey, scope: "app", root, registered: true, packageName: "app" });
  expect(result.registered).toBe(false);
  expect(vault.listProjects()).toEqual([expect.objectContaining({ name: "custom", rootPath: root })]);
});
```

In `packages/cli/src/move/apply.ts`, replace `recordedRoot: string | null;` in the options with:

```ts
  /** True when this folder already has a project row (move spec §5 step 5). */
  registered: boolean;
  /** This folder's package.json name, recorded with the row. */
  packageName: string | null;
```

and step 5 with:

```ts
  // 5. Project record, only when this folder has none. Rows are keyed on the
  // folder, so this never replaces another checkout's record.
  let registered = false;
  if (!options.registered) {
    try {
      vault.registerProject(options.scope, options.root, options.packageName);
      registered = true;
    } catch (error) {
      problems.push(`Could not record ${options.scope} in the vault: ${(error as Error).message}`);
    }
  }
```

Run: `bun test packages/cli/test/move-apply.test.ts` — Expected: PASS.

- [ ] **Step 5: Command — tests**

Append to `packages/cli/test/move.test.ts` (add `mkdirSync` to the `node:fs` import):

```ts
function secondCheckout(env: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-move-wt-"));
  createdDirs.push(root);
  writeFileSync(join(root, "package.json"), PACKAGE);
  for (const [name, contents] of Object.entries(env)) writeFileSync(join(root, name), contents);
  return root;
}

test("a copy another checkout still reads is kept and that checkout is named", async () => {
  const root = makeProject({ ".env": "STRIPE_KEY=kerstel://app/STRIPE_KEY\n" });
  const other = secondCheckout({ ".env": "STRIPE_KEY=kerstel://app/STRIPE_KEY\n" });
  await withVault((v) => {
    v.setSecret({ scope: "app", key: "STRIPE_KEY" }, SECRET);
    v.registerProject("app", root, "app");
    v.registerProject("app", other, "app");
  });
  const { code, out } = await run(root, ["STRIPE_KEY", "--to", "plaintext", "--yes"], null);

  expect(code).toBe(0);
  expect(await withVault((v) => v.getSecret({ scope: "app", key: "STRIPE_KEY" }))).toBe(SECRET);
  expect(out).toContain("is kept: the checkout at");
  expect(out).toContain("still reads it");
  expect(out).not.toContain(SECRET);
});

test("a copy no checkout reads is deleted even with another checkout registered", async () => {
  const root = makeProject({ ".env": "STRIPE_KEY=kerstel://app/STRIPE_KEY\n" });
  const other = secondCheckout({ ".env": "OTHER=plain\n" });
  await withVault((v) => {
    v.setSecret({ scope: "app", key: "STRIPE_KEY" }, SECRET);
    v.registerProject("app", root, "app");
    v.registerProject("app", other, "app");
  });
  expect((await run(root, ["STRIPE_KEY", "--to", "plaintext", "--yes"], null)).code).toBe(0);
  expect(await withVault((v) => v.getSecret({ scope: "app", key: "STRIPE_KEY" }))).toBeNull();
});

test("a derived scope that belongs to a different package is refused before anything is asked", async () => {
  const root = makeProject({ ".env": "K=plain-value\n" });
  await withVault((v) => v.registerProject("app", "/somewhere/else/app", "@other/app"));
  const { code, out } = await run(root, ["K", "--to", "project", "--yes"], null);
  expect(code).toBe(2);
  expect(out).toContain('The scope "app" belongs to @other/app at /somewhere/else/app.');
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("K=plain-value\n");
});
```

Run: `bun test packages/cli/test/move.test.ts` — Expected: the three new tests FAIL (and the file may not compile until Step 6 fixes `runMove`'s calls).

- [ ] **Step 6: Command — implementation**

In `packages/cli/src/commands/move.ts`:

1. Delete the local `safeRealpath` and import `canonicalRoot, checkScopeOwner, projectForRoot, scopeCollisionMessage` from `../vault/projects` and `referencesInCheckouts` from `../move/checkouts`. Replace every `safeRealpath(` with `canonicalRoot(`.
2. Replace the scope block (around line 170) with:

```ts
    const projects = vault.listProjects();
    const here = projectForRoot(projects, detected.root);
    const derived = deriveScope({ packageName: detected.packageName, rootPath: detected.root }).scope;
    const scope = here?.name ?? resolveProjectScope(loaded, derived);
    // Checkouts spec §6.4: a derived name another package already holds is
    // that package's scope, not this one's.
    if (!here && scope === derived) {
      const owner = checkScopeOwner(projects, scope, detected.root, detected.packageName);
      if (owner.kind === "different-package") {
        fail(scopeCollisionMessage(scope, owner));
        return 2;
      }
    }
```

   Keep the existing comment above it about the recorded scope being the best witness. If `resolveProjectScope` can return the derived name even when the files reference it, that is still "derived" for this check, which is intended: the files referencing `app/…` in a folder whose package is not `@other/app` is the same accident.

3. Replace the `storedRoot`/`recordedRoot` block (around line 250) with:

```ts
    // Move spec §3.1: a copy another registered checkout of this scope still
    // reads is kept. Their env files are read, never written.
    const otherRoots = projects
      .filter((p) => p.name === scope && canonicalRoot(p.rootPath) !== detected.root)
      .map((p) => p.rootPath);
    const otherCheckoutRefs = referencesInCheckouts(otherRoots);
```

   and in `makePlan`'s `planMove({...})` replace `recordedRoot,` with `otherCheckoutRefs,`.

4. In the `applyMove` call replace `recordedRoot` with `registered: here !== null, packageName: detected.packageName`.
5. In `renderPreview`, change the `other-checkout` line to:

```ts
          : `    ${refId(k.ref)} is kept: the checkout at ${k.root} still reads it.`,
```

- [ ] **Step 7: Run the move tests and the suite**

Run: `bun test packages/cli/test/move*.test.ts` then `bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/move packages/cli/src/commands/move.ts packages/cli/test/move*.test.ts
git commit -m "feat(move): keep a copy only while another checkout reads it"
```

---

### Task 6: `doctor` names the registered scope and the other checkouts

**Files:**
- Modify: `packages/cli/src/init/status.ts` (`ProjectStatus`, `projectStatus`)
- Modify: `packages/cli/src/doctor/checks.ts` (new `checkoutsCheck`, `gatherChecks`)
- Test: `packages/cli/test/init-status.test.ts`, `packages/cli/test/doctor-checks.test.ts`

**Interfaces:**
- Consumes: `projectForRoot`, `canonicalRoot` (Task 2); `ProjectRecord` (Task 1).
- Produces: `ProjectStatus.otherCheckouts: string[]`; `projectStatus(root, vault: { getSecret(ref: SecretRef): string | null; listProjects?(): ProjectRecord[] })`.

- [ ] **Step 1: Tests**

Append to `packages/cli/test/init-status.test.ts`:

```ts
test("projectStatus takes the scope from this folder's row and lists the other checkouts", () => {
  const root = makeProject({ "package.json": '{ "name": "@acme/api" }\n' });
  const rows = [
    { name: "custom", rootPath: root, packageName: "@acme/api", createdAt: 1 },
    { name: "custom", rootPath: "/wt/api", packageName: "@acme/api", createdAt: 2 },
    { name: "other", rootPath: "/x/other", packageName: "other", createdAt: 3 },
  ];
  const status = projectStatus(root, { getSecret: () => null, listProjects: () => rows });
  expect(status?.scope).toBe("custom");
  expect(status?.otherCheckouts).toEqual(["/wt/api"]);
  expect(projectStatus(root, emptyVault)?.scope).toBe("api");
  expect(projectStatus(root, emptyVault)?.otherCheckouts).toEqual([]);
});
```

In `packages/cli/test/doctor-checks.test.ts`, add `otherCheckouts: []` to `passingProject`, then append:

```ts
test("Checkouts: named when other checkouts of the scope exist, absent otherwise", () => {
  const checks = gatherChecks(allPassFacts({ project: { ...passingProject, otherCheckouts: ["/wt/api", "/b/api"] } }));
  expect(checks.find((c) => c.label === "Checkouts")).toEqual({
    group: "project",
    status: "info",
    label: "Checkouts",
    detail: "Also checked out at /wt/api, /b/api",
  });
  expect(gatherChecks(allPassFacts()).some((c) => c.label === "Checkouts")).toBe(false);
});
```

Run: `bun test packages/cli/test/init-status.test.ts packages/cli/test/doctor-checks.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement**

In `packages/cli/src/init/status.ts`: import `canonicalRoot, projectForRoot` from `../vault/projects` and `type ProjectRecord` from `../vault/store`. Add to `ProjectStatus`:

```ts
  /** Other registered checkouts of this scope, by root (checkouts spec §6.4). */
  otherCheckouts: string[];
```

Change the signature to `vault: { getSecret(ref: SecretRef): string | null; listProjects?(): ProjectRecord[] }` and the scope block to:

```ts
  // The scope `init` registered for this folder wins: a checkout set up with
  // --scope custom is `custom`, which the package name cannot say.
  const projects = vault.listProjects?.() ?? [];
  const recorded = projectForRoot(projects, detected.root);
  let scope: string | null = recorded?.name ?? null;
  if (scope === null) {
    try {
      scope = deriveScope({ packageName: detected.packageName, rootPath: detected.root }).scope;
    } catch {
      scope = null;
    }
  }
  const here = canonicalRoot(detected.root);
  const otherCheckouts =
    scope === null ? [] : projects.filter((p) => p.name === scope && canonicalRoot(p.rootPath) !== here).map((p) => p.rootPath);
```

and add `otherCheckouts,` to the returned object. `doctor.ts` passes `ctx.vault`, which has `listProjects`, so it needs no change.

In `packages/cli/src/doctor/checks.ts`, add:

```ts
/** Checkouts spec §6.4: a fact, not a problem. */
function checkoutsCheck(project: ProjectStatus): Check | null {
  if (project.otherCheckouts.length === 0) return null;
  return {
    group: "project",
    status: "info",
    label: "Checkouts",
    detail: `Also checked out at ${project.otherCheckouts.join(", ")}`,
  };
}
```

and in `gatherChecks`, after `checks.push(referencesCheck(facts.project, facts.cli));`:

```ts
    const checkouts = checkoutsCheck(facts.project);
    if (checkouts) checks.push(checkouts);
```

- [ ] **Step 3: Run the tests and the suite**

Run: `bun test packages/cli/test/init-status.test.ts packages/cli/test/doctor-checks.test.ts` then `bun run typecheck && bun run test`
Expected: PASS. Any other `ProjectStatus` literal in tests needs `otherCheckouts: []`.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/init/status.ts packages/cli/src/doctor/checks.ts packages/cli/test/init-status.test.ts packages/cli/test/doctor-checks.test.ts
git commit -m "feat(doctor): name the registered scope and the other checkouts"
```

---

### Task 7: `uninstall` restores every checkout; docs, changelog, roadmap

**Files:**
- Test: `packages/cli/test/uninstall-plan.test.ts`
- Modify: `apps/website/src/pages/docs/cli.md` (the `kerstel init`, `kerstel move`, and `kerstel uninstall` rows), `CHANGELOG.md`, `ROADMAP.md`, `README.md` only if its wording says a project is one folder, and `docs/` (rebuilt)

- [ ] **Step 1: Two-checkout uninstall tests**

Read the top of `packages/cli/test/uninstall-plan.test.ts` for its helpers (it registers with `v.registerProject("demo-app", root)` and builds project trees). Add, using those helpers:

```ts
test("both checkouts of one package are restored", () => {
  // Two project trees with the same package.json name, each with
  // `.env` = "API_TOKEN=kerstel://demo-app/API_TOKEN\n", both registered:
  //   v.registerProject("demo-app", main, "demo-app");
  //   v.registerProject("demo-app", worktree, "demo-app");
  //   v.setSecret({ scope: "demo-app", key: "API_TOKEN" }, "tok-aaaa-1111");
  // planUninstall(v, dataKey): both roots appear in the planned env writes,
  // each restoring API_TOKEN, and plan.unreachable is empty.
});

test("a checkout whose folder is gone is reported while the other is restored", () => {
  // As above, then rmSync(worktree, { recursive: true, force: true }).
  // plan.unreachable is [{ name: "demo-app", rootPath: worktree, reason: "the folder no longer exists" }]
  // and main's .env is still planned.
});
```

Write the bodies with the file's existing helpers and plan field names (read `UninstallPlan` in `packages/cli/src/uninstall/plan.ts` for the field that lists env writes). Assert on file paths and key names only, never on the value.

Run: `bun test packages/cli/test/uninstall-plan.test.ts` — Expected: PASS without source changes (uninstall already loops every row). If it fails, stop and report: the spec assumes no uninstall change.

- [ ] **Step 2: Docs**

In `apps/website/src/pages/docs/cli.md`:
- `kerstel init` row: add, in the row's own style: "Each folder is registered on its own, so a second checkout of the same package (a git worktree) keeps the first one's registration and reuses its secrets. A value the vault already holds, for this project or shared, becomes a reference without being stored again; when it differs, init asks which one stays (the vault's, by default, and under `--yes`). If the derived scope already belongs to a different package, init stops and names it; re-run with `--scope <name>`, or pass that package's scope with `--scope` to share it on purpose. A re-run in a registered folder keeps the scope it was registered under."
- `kerstel move` row: replace "A project copy left unused is removed from the vault and saved in the backup" with "A project copy that neither this checkout nor any other registered checkout of the project still reads is removed from the vault and saved in the backup".
- `kerstel uninstall` row: after "For every project `init` set up," say "and every checkout of it,".

Check each sentence against the code from Tasks 3–5 (the messages and defaults), per `AGENTS.md`.

`CHANGELOG.md`, under `## 0.1.5 (unreleased)` (add a `### Fixed` heading):

```markdown
### Fixed

- Two checkouts of one package, such as git worktrees, are now registered separately. Running `init` in the second no longer replaces the first, a value the vault already holds is reused rather than stored again, and `kerstel uninstall` restores both. `ks move` keeps a project copy while any registered checkout still reads it. If a different package already uses the scope `init` would derive, `init` stops and names that package instead of sharing its secrets by accident.
```

`ROADMAP.md` line 39: change `- [ ]` to `- [x]` for "Track each checkout of a project separately".

`README.md`: `grep -n "checkout\|register" README.md`; change only a sentence that would now be false.

- [ ] **Step 3: Rebuild the site and run everything**

```bash
bun run --cwd apps/website build
bun run typecheck && bun run test
git status --short docs/
```

Expected: PASS, and `docs/` shows the regenerated changelog, roadmap, and CLI pages.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/test/uninstall-plan.test.ts apps/website/src/pages/docs/cli.md CHANGELOG.md ROADMAP.md README.md docs/
git commit -m "docs: describe per-checkout registration"
```

---

## After the tasks

Push `feat/checkouts`, open the PR titled `feat: track each checkout of a project separately` with `Closes #13` in the body, then run `/code-review` on it and fix confirmed findings before handing it over.
