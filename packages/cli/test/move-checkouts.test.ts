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
  const a = checkout({ ".env": "K=ks:app\nP=plain\n" });
  const b = checkout({ ".env.local": "K=ks:app\nG=ks:global\n" });
  const refs = referencesInCheckouts([a, b]);
  expect(refs.get("ks:app/K")).toBe(a);
  expect(refs.get("ks:global/G")).toBe(b);
  expect(refs.has("ks:app/P")).toBe(false);
});

test("a checkout whose folder is gone reads nothing", () => {
  expect(referencesInCheckouts(["/nowhere/at/all"]).size).toBe(0);
});
