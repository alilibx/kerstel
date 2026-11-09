import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseRefsArgs, refsCommand, renderByKey, renderByProject } from "../src/commands/refs";
import { lineReferences, scanProjectRefs } from "../src/project-refs";
import { makeTheme } from "../src/ui/theme";
import { generateDataKey } from "../src/vault/crypto";
import { planUninstall } from "../src/uninstall/plan";
import { readStoredReferences } from "../src/vault/meta";
import { readProjectRows } from "../src/vault/projects";
import { openVault } from "../src/vault/store";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kerstel-refs-")));
  dirs.push(dir);
  return dir;
}

function tree(root: string, files: Record<string, string>): string {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

const plain = makeTheme({ isTTY: false, noColor: true, truecolor: false });
const VALUES = ["web-db-value-1", "stripe-value-2", "openai-value-3"];

/** Two checkouts, a resolvable and an unresolvable reference, an unreachable project, an unused secret. */
function fixture() {
  const base = temp();
  const web = tree(join(base, "web"), {
    "package.json": '{"name":"web"}',
    ".env": "DATABASE_URL=ks:web\nSTRIPE_SECRET_KEY=kerstel://global/STRIPE_SECRET_KEY\nPORT=3000\n",
    ".env.local": "SESSION_SECRET=ks:web\n",
  });
  const api = tree(join(base, "api"), {
    "package.json": '{"name":"api"}',
    ".env": "PAYMENTS=ks:global/STRIPE_SECRET_KEY\n",
  });
  const vaultFile = join(base, "home", "vault.db");
  mkdirSync(dirname(vaultFile), { recursive: true });
  const key = generateDataKey();
  const vault = openVault(key, vaultFile);
  vault.setSecret({ scope: "web", key: "DATABASE_URL" }, VALUES[0]!);
  vault.setSecret({ scope: "global", key: "STRIPE_SECRET_KEY" }, VALUES[1]!);
  vault.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, VALUES[2]!);
  vault.registerProject("web", web, "web");
  vault.registerProject("api", api, "api");
  vault.registerProject("legacy", join(base, "gone"), "legacy");
  vault.close();
  return { base, web, api, vaultFile, key };
}

test("lineReferences finds every form, with its line and full reference", () => {
  expect(lineReferences("# x\nA=ks:global\nB=ks:app/OTHER\nC=kerstel://app/C\nD=plain\n")).toEqual([
    { index: 1, key: "A", ref: { scope: "global", key: "A" }, reference: "ks:global/A" },
    { index: 2, key: "B", ref: { scope: "app", key: "OTHER" }, reference: "ks:app/OTHER" },
    { index: 3, key: "C", ref: { scope: "app", key: "C" }, reference: "ks:app/C" },
  ]);
});

test("the scan finds references, unresolvable ones, unreachable checkouts and unused secrets", () => {
  const { web, api, base, vaultFile } = fixture();
  const refs = scanProjectRefs(readProjectRows(vaultFile), readStoredReferences(vaultFile));

  expect(refs.checkouts.map((c) => c.scope).sort()).toEqual(["api", "web"]);
  expect(refs.unresolvable).toEqual([
    { scope: "web", rootPath: web, file: join(web, ".env.local"), reference: "ks:web/SESSION_SECRET" },
  ]);
  expect(refs.unreachable).toEqual([{ scope: "legacy", rootPath: join(base, "gone"), reason: "the folder no longer exists" }]);
  expect(refs.unused).toEqual(["ks:global/OPENAI_API_KEY"]);
  const apiFiles = refs.checkouts.find((c) => c.rootPath === api)!.files;
  expect(apiFiles[0]!.references[0]!.reference).toBe("ks:global/STRIPE_SECRET_KEY");
});

async function run(args: string[], vault: string): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await refsCommand(args, { vault, stdout: (line) => lines.push(line), theme: plain });
  return { code, out: lines.join("\n") };
}

test("the default view groups by scope, checkout and file", async () => {
  const { web, base, vaultFile } = fixture();
  const { code, out } = await run([], vaultFile);
  expect(code).toBe(0);
  expect(out).toContain(`web  ${web}`);
  expect(out).toMatch(/\.env\s+ks:web\/DATABASE_URL\n\s+ks:global\/STRIPE_SECRET_KEY/);
  expect(out).toMatch(/\.env\.local\s+ks:web\/SESSION_SECRET\s+✗ not in the vault/);
  expect(out).toContain("Unreachable");
  expect(out).toMatch(new RegExp(`✗ legacy\\s+${join(base, "gone")}\\s+the folder no longer exists`));
  expect(out).toContain("Referenced by no project\n  ks:global/OPENAI_API_KEY");
  expect(out.startsWith("\n")).toBe(false);
  for (const value of VALUES) expect(out).not.toContain(value);
});

test("--by-key lists each secret's files, then what the vault lacks", async () => {
  const { web, api, vaultFile } = fixture();
  const { code, out } = await run(["--by-key"], vaultFile);
  expect(code).toBe(0);
  expect(out).toContain(`ks:global/STRIPE_SECRET_KEY\n  api  ${join(api, ".env")}\n  web  ${join(web, ".env")}`);
  expect(out).toContain(`Not in the vault\n  ✗ ks:web/SESSION_SECRET  web  ${join(web, ".env.local")}`);
  expect(out).toContain("Referenced by no project");
  for (const value of VALUES) expect(out).not.toContain(value);
});

test("no vault is information, an unknown flag is exit 2, and nothing is created", async () => {
  const home = temp();
  const vault = join(home, ".kerstel", "vault.db");
  const log = console.log;
  const printed: string[] = [];
  console.log = (...args: unknown[]) => printed.push(args.join(" "));
  try {
    expect((await run([], vault)).code).toBe(0);
    expect(printed.join("\n")).toContain("No vault yet.");
    expect((await run(["--nope"], vault)).code).toBe(2);
  } finally {
    console.log = log;
  }
  expect(existsSync(join(home, ".kerstel"))).toBe(false);
  expect(parseRefsArgs(["--by-key"])).toEqual({ byKey: true });
});

test("uninstall's unresolvable and unused lists are the scan's", () => {
  const { vaultFile, key } = fixture();
  const refs = scanProjectRefs(readProjectRows(vaultFile), readStoredReferences(vaultFile));
  expect(renderByProject(refs, plain).join("\n")).toContain("ks:web/SESSION_SECRET");
  expect(renderByKey(refs, plain).join("\n")).toContain("ks:web/SESSION_SECRET");

  const vault = openVault(key, vaultFile);
  try {
    const plan = planUninstall(vault, key);
    expect(plan.unused).toEqual(refs.unused);
    expect(plan.unresolvable).toEqual(refs.unresolvable.map((u) => ({ project: u.scope, file: u.file, reference: u.reference })));
  } finally {
    vault.close();
  }
});
