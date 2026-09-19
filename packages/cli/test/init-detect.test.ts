import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPackageManager,
  detectProject,
  discoverEnvFiles,
  envFileRank,
  isBackupEnvFileName,
  isEnvFileName,
} from "../src/init/detect";

const createdRoots: string[] = [];

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-detect-"));
  createdRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return root;
}

test("isEnvFileName accepts .env and its variants and rejects templates", () => {
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    expect(isEnvFileName(name)).toBe(true);
  }
  for (const name of [
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
    ".environment",
    "env",
    ".envrc",
    "package.json",
  ]) {
    expect(isEnvFileName(name)).toBe(false);
  }
});

test("editor and shell backup copies are not env files", () => {
  for (const name of [
    ".env.bak",
    ".env.orig",
    ".env.old",
    ".env.save",
    ".env.backup",
    ".env.swp",
    ".env.swo",
    ".env.tmp",
    ".env.rej",
    ".env.local.bak",
    ".env.production.swp",
    ".env~",
    ".env.local~",
    ".env.bak.local",
  ]) {
    expect(isEnvFileName(name)).toBe(false);
    expect(isBackupEnvFileName(name)).toBe(true);
  }
  for (const name of [
    ".env",
    ".env.local",
    ".env.production.local",
    ".env.example",
    ".envrc",
    ".envrc~",
    ".environment~",
    ".env.~",
    "notes.bak",
    "~",
  ]) {
    expect(isBackupEnvFileName(name)).toBe(false);
  }
});

test("a backup copy is skipped, reported by name, and never outranks the live file", () => {
  const root = project({
    ".env": "API_TOKEN=live\n",
    ".env.bak": "API_TOKEN=stale\n",
    ".env.swp": "garbage",
    ".env.example": "API_TOKEN=\n",
    "package.json": "{}",
  });
  const detected = detectProject(root);
  expect(detected.envFiles.map((f) => f.name)).toEqual([".env"]);
  expect(detected.backupEnvFiles).toEqual([".env.bak", ".env.swp"]);
  expect(discoverEnvFiles(root).map((f) => f.name)).toEqual([".env"]);
});

test("a directory with a backup-like name is not reported as a backup", () => {
  const root = project({ ".env": "A=1" });
  mkdirSync(join(root, ".env.old"));
  expect(detectProject(root).backupEnvFiles).toEqual([]);
});

test("envFileRank implements the documented precedence", () => {
  expect(envFileRank(".env.production.local")).toBeGreaterThan(envFileRank(".env.local"));
  expect(envFileRank(".env.local")).toBeGreaterThan(envFileRank(".env.production"));
  expect(envFileRank(".env.production")).toBeGreaterThan(envFileRank(".env"));
});

test("discoverEnvFiles returns the highest-precedence file first", () => {
  const root = project({
    ".env": "A=1",
    ".env.local": "A=2",
    ".env.production": "A=3",
    ".env.production.local": "A=4",
    ".env.example": "A=",
    "package.json": "{}",
  });
  expect(discoverEnvFiles(root).map((f) => f.name)).toEqual([
    ".env.production.local",
    ".env.local",
    ".env.production",
    ".env",
  ]);
});

test("discoverEnvFiles ignores directories named like env files", () => {
  const root = project({ ".env": "A=1" });
  mkdirSync(join(root, ".env.d"));
  expect(discoverEnvFiles(root).map((f) => f.name)).toEqual([".env"]);
});

test("discoverEnvFiles returns nothing for a project without env files", () => {
  expect(discoverEnvFiles(project({ "package.json": "{}" }))).toEqual([]);
});

test("lockfiles decide the package manager, in the documented order", () => {
  expect(detectPackageManager(project({ "bun.lock": "" }), null)).toBe("bun");
  expect(detectPackageManager(project({ "bun.lockb": "" }), null)).toBe("bun");
  expect(detectPackageManager(project({ "pnpm-lock.yaml": "" }), null)).toBe("pnpm");
  expect(detectPackageManager(project({ "yarn.lock": "" }), null)).toBe("yarn");
  expect(detectPackageManager(project({ "package-lock.json": "" }), null)).toBe("npm");
  // Bun wins when a repo carries more than one lockfile.
  expect(detectPackageManager(project({ "bun.lock": "", "package-lock.json": "" }), null)).toBe("bun");
});

test("the packageManager field decides when no lockfile does", () => {
  const root = project({ "package.json": "{}" });
  expect(detectPackageManager(root, { packageManager: "pnpm@9.1.0" })).toBe("pnpm");
  expect(detectPackageManager(root, { packageManager: "yarn@4.2.2" })).toBe("yarn");
  expect(detectPackageManager(root, { packageManager: "bun@1.1.0" })).toBe("bun");
  expect(detectPackageManager(root, { packageManager: "who-knows@1" })).toBe("npm");
  expect(detectPackageManager(root, null)).toBe("npm");
});

test("detectProject reads the package name and maps bun to the bun runtime", () => {
  const root = project({
    "package.json": JSON.stringify({ name: "@acme/web", scripts: { dev: "vite" } }),
    "bun.lock": "",
    ".env": "A=1",
  });
  const detected = detectProject(root);
  expect(detected.root).toBe(root);
  expect(detected.packageName).toBe("@acme/web");
  expect(detected.packageManager).toBe("bun");
  expect(detected.runtime).toBe("bun");
  expect(detected.envFiles.map((f) => f.name)).toEqual([".env"]);
  expect(detected.packageJsonPath).toBe(join(root, "package.json"));
});

test("detectProject reports a missing or unreadable package.json as null", () => {
  expect(detectProject(project({ ".env": "A=1" })).packageJson).toBeNull();
  expect(detectProject(project({ "package.json": "{ not json" })).packageJson).toBeNull();
});

test("a non-bun project is a node project", () => {
  const root = project({ "package.json": JSON.stringify({ name: "web" }), "pnpm-lock.yaml": "" });
  const detected = detectProject(root);
  expect(detected.packageManager).toBe("pnpm");
  expect(detected.runtime).toBe("node");
});

test("a template with a .local suffix is still a template", () => {
  expect(isEnvFileName(".env.example.local")).toBe(false);
  expect(isEnvFileName(".env.sample.local")).toBe(false);
  expect(isEnvFileName(".env.production.local")).toBe(true);
});

test("a dangling .env symlink is reported, not silently dropped", () => {
  const root = project({ ".env": "A=1\n" });
  symlinkSync(join(root, "missing-target"), join(root, ".env.local"));
  const detected = detectProject(root);
  expect(detected.envFiles.map((f) => f.name)).toEqual([".env"]);
  expect(detected.unreadableEnvFiles).toEqual([".env.local"]);
});

test("a malformed package.json is told apart from a missing one", () => {
  expect(detectProject(project({ "package.json": "{ not json" })).packageJsonError).toBe("invalid");
  expect(detectProject(project({})).packageJsonError).toBe("missing");
  expect(detectProject(project({ "package.json": "{}" })).packageJsonError).toBeNull();
});

test.each([
  [{ dependencies: { next: "15" } }, "Next.js"],
  [{ devDependencies: { vite: "5", "@sveltejs/kit": "2" } }, "SvelteKit"],
  [{ dependencies: { "@remix-run/node": "2" } }, "Remix"],
  [{ dependencies: { express: "4" } }, null],
])("detects the framework from package.json %#", (deps, framework) => {
  const root = project({ "package.json": JSON.stringify({ name: "x", ...deps }) });
  expect(detectProject(root).framework).toBe(framework);
});
