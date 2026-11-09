import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { scanCommand } from "../src/commands/scan";
import { gitStatuses } from "../src/move/git";
import { adviceFor, buildReport, type FileReport, type ScanReport } from "../src/scan/report";
import { walk } from "../src/scan/walk";
import { generateDataKey } from "../src/vault/crypto";
import { openVault } from "../src/vault/store";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    try {
      chmodSync(join(dir, "locked"), 0o755);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kerstel-scan-${prefix}-`));
  dirs.push(dir);
  return dir;
}

function tree(files: Record<string, string>, root = temp("tree")): string {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

/** A vault path that does not exist, so no reference is in it. */
function noVault(): string {
  return join(temp("novault"), "vault.db");
}

function scan(root: string, vault = noVault()): ScanReport {
  return buildReport(walk(root, { home: temp("home") }), { vault });
}

function file(report: ScanReport, rel: string, root: string): FileReport {
  for (const project of report.projects) {
    for (const f of project.files) if (relative(root, f.path) === rel) return f;
  }
  throw new Error(`no ${rel} in the report`);
}

const pkg = (extra: object = {}) => JSON.stringify({ name: "app", ...extra });

// Every value in these fixtures is a unique marker, so a test can prove none
// of them is ever printed.
const MARKERS = ["MARKER_A1", "MARKER_B2", "MARKER_C3", "MARKER_D4", "MARKER_E5", "MARKER_F6", "MARKER_G7"];

function fixture(): string {
  return tree({
    "shop/package.json": pkg({ name: "shop", workspaces: ["apps/*"] }),
    "shop/apps/web/package.json": pkg({ name: "@shop/web" }),
    "shop/apps/web/.env": `STRIPE_SECRET_KEY=sk_live_${MARKERS[0]}abcdefgh123\nPORT=3000\n`,
    "shop/apps/web/.env.local": "OPENAI_API_KEY=ks:global\nDATABASE_URL=ks:web/DATABASE_URL\n",
    "shop/apps/api/package.json": pkg({ name: "@shop/api" }),
    "shop/apps/api/.env": `API_TOKEN=${MARKERS[1]}\nAPP_NAME=Northwind ${MARKERS[2]}\n`,
    "shop/apps/api/.env.bak": `API_TOKEN=${MARKERS[3]}\n`,
    "shop/apps/api/docker/.env": `DB_PASSWORD=${MARKERS[4]}\n`,
    "shop/apps/api/.env.example": `STRIPE_SECRET_KEY=sk_test_xxx\nHOOK=https://x.example/h?token=${MARKERS[5]}9f8e7d6c5b\n`,
    "blog/package.json": pkg({ name: "blog" }),
    "blog/.env": "NODE_ENV=development\n",
    "scripts/.env": `PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n${MARKERS[6]}\n-----END PRIVATE KEY-----\n`,
  });
}

test("the walk finds every kind of env file and skips node_modules, .git and caches", () => {
  const root = tree({
    "app/.env": "A=1\n",
    "app/.env.example": "A=\n",
    "app/.env.bak": "A=1\n",
    "app/.env.swp": "binary",
    "app/.envrc": "not ours",
    "app/node_modules/dep/.env": "A=1\n",
    "app/.git/.env": "A=1\n",
    "app/.cache/x/.env": "A=1\n",
    "app/.kerstel/.env": "A=1\n",
  });
  mkdirSync(join(root, "app/.env.d"));
  const walked = walk(root, { home: temp("home") });
  expect(walked.files.map((f) => [relative(root, f.path), f.kind])).toEqual([
    ["app/.env", "env"],
    ["app/.env.bak", "backup"],
    ["app/.env.example", "template"],
    ["app/.env.swp", "backup"],
  ]);
  expect(walked.repoDirs.has(join(root, "app"))).toBe(true);
});

test("a symlinked folder is not followed; a symlinked env file is read", () => {
  const outside = tree({ "elsewhere/.env": `X_SECRET=${MARKERS[0]}\n` });
  const root = tree({ "app/package.json": pkg() });
  symlinkSync(join(outside, "elsewhere"), join(root, "app/linked"));
  symlinkSync(join(outside, "elsewhere/.env"), join(root, "app/.env"));
  const walked = walk(root, { home: temp("home") });
  expect(walked.files.map((f) => relative(root, f.path))).toEqual(["app/.env"]);
});

