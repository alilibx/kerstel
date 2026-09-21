import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doctorCommand } from "../src/commands/doctor";
import { projectStatus } from "../src/init/status";
import { runCli } from "../src/index";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

const tempDirs: string[] = [];

afterEach(() => {
  restoreEnv();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-status-"));
  tempDirs.push(root);
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(join(root, dirname(name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  return root;
}

const emptyVault = { getSecret: () => null };

test("projectStatus returns null outside a project", () => {
  const root = makeProject({ ".env": "A=1\n" });
  expect(projectStatus(root, emptyVault)).toBeNull();
});

test("projectStatus reports a kerstel planted in node_modules/.bin", () => {
  const root = makeProject({ "package.json": '{ "name": "shadowed" }', ".env": "A=1\n" });
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".bin", "kerstel"), "#!/bin/sh\n");
  const status = projectStatus(root, emptyVault);
  expect(status?.shadowed).toEqual([join(root, "node_modules", ".bin", "kerstel")]);

  const clean = makeProject({ "package.json": '{ "name": "clean" }', ".env": "A=1\n" });
  expect(projectStatus(clean, emptyVault)?.shadowed).toEqual([]);
});

test("projectStatus returns null against a malformed package.json", () => {
  const root = makeProject({
    "package.json": '{ "name": "broken",',
    ".env": "A=1\n",
  });
  expect(projectStatus(root, emptyVault)).toBeNull();
});

test("doctor exits 0 against a malformed package.json", async () => {
  isolateEnv({ prefix: "status-doctor-broken" });
  const root = makeProject({
    "package.json": '{ "name": "broken",',
    ".env": "A=1\n",
  });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await doctorCommand([], root)).toBe(0);
  } finally {
    console.log = realLog;
  }
  expect(captured.join("\n")).not.toContain("This project");
});

test("projectStatus reports an unwired project", () => {
  const root = makeProject({
    "package.json": '{\n  "name": "@acme/site",\n  "scripts": {\n    "dev": "next dev",\n    "postinstall": "x"\n  }\n}\n',
    ".env": "A=plain\n",
  });
  const status = projectStatus(root, emptyVault);
  expect(status?.scope).toBe("site");
  expect(status?.runtime).toBe("node");
  expect(status?.scripts).toEqual({ wrappable: 1, wired: 0, oldForm: [], partlyWired: [], skipped: [] });
  expect(status?.references).toEqual({ total: 0, resolvable: 0, unresolved: [] });
  expect(status?.envFiles).toEqual([".env"]);
});

test("projectStatus reports a wired project and which references resolve", async () => {
  isolateEnv({ prefix: "status-wired" });
  await runCli(["set", "site/PRESENT", "--value", "here"]);

  const root = makeProject({
    "package.json": '{\n  "name": "site",\n  "scripts": {\n    "dev": "node .kerstel/exec.cjs -- next dev"\n  }\n}\n',
    ".env": "PRESENT=kerstel://site/PRESENT\nMISSING=kerstel://site/MISSING\nPLAIN=still-plain\n",
  });

  const { key } = await loadOrCreateDataKey();
  const vault = openVault(key);
  try {
    const status = projectStatus(root, vault);
    expect(status?.scripts).toEqual({ wrappable: 1, wired: 1, oldForm: [], partlyWired: [], skipped: [] });
    expect(status?.references.total).toBe(2);
    expect(status?.references.resolvable).toBe(1);
    expect(status?.references.unresolved).toEqual(["kerstel://site/MISSING"]);
  } finally {
    vault.close();
  }
});

test("doctor prints the project section when run inside a project", async () => {
  isolateEnv({ prefix: "status-doctor" });
  const root = makeProject({
    "package.json": '{\n  "name": "site",\n  "scripts": {\n    "dev": "node .kerstel/exec.cjs -- next dev"\n  }\n}\n',
    ".env": "PRESENT=kerstel://site/PRESENT\n",
  });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    // The reference is never `set`, so it can't resolve -- References is a
    // problem, and a problem exits 1.
    expect(await doctorCommand([], root)).toBe(1);
  } finally {
    console.log = realLog;
  }

  const out = captured.join("\n");
  expect(out).toContain("This project");
  expect(out).toContain("site");
  expect(out).toContain("1 of 1 go through Kerstel");
  expect(out).toContain("1 of 1 can't be found: kerstel://site/PRESENT");
});

