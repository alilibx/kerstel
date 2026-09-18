import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorCommand } from "../src/commands/doctor";
import { projectStatus } from "../src/init/status";
import { runCli } from "../src/index";
import { hookDir } from "../src/paths";
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
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  return root;
}

const emptyVault = { getSecret: () => null };

test("projectStatus returns null outside a project", () => {
  const root = makeProject({ ".env": "A=1\n" });
  expect(projectStatus(root, emptyVault, "/hook")).toBeNull();
});

test("projectStatus returns null against a malformed package.json", () => {
  const root = makeProject({
    "package.json": '{ "name": "broken",',
    ".env": "A=1\n",
  });
  expect(projectStatus(root, emptyVault, "/hook")).toBeNull();
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
    expect(await doctorCommand(root)).toBe(0);
  } finally {
    console.log = realLog;
  }
  expect(captured.join("\n")).not.toContain("Project");
});

test("projectStatus reports an unwired project", () => {
  const root = makeProject({
    "package.json": '{\n  "name": "@acme/site",\n  "scripts": {\n    "dev": "next dev",\n    "postinstall": "x"\n  }\n}\n',
    ".env": "A=plain\n",
  });
  const status = projectStatus(root, emptyVault, "/hook");
  expect(status?.scope).toBe("site");
  expect(status?.runtime).toBe("node");
  expect(status?.scripts).toEqual({ wrappable: 1, wired: 0 });
  expect(status?.bunfig).toBe("not-applicable");
  expect(status?.references).toEqual({ total: 0, resolvable: 0, unresolved: [] });
  expect(status?.envFiles).toEqual([".env"]);
});

test("projectStatus reports a wired project and which references resolve", async () => {
  isolateEnv({ prefix: "status-wired" });
  await runCli(["set", "site/PRESENT", "--value", "here"]);

  const root = makeProject({
    "package.json": '{\n  "name": "site",\n  "scripts": {\n    "dev": "kerstel exec -- next dev"\n  }\n}\n',
    ".env": "PRESENT=kerstel://site/PRESENT\nMISSING=kerstel://site/MISSING\nPLAIN=still-plain\n",
  });

  const { key } = await loadOrCreateDataKey();
  const vault = openVault(key);
  try {
    const status = projectStatus(root, vault, hookDir());
    expect(status?.scripts).toEqual({ wrappable: 1, wired: 1 });
    expect(status?.references.total).toBe(2);
    expect(status?.references.resolvable).toBe(1);
    expect(status?.references.unresolved).toEqual(["kerstel://site/MISSING"]);
  } finally {
    vault.close();
  }
});

test("projectStatus checks the bunfig preload for bun projects", () => {
  const preload = join("/hook", "preload.cjs");
  const wired = makeProject({
    "package.json": '{\n  "name": "bunny"\n}\n',
    "bun.lock": "",
    "bunfig.toml": `preload = ["${preload}"]\n`,
  });
  const unwired = makeProject({
    "package.json": '{\n  "name": "bunny"\n}\n',
    "bun.lock": "",
    "bunfig.toml": "[test]\ncoverage = false\n",
  });

  expect(projectStatus(wired, emptyVault, "/hook")?.bunfig).toBe("present");
  expect(projectStatus(unwired, emptyVault, "/hook")?.bunfig).toBe("missing");
});

test("doctor prints the project section when run inside a project", async () => {
  isolateEnv({ prefix: "status-doctor" });
  const root = makeProject({
    "package.json": '{\n  "name": "site",\n  "scripts": {\n    "dev": "kerstel exec -- next dev"\n  }\n}\n',
    ".env": "PRESENT=kerstel://site/PRESENT\n",
  });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await doctorCommand(root)).toBe(0);
  } finally {
    console.log = realLog;
  }

  const out = captured.join("\n");
  expect(out).toContain("Project");
  expect(out).toContain("site");
  expect(out).toContain("1 of 1 script");
  expect(out).toContain("0 of 1 reference");
});

test("doctor outside a project prints no project section", async () => {
  isolateEnv({ prefix: "status-doctor-none" });
  const root = makeProject({ ".env": "A=1\n" });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await doctorCommand(root)).toBe(0);
  } finally {
    console.log = realLog;
  }
  expect(captured.join("\n")).not.toContain("Project");
});
