import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitFileStatus } from "../src/move/git";

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

test("tracked, ignored and untracked-unignored files are told apart", () => {
  const root = mkdtempSync(join(tmpdir(), "kerstel-move-git-"));
  createdDirs.push(root);
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitignore"), ".env.local\n");
  writeFileSync(join(root, ".env"), "A=1\n");
  writeFileSync(join(root, ".env.local"), "A=2\n");
  writeFileSync(join(root, ".env.development"), "A=3\n");
  git(root, "add", ".env", ".gitignore");

  expect(gitFileStatus(root, ".env")).toBe("tracked");
  expect(gitFileStatus(root, ".env.local")).toBe("ignored");
  expect(gitFileStatus(root, ".env.development")).toBe("not-ignored");
});

test("outside a repository there is no status", () => {
  const root = mkdtempSync(join(tmpdir(), "kerstel-move-nogit-"));
  createdDirs.push(root);
  writeFileSync(join(root, ".env"), "A=1\n");
  // GIT_CEILING_DIRECTORIES is not needed: tmpdir() is not inside a repository.
  expect(gitFileStatus(root, ".env")).toBeNull();
});
