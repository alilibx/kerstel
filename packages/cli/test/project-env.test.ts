import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ignoreProjectSettings, projectSettings } from "../src/project-env";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-projenv-"));
  created.push(root);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  return root;
}

test("a KERSTEL_* the project's .env defines, and that Bun loaded, is reported", () => {
  const root = project({
    ".env": [
      "KERSTEL_HOME=./.kerstel-local",
      "KERSTEL_KEYCHAIN_BACKEND=file",
      "KERSTEL_IDLE_MS=9999999999",
      "DATABASE_URL=kerstel://app/DATABASE_URL",
      "",
    ].join("\n"),
  });

  // What Bun's autoload leaves behind: the file's values in process.env.
  const loaded = {
    KERSTEL_HOME: "./.kerstel-local",
    KERSTEL_KEYCHAIN_BACKEND: "file",
    KERSTEL_IDLE_MS: "9999999999",
    DATABASE_URL: "kerstel://app/DATABASE_URL",
  };

  const ignored = projectSettings(root, loaded);
  expect(ignored.map((s) => s.name).sort()).toEqual([
    "KERSTEL_HOME",
    "KERSTEL_IDLE_MS",
    "KERSTEL_KEYCHAIN_BACKEND",
  ]);
  // The project's own variables are none of this module's business.
  expect(ignored.map((s) => s.name)).not.toContain("DATABASE_URL");
  expect(ignored[0]?.file).toBe(".env");
});

test("a KERSTEL_* the file names is dropped whatever its value, and one it does not name is kept", () => {
  const root = project({ ".env": "KERSTEL_HOME=./.kerstel-local\n" });
  // Named, so dropped even though the value is the user's own: the two cannot
  // be told apart, and honouring the repository's choice is the one outcome
  // that must not happen. See project-env.ts.
  expect(projectSettings(root, { KERSTEL_HOME: "/Users/ada/.kerstel" })).toEqual([
    { name: "KERSTEL_HOME", file: ".env" },
  ]);
  // Not named, so untouched.
  expect(projectSettings(root, { KERSTEL_IDLE_MS: "60000" })).toEqual([]);
});

test("a KERSTEL_* named in a variant file is caught too, and named by its file", () => {
  const root = project({
    ".env": "APP=1\n",
    ".env.local": "KERSTEL_RELEASES_URL=http://127.0.0.1:9\n",
  });
  const ignored = projectSettings(root, { KERSTEL_RELEASES_URL: "http://127.0.0.1:9" });
  expect(ignored).toEqual([{ name: "KERSTEL_RELEASES_URL", file: ".env.local" }]);
});

test("a template or a backup copy is not a source", () => {
  const root = project({
    ".env.example": "KERSTEL_HOME=./from-template\n",
    ".env.bak": "KERSTEL_HOME=./from-backup\n",
  });
  expect(projectSettings(root, { KERSTEL_HOME: "./from-template" })).toEqual([]);
  expect(projectSettings(root, { KERSTEL_HOME: "./from-backup" })).toEqual([]);
});

test("a repeated key is caught by its last assignment, not a harmless decoy", () => {
  // A loader takes the last one, so comparing only the first would let the
  // real injection through.
  const root = project({ ".env": "KERSTEL_HOME=/harmless\nKERSTEL_HOME=/tmp/attacker\n" });
  expect(projectSettings(root, { KERSTEL_HOME: "/tmp/attacker" })).toEqual([
    { name: "KERSTEL_HOME", file: ".env" },
  ]);
});

test("a value the parser and the loader read differently is still caught", () => {
  // Every gap between Bun's parser and this repo's is a smuggling route, so
  // the check must not depend on them agreeing. Bun expands `$ATTACK` and
  // decodes `\\r` (both verified on 1.4.2); parseDotenv does neither.
  const root = project({
    ".env": ["ATTACK=9999999999", "KERSTEL_IDLE_MS=$ATTACK", String.raw`KERSTEL_HOME="/tmp/evil\r"`, ""].join("\n"),
  });
  const ignored = projectSettings(root, { KERSTEL_IDLE_MS: "9999999999", KERSTEL_HOME: "/tmp/evil\r" });
  expect(ignored.map((s) => s.name).sort()).toEqual(["KERSTEL_HOME", "KERSTEL_IDLE_MS"]);
});

test("a project with no env files reports nothing", () => {
  expect(projectSettings(project({ "package.json": "{}" }), { KERSTEL_HOME: "/x" })).toEqual([]);
});

test("ignoreProjectSettings deletes them from process.env", () => {
  const root = project({ ".env": "KERSTEL_IDLE_MS=9999999999\n" });
  const original = process.env.KERSTEL_IDLE_MS;
  process.env.KERSTEL_IDLE_MS = "9999999999";
  try {
    expect(ignoreProjectSettings(root).map((s) => s.name)).toEqual(["KERSTEL_IDLE_MS"]);
    expect(process.env.KERSTEL_IDLE_MS).toBeUndefined();
  } finally {
    if (original === undefined) delete process.env.KERSTEL_IDLE_MS;
    else process.env.KERSTEL_IDLE_MS = original;
  }
});
