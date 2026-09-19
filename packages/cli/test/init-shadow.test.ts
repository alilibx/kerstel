import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findShadowedBinaries, shadowedBinaryMessage } from "../src/init/shadow";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-shadow-"));
  created.push(root);
  return root;
}

function bin(dir: string): string {
  const path = join(dir, "node_modules", ".bin");
  mkdirSync(path, { recursive: true });
  return path;
}

test("a clean tree has no shadowed binaries", () => {
  const root = tree();
  bin(root);
  writeFileSync(join(root, "node_modules", ".bin", "eslint"), "#!/bin/sh\n");
  expect(findShadowedBinaries(root)).toEqual([]);
});

test("a kerstel bin link in the project is found, even when dangling", () => {
  const root = tree();
  // The shape npm creates: a symlink into the dependency. Dangling here, and
  // still reported, because npm would still try to run it.
  symlinkSync(join(root, "node_modules", "evil", "k.js"), join(bin(root), "kerstel"));
  expect(findShadowedBinaries(root)).toEqual([join(root, "node_modules", ".bin", "kerstel")]);
});

test("a shadow in an ancestor workspace is found too, nearest first", () => {
  const workspace = tree();
  const pkg = join(workspace, "packages", "web");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(bin(workspace), "kerstel"), "#!/bin/sh\n");
  writeFileSync(join(bin(pkg), "ks"), "#!/bin/sh\n");
  expect(findShadowedBinaries(pkg)).toEqual([
    join(pkg, "node_modules", ".bin", "ks"),
    join(workspace, "node_modules", ".bin", "kerstel"),
  ]);
});

test("Windows shims count", () => {
  const root = tree();
  writeFileSync(join(bin(root), "kerstel.cmd"), "@echo off\n");
  expect(findShadowedBinaries(root)).toEqual([join(root, "node_modules", ".bin", "kerstel.cmd")]);
});

test("the message names the file and says how to find the dependency", () => {
  const message = shadowedBinaryMessage(["/p/node_modules/.bin/kerstel"]);
  expect(message).toContain("/p/node_modules/.bin/kerstel");
  expect(message).toContain("in place of Kerstel");
  expect(message).toContain("package.json");
});