test.skipIf(process.getuid?.() === 0)("an unreadable folder is counted and does not stop the walk", () => {
  const root = tree({ "locked/.env": "A=1\n", "open/.env": "A=1\n" });
  chmodSync(join(root, "locked"), 0o000);
  const walked = walk(root, { home: temp("home") });
  expect(walked.unreadable).toEqual([join(root, "locked")]);
  expect(walked.files.map((f) => relative(root, f.path))).toEqual(["open/.env"]);
});

test("macOS ~/Library is skipped only at the home folder", () => {
  const home = tree({ "Library/app/.env": "A=1\n", "code/Library/.env": "A=1\n" });
  const files = (platform: NodeJS.Platform) =>
    walk(home, { home, platform }).files.map((f) => relative(home, f.path));
  expect(files("darwin")).toEqual(["code/Library/.env"]);
  expect(files("linux")).toEqual(["Library/app/.env", "code/Library/.env"]);
});

test("each file is judged, grouped by project and workspace, with advice", () => {
  const root = fixture();
  const report = scan(root);

  const web = file(report, "shop/apps/web/.env", root);
  expect(web.secrets.map((s) => s.key)).toEqual(["STRIPE_SECRET_KEY"]);
  expect(web.config).toBe(1);
  expect(web.initReads).toBe(true);
  expect(adviceFor(web)).toBe("init");

  const local = file(report, "shop/apps/web/.env.local", root);
  expect(local.references).toEqual([
    { key: "OPENAI_API_KEY", line: 1, ref: "ks:global/OPENAI_API_KEY", inVault: false },
    { key: "DATABASE_URL", line: 2, ref: "ks:web/DATABASE_URL", inVault: false },
  ]);
  expect(adviceFor(local)).toBeNull();

  const api = file(report, "shop/apps/api/.env", root);
  expect(api.secrets).toEqual([{ key: "API_TOKEN", line: 1 }]);
  expect(api.unclear).toEqual([{ key: "APP_NAME", line: 2 }]);

  expect(adviceFor(file(report, "shop/apps/api/.env.bak", root))).toBe("backup");
  const nested = file(report, "shop/apps/api/docker/.env", root);
  expect(nested.rel).toBe("docker/.env");
  expect(nested.initReads).toBe(false);
  expect(adviceFor(nested)).toBe("other");

  const template = file(report, "shop/apps/api/.env.example", root);
  expect(template.secrets).toEqual([{ key: "HOOK", line: 2 }]);
  expect(template.config).toBe(1);
  expect(adviceFor(template)).toBe("template");

  const pem = file(report, "scripts/.env", root);
  expect(pem.secrets).toEqual([{ key: "PRIVATE_KEY", line: 1 }]);
  expect(adviceFor(pem)).toBe("other");

  const projects = Object.fromEntries(report.projects.map((p) => [relative(root, p.path), p]));
  expect(Object.keys(projects).sort()).toEqual(["blog", "scripts", "shop/apps/api", "shop/apps/web"]);
  expect(projects["shop/apps/api"]!.workspace).toBe(join(root, "shop"));
  expect(projects["blog"]!.workspace).toBeNull();
  expect(projects["scripts"]!.packageJson).toBe(false);
  expect(report.workspaces.get(join(root, "shop"))!.members).toHaveLength(2);
});

test("references are checked by name in the vault, without its key", () => {
  const root = tree({ "app/package.json": pkg(), "app/.env": "OPENAI_API_KEY=ks:global\nDB=ks:app/DB\n" });
  const vaultFile = join(temp("vault"), "vault.db");
  const vault = openVault(generateDataKey(), vaultFile);
  vault.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, "value");
  vault.registerProject("app", join(root, "app"), "app");
  vault.close();

  const report = scan(root, vaultFile);
  expect(file(report, "app/.env", root).references.map((r) => r.inVault)).toEqual([true, false]);
  expect(report.projects[0]!.scope).toBe("app");
});

