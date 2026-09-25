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

test("scopeCollisionMessage takes a custom remedy in place of the --scope one", () => {
  expect(
    scopeCollisionMessage(
      "api",
      { packageName: "@acme/api", root: "/acme/api" },
      "Run kerstel init --scope <name> here to give this package its own.",
    ),
  ).toBe(
    'The scope "api" belongs to @acme/api at /acme/api. Run kerstel init --scope <name> here to give this package its own.',
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