test("doctor outside a project prints no project section", async () => {
  isolateEnv({ prefix: "status-doctor-none" });
  const root = makeProject({ ".env": "A=1\n" });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await doctorCommand([], root)).toBe(0);
  } finally {
    console.log = realLog;
  }
  expect(captured.join("\n")).not.toContain("This project");
});

/**
 * A `.env` the process cannot read. A DANGLING SYMLINK cannot stand in for
 * this: `discoverEnvFiles` stats every candidate and drops the ones that do
 * not resolve to a file, so a broken link never reaches the reader at all.
 * Mode 000 is the case that does -- stat succeeds, open does not.
 *
 * Skipped when running as root, for whom mode 000 is still readable.
 */
const asRoot = process.getuid?.() === 0;

test.skipIf(asRoot)("projectStatus reports an unreadable env file instead of throwing", () => {
  const root = makeProject({
    "package.json": '{\n  "name": "site"\n}\n',
    ".env": "PRESENT=kerstel://site/PRESENT\n",
    ".env.production": "LOCKED=kerstel://site/LOCKED\n",
  });
  chmodSync(join(root, ".env.production"), 0o000);

  const status = projectStatus(root, emptyVault);
  expect(status?.unreadable).toEqual([".env.production"]);
  // The readable file is still read.
  expect(status?.references.total).toBe(1);
});

test.skipIf(asRoot)("doctor exits 0 and names an env file it could not read", async () => {
  isolateEnv({ prefix: "status-doctor-unreadable" });
  // The point of this test is the unreadable file, not an unresolved
  // reference -- give PRESENT a value so References itself stays a pass.
  await runCli(["set", "site/PRESENT", "--value", "x"]);
  const root = makeProject({
    "package.json": '{\n  "name": "site"\n}\n',
    ".env": "PRESENT=kerstel://site/PRESENT\n",
    ".env.production": "LOCKED=kerstel://site/LOCKED\n",
  });
  chmodSync(join(root, ".env.production"), 0o000);

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await doctorCommand([], root)).toBe(0);
  } finally {
    console.log = realLog;
  }
  expect(captured.join("\n")).toContain(".env.production");
});

test("projectStatus names half-wired scripts and the ones the wirer refuses", () => {
  const root = makeProject({
    "package.json":
      '{\n  "name": "site",\n  "scripts": {\n    "dev": "node .kerstel/exec.cjs -- node a.js && next dev",\n    "build": "node .kerstel/exec.cjs -- next build",\n    "postbuild": "cd out && node fix.js",\n    "clean": "rm -rf dist"\n  }\n}\n',
    ".env": "A=plain\n",
  });
  const status = projectStatus(root, emptyVault);
  expect(status?.scripts).toEqual({
    wrappable: 2,
    wired: 1,
    oldForm: [], partlyWired: ["dev"],
    skipped: [
      { name: "postbuild", reason: "changes-directory" },
      { name: "clean", reason: "nothing-to-wire" },
    ],
  });
});

test("projectStatus names old-form scripts and reports the launcher", () => {
  const root = makeProject({
    "package.json":
      '{\n  "name": "site",\n  "scripts": {\n    "dev": "kerstel exec -- next dev",\n    "build": "node .kerstel/exec.cjs -- next build"\n  }\n}\n',
    ".env": "A=plain\n",
  });
  const status = projectStatus(root, emptyVault);
  expect(status?.scripts).toEqual({ wrappable: 2, wired: 1, oldForm: ["dev"], partlyWired: [], skipped: [] });
  expect(status?.launcher).toEqual({ kind: "missing" });

  const unwired = makeProject({
    "package.json": '{\n  "name": "site",\n  "scripts": {\n    "dev": "next dev"\n  }\n}\n',
    ".env": "A=plain\n",
  });
  expect(projectStatus(unwired, emptyVault)?.launcher).toBeNull();
});