test("git status is tracked, not ignored, or ignored, per repository", () => {
  const root = tree({
    "repo/.gitignore": ".env.local\n",
    "repo/.env": "A=1\n",
    "repo/.env.local": "A=1\n",
    "repo/.env.development": "A=1\n",
    "repo/nested/.env": "A=1\n",
    "plain/.env": "A=1\n",
  });
  git(join(root, "repo"), "init", "-q");
  git(join(root, "repo", "nested"), "init", "-q");
  git(join(root, "repo"), "add", ".env");
  git(join(root, "repo", "nested"), "add", ".env");

  const report = scan(root);
  expect(report.git).toBe(true);
  expect(file(report, "repo/.env", root).git).toBe("tracked");
  expect(file(report, "repo/.env.local", root).git).toBe("ignored");
  expect(file(report, "repo/.env.development", root).git).toBe("not-ignored");
  expect(file(report, "repo/nested/.env", root).git).toBe("tracked");
  expect(file(report, "plain/.env", root).git).toBeNull();
});

test("scanning inside a repository still finds its git status", () => {
  const root = tree({ "sub/.env": `TOKEN=${MARKERS[0]}\n` });
  git(root, "init", "-q");
  git(root, "add", "sub/.env");
  const report = scan(join(root, "sub"));
  expect(report.projects[0]!.files[0]!.git).toBe("tracked");
});

test("gitStatuses batches many files and reads names with spaces", () => {
  const root = tree({ "a b/.env": "A=1\n", ".env": "A=1\n" });
  git(root, "init", "-q");
  git(root, "add", "a b/.env");
  const statuses = gitStatuses(root, ["a b/.env", ".env"])!;
  expect(statuses.get("a b/.env")).toBe("tracked");
  expect(statuses.get(".env")).toBe("not-ignored");
});

test("without git there is no git status, and the report says so", async () => {
  const root = tree({ "app/.env": `TOKEN=${MARKERS[0]}\n` });
  git(root, "init", "-q");
  const report = buildReport(walk(root, { home: temp("home") }), { vault: noVault(), git: false });
  expect(report.git).toBe(false);
  expect(report.projects[0]!.files[0]!.git).toBeNull();
  const { renderText } = await import("../src/scan/render");
  const { makeTheme } = await import("../src/ui/theme");
  const plain = makeTheme({ isTTY: false, noColor: true, truecolor: false });
  expect(renderText(report, { keys: false, all: false, verbose: false, cli: "kerstel" }, plain).join("\n")).toContain(
    "git is not installed",
  );
});

async function run(args: string[], vault = noVault()): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await scanCommand(args, { vault, home: temp("home"), stdout: (line) => lines.push(line), progress: () => {} });
  return { code, out: lines.join("\n") };
}

