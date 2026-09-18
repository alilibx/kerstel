import { expect, test } from "bun:test";
import { deriveScope, slugifyScope } from "../src/init/project-name";
import { isValidScope } from "../src/reference";

const CASES: [input: string, expected: string][] = [
  ["kerstel", "kerstel"],
  ["@acme/web", "web"],
  ["@acme/My_App", "my_app"],
  ["My App!!", "my-app"],
  ["---weird---", "weird"],
  [".hidden.", "hidden"],
  ["_leading_underscore", "leading_underscore"],
  ["a//b", "a-b"],
  ["Über Projekt", "ber-projekt"],
  ["123", "123"],
  ["next.js-app", "next.js-app"],
  ["  spaced  ", "spaced"],
];

test("slugifyScope produces valid scopes", () => {
  for (const [input, expected] of CASES) {
    expect(slugifyScope(input)).toBe(expected);
    expect(isValidScope(expected)).toBe(true);
  }
});

test("slugifyScope truncates to the 64-character scope limit", () => {
  const slug = slugifyScope("x".repeat(200));
  expect(slug.length).toBe(64);
  expect(isValidScope(slug)).toBe(true);
});

test("slugifyScope returns an empty string when nothing usable is left", () => {
  expect(slugifyScope("///")).toBe("");
  expect(slugifyScope("")).toBe("");
});

test("deriveScope prefers the package.json name", () => {
  expect(deriveScope({ packageName: "@acme/web", rootPath: "/tmp/some-dir" })).toEqual({
    scope: "web",
    source: "package.json",
  });
});

test("deriveScope falls back to the directory basename", () => {
  expect(deriveScope({ packageName: null, rootPath: "/tmp/My Project" })).toEqual({
    scope: "my-project",
    source: "directory",
  });
  expect(deriveScope({ packageName: "@acme/", rootPath: "/tmp/fallback-dir" })).toEqual({
    scope: "fallback-dir",
    source: "directory",
  });
});

test("deriveScope throws when neither candidate is usable", () => {
  expect(() => deriveScope({ packageName: null, rootPath: "/" })).toThrow(/--scope/);
});
