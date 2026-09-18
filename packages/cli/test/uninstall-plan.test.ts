import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasLoss, planUninstall } from "../src/uninstall/plan";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

const dirs: string[] = [];
let vault: Vault | null = null;

afterEach(() => {
  vault?.close();
  vault = null;
  restoreEnv();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function freshVault(): Promise<Vault> {
  dirs.push(isolateEnv({ prefix: "uninstall-plan" }));
  const { key } = await loadOrCreateDataKey();
  vault = openVault(key);
  return vault;
}

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-uninstall-project-"));
  dirs.push(root);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  return root;
}

const WIRED = '{\n  "name": "demo-app",\n  "scripts": {\n    "dev": "kerstel exec -- next dev"\n  }\n}\n';

test("rewrites references to vault values and never puts a value in the diff", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "demo-app", key: "API_KEY" }, "sk-live-value");
  const root = project({
    "package.json": WIRED,
    ".env": "# keep me\r\nAPI_KEY=kerstel://demo-app/API_KEY\r\nPORT=3000\r\n",
  });
  v.registerProject("demo-app", root);

  const plan = planUninstall(v);
  const env = plan.files.find((f) => f.path === join(root, ".env"))!;
  expect(env.after).toBe("# keep me\r\nAPI_KEY=sk-live-value\r\nPORT=3000\r\n");
  expect(env.diffBefore + env.diffAfter).not.toContain("sk-live-value");
  expect(env.label).toBe("demo-app: .env");

  const pkg = plan.files.find((f) => f.path === join(root, "package.json"))!;
  expect(pkg.after).toContain('"dev": "next dev"');
  expect(plan.restored).toEqual([{ name: "demo-app", rootPath: root }]);
  expect(hasLoss(plan)).toBe(false);
});

test("swaps the .gitignore note back", async () => {
  const v = await freshVault();
  const root = project({
    "package.json": WIRED,
    ".gitignore": "node_modules\n# Kerstel: .env files hold references, safe to commit\n",
  });
  v.registerProject("demo-app", root);

  const plan = planUninstall(v);
  expect(plan.files.find((f) => f.path === join(root, ".gitignore"))?.after).toBe("node_modules\n.env\n.env.*\n");
});

test("records an unreachable project, an unresolvable reference, and an unused secret", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "global", key: "ORPHAN" }, "x");
  const gone = join(tmpdir(), "kerstel-uninstall-gone-project");
  v.registerProject("gone", gone);
  const noPkg = project({});
  v.registerProject("no-pkg", noPkg);
  const root = project({ "package.json": WIRED, ".env": "MISSING=kerstel://demo-app/MISSING\n" });
  v.registerProject("demo-app", root);

  const plan = planUninstall(v);
  expect(plan.unreachable).toEqual([
    { name: "gone", rootPath: gone, reason: "the folder no longer exists" },
    { name: "no-pkg", rootPath: noPkg, reason: "it has no package.json" },
  ]);
  expect(plan.unresolvable).toEqual([
    { project: "demo-app", file: join(root, ".env"), reference: "kerstel://demo-app/MISSING" },
  ]);
  expect(plan.unused).toEqual(["kerstel://global/ORPHAN"]);
  expect(hasLoss(plan)).toBe(true);
});

test("a malformed package.json makes the project unreachable", async () => {
  const v = await freshVault();
  const root = project({ "package.json": "{ nope" });
  v.registerProject("bad-json", root);
  expect(planUninstall(v).unreachable[0]?.reason).toBe("its package.json is not valid JSON");
});

test("a secret used only through a global reference in a project is not unused", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "global", key: "SHARED" }, "shared-value");
  const root = project({ "package.json": WIRED, ".env": "SHARED=kerstel://global/SHARED\n" });
  mkdirSync(join(root, "sub"));
  v.registerProject("demo-app", root);
  expect(planUninstall(v).unused).toEqual([]);
});
