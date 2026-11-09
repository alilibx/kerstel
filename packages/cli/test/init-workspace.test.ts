import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { detectWorkspace, parsePnpmPackages } from "../src/init/workspace";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A temp tree from `{ "path/file": "contents" }`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-workspace-"));
  dirs.push(root);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

const pkg = (extra: object = {}) => JSON.stringify({ name: "x", ...extra });

test("the workspaces array finds members, skipping node_modules and dot folders", () => {
  const root = tree({
    "package.json": pkg({ workspaces: ["apps/*", "packages/**"] }),
    "apps/web/package.json": pkg(),
    "apps/web/.env": "A=1\n",
    "apps/api/package.json": pkg(),
    "packages/db/package.json": pkg(),
    "packages/db/node_modules/dep/package.json": pkg(),
    "packages/.hidden/package.json": pkg(),
    "apps/notes/README.md": "not a package",
  });
  const ws = detectWorkspace(root)!;
  expect(ws.source).toBe("package.json");
  expect(ws.members.map((m) => relative(root, m))).toEqual(["apps/api", "apps/web", "packages/db"]);
  // Only packages with env files are set up.
  expect(ws.packages.map((p) => relative(root, p.root))).toEqual(["apps/web"]);
});

test("a ** glob finds nested members without entering node_modules or dot folders", () => {
  const root = tree({
    "package.json": pkg({ workspaces: ["packages/**", "./tools/*/"] }),
    "packages/group/a/package.json": pkg(),
    "packages/b/package.json": pkg(),
    "packages/b/node_modules/c/package.json": pkg(),
    "packages/.cache/d/package.json": pkg(),
    "tools/cli/package.json": pkg(),
    "tools/cli/deep/package.json": pkg(),
  });
  expect(detectWorkspace(root)!.members.map((m) => relative(root, m))).toEqual([
    "packages/b",
    "packages/group/a",
    "tools/cli",
  ]);
});

test("the object form, a negation, and a root with env files of its own", () => {
  const root = tree({
    "package.json": pkg({ workspaces: { packages: ["apps/*", "!apps/legacy"] } }),
    ".env": "A=1\n",
    "apps/web/package.json": pkg(),
    "apps/web/.env": "A=1\n",
    "apps/legacy/package.json": pkg(),
    "apps/legacy/.env": "A=1\n",
  });
  const ws = detectWorkspace(root)!;
  expect(ws.members.map((m) => relative(root, m))).toEqual(["apps/web"]);
  expect(ws.packages.map((p) => relative(root, p.root) || "(root)")).toEqual(["(root)", "apps/web"]);
});

test("pnpm-workspace.yaml with plain and quoted entries", () => {
  const root = tree({
    "package.json": pkg(),
    "pnpm-workspace.yaml": "# monorepo\npackages:\n  - apps/*\n  - 'tools/*' # comment\n  - \"!tools/old\"\n\ncatalog:\n  react: ^19\n",
    "apps/web/package.json": pkg(),
    "tools/cli/package.json": pkg(),
    "tools/old/package.json": pkg(),
  });
  const ws = detectWorkspace(root)!;
  expect(ws.source).toBe("pnpm-workspace.yaml");
  expect(ws.members.map((m) => relative(root, m))).toEqual(["apps/web", "tools/cli"]);
});

test("a pnpm-workspace.yaml this cannot read warns and is no workspace", () => {
  const root = tree({ "package.json": pkg(), "pnpm-workspace.yaml": "packages: [apps/*]\n" });
  const warnings: string[] = [];
  expect(detectWorkspace(root, (w) => warnings.push(w))).toBeNull();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("pnpm-workspace.yaml");
});

test("parsePnpmPackages accepts only a block sequence of strings", () => {
  expect(parsePnpmPackages("packages:\n  - a/*\n  - 'b'\n")).toEqual(["a/*", "b"]);
  expect(parsePnpmPackages("catalog:\n  x: 1\n")).toEqual([]);
  expect(parsePnpmPackages("packages: [a]\n")).toBeNull();
  expect(parsePnpmPackages("packages:\n  key: value\n")).toBeNull();
  expect(parsePnpmPackages("packages:\n  - &anchor a\n")).toBeNull();
});

test("a plain package or a folder without package.json is no workspace", () => {
  expect(detectWorkspace(tree({ "package.json": pkg() }))).toBeNull();
  expect(detectWorkspace(tree({ "pnpm-workspace.yaml": "packages:\n  - a\n" }))).toBeNull();
});

test("globs that match nothing give an empty workspace, not a lone project", () => {
  const ws = detectWorkspace(tree({ "package.json": pkg({ workspaces: ["apps/*"] }) }))!;
  expect(ws.members).toEqual([]);
  expect(ws.packages).toEqual([]);
});