test("the report: collapsed clean projects, advice groups in order, exit 1", async () => {
  const root = fixture();
  git(join(root, "shop"), "init", "-q");
  git(join(root, "shop"), "add", "apps/web/.env");
  const { code, out } = await run([root]);
  expect(code).toBe(1);
  expect(out).toContain("8 env files");
  expect(out).toContain("shop");
  expect(out).toContain("workspace, 2 packages");
  expect(out).toContain("1 more project with nothing to do (--all lists them)");
  expect(out).not.toContain("blog");

  const order = [
    "tracked by git. Untrack it",
    "template holds what look like real keys",
    "backup copy holds secrets",
    "project holds secrets in plain text. Run kerstel init in it:",
    "files kerstel init doesn't read hold secrets",
  ].map((text) => out.indexOf(text));
  expect(order.every((i) => i !== -1)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(out).toContain("scripts/.env (no package.json)");
  expect(out).toContain("1 line is unclear");
  expect(out).not.toContain("API_TOKEN");
});

test("--keys names keys and line numbers; --all lists clean projects", async () => {
  const root = fixture();
  const { out } = await run([root, "--keys", "--all"]);
  expect(out).toMatch(/API_TOKEN\s+line 1\s+secret/);
  expect(out).toMatch(/APP_NAME\s+line 2\s+unclear/);
  expect(out).toMatch(/DATABASE_URL\s+line 2\s+ks:web\/DATABASE_URL not in this vault/);
  expect(out).toContain("blog");
  expect(out).toContain("config only");
});

test("--json has the documented shape", async () => {
  const root = tree({ "app/package.json": pkg(), "app/.env": "TOKEN=MARKER_J\nPORT=1\nOPENAI_API_KEY=ks:global\n" });
  const { code, out } = await run([join(root, "app"), "--json"]);
  expect(code).toBe(1);
  const json = JSON.parse(out);
  expect(Object.keys(json)).toEqual(["root", "folders", "unreadable", "git", "projects"]);
  expect(json.projects[0]).toEqual({
    path: join(root, "app"),
    name: "app",
    workspace: null,
    packageJson: true,
    scope: null,
    files: [
      {
        name: ".env",
        kind: "env",
        read: true,
        git: null,
        secrets: [{ key: "TOKEN", line: 1 }],
        unclear: [],
        config: 1,
        references: [{ key: "OPENAI_API_KEY", line: 3, ref: "ks:global/OPENAI_API_KEY", inVault: false }],
        unreadableLines: [],
      },
    ],
  });
});

test("exit 0 with no secret, and when there are no env files at all", async () => {
  const clean = tree({ "app/package.json": pkg(), "app/.env": "PORT=3000\nAPP_NAME=Northwind Traders\n" });
  const result = await run([clean]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("No secrets in plain text.");

  const empty = temp("empty");
  const none = await run([empty]);
  expect(none.code).toBe(0);
  expect(none.out).toContain("No env files under");
});

test("exit 2 for a missing folder, two folders, or an unknown flag", async () => {
  const log = console.log;
  console.log = () => {};
  try {
    expect((await run([join(temp("x"), "missing")])).code).toBe(2);
    expect((await run([temp("a"), temp("b")])).code).toBe(2);
    expect((await run(["--nope"])).code).toBe(2);
  } finally {
    console.log = log;
  }
});

test("scan never creates ~/.kerstel", async () => {
  const home = temp("kh");
  const vault = join(home, ".kerstel", "vault.db");
  await run([fixture()], vault);
  expect(existsSync(join(home, ".kerstel"))).toBe(false);
});

test("no value is printed in any output mode", async () => {
  const root = fixture();
  git(join(root, "shop"), "init", "-q");
  const errors: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    for (const args of [[], ["--keys"], ["--all"], ["--keys", "--all", "--verbose"], ["--json"]]) {
      const { out } = await run([root, ...args]);
      for (const marker of MARKERS) {
        expect(out).not.toContain(marker);
      }
    }
  } finally {
    process.stderr.write = write;
  }
  for (const marker of MARKERS) expect(errors.join("")).not.toContain(marker);
});

test("a complete PEM file, quoted or not, in an env file or a template, fails the scan", async () => {
  for (const [name, body] of [
    [".env", "KEY=-----BEGIN PRIVATE KEY-----\nMARKER_PEM\n-----END PRIVATE KEY-----\n"],
    [".env", 'KEY="-----BEGIN PRIVATE KEY-----\nMARKER_PEM\n-----END PRIVATE KEY-----"\n'],
    [".env.example", "KEY=-----BEGIN PRIVATE KEY-----\nMARKER_PEM\n-----END PRIVATE KEY-----\n"],
  ] as const) {
    const root = tree({ [`app/${name}`]: body });
    const { code, out } = await run([root]);
    expect(code).toBe(1);
    expect(out).toContain("1 secret");
    expect(out).not.toContain("MARKER_PEM");
  }
});

test("a symlinked scan root is scanned as its target folder", () => {
  const target = tree({ "app/.env": `TOKEN=${MARKERS[0]}\n` });
  const link = join(temp("link"), "code");
  symlinkSync(target, link);
  const walked = walk(link, { home: temp("home") });
  expect(walked.files.map((f) => relative(link, f.path))).toEqual(["app/.env"]);
});

test("a missing reference gets init advice only in a file init reads", async () => {
  const root = tree({
    "app/package.json": pkg(),
    "app/.env": "OPENAI_API_KEY=ks:global\n",
    "app/docker/.env": "DB=ks:app/DB\n",
    "loose/.env": "X=ks:global/X\n",
  });
  const { code, out } = await run([root]);
  expect(code).toBe(0);
  expect(out).toContain("1 reference isn't in this vault. Run kerstel init in the project to add its value:");
  expect(out).toContain(`     ${join(root, "app")}\n`);
  expect(out).toContain("2 references in files kerstel init doesn't read aren't in this vault");
  expect(out).toContain("with kerstel set <scope>/<KEY> (--keys names them):");
  expect(out).toContain(join(root, "app/docker/.env"));
  expect(out).toContain(join(root, "loose/.env"));
});
