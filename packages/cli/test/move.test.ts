import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveCommand, parseMoveArgs } from "../src/commands/move";
import { listBackups } from "../src/init/backup";
import { CancelledError, ScriptedPrompter, type Prompter } from "../src/init/prompts";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

const createdDirs: string[] = [];

afterEach(() => {
  const home = process.env.KERSTEL_HOME;
  if (home && home.startsWith(tmpdir())) createdDirs.push(home);
  restoreEnv();
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const PACKAGE = `{ "name": "app", "scripts": { "dev": "node .kerstel/exec.cjs -- node index.js" } }\n`;

function makeProject(env: Record<string, string>): string {
  isolateEnv({ prefix: "move" });
  const root = mkdtempSync(join(tmpdir(), "kerstel-move-"));
  createdDirs.push(root);
  writeFileSync(join(root, "package.json"), PACKAGE);
  for (const [name, contents] of Object.entries(env)) writeFileSync(join(root, name), contents);
  return root;
}

async function withVault<T>(use: (vault: Vault) => T): Promise<T> {
  const { key } = await loadOrCreateDataKey();
  const vault = openVault(key);
  try {
    return use(vault);
  } finally {
    vault.close();
  }
}

/** Runs the command in `root` and returns its exit code and everything it printed. */
async function run(root: string, args: string[], prompter: Prompter | null) {
  const lines: string[] = [];
  const realLog = console.log;
  const realCwd = process.cwd();
  console.log = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
  process.chdir(root);
  try {
    const code = await moveCommand(args, prompter);
    return { code, out: lines.join("\n") };
  } finally {
    process.chdir(realCwd);
    console.log = realLog;
  }
}

const SECRET = "sk-MOVE-CANARY-0123456789";

test("parseMoveArgs reads keys and flags", () => {
  expect(parseMoveArgs(["A", "B", "--to", "global", "--yes", "--replace", "--allow-tracked"], "/p")).toEqual({
    cwd: "/p",
    keys: ["A", "B"],
    to: "global",
    yes: true,
    replace: true,
    allowTracked: true,
  });
  expect(parseMoveArgs(["--to", "global"], "/p")).toEqual({ error: "--to needs the keys to move." });
  expect(parseMoveArgs(["A", "--to", "vault"], "/p")).toEqual({
    error: "--to takes global, project or plaintext.",
  });
  expect("error" in parseMoveArgs(["A", "--bogus"], "/p")).toBe(true);
});

test("direct form: plain → shared with --yes, backup first, value never printed", async () => {
  const root = makeProject({ ".env": `STRIPE_KEY=${SECRET}\n` });
  const { code, out } = await run(root, ["STRIPE_KEY", "--to", "global", "--yes"], null);

  expect(code).toBe(0);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("STRIPE_KEY=kerstel://global/STRIPE_KEY\n");
  expect(await withVault((v) => v.getSecret({ scope: "global", key: "STRIPE_KEY" }))).toBe(SECRET);
  expect(listBackups("app")).toHaveLength(1);
  expect(out).toContain("STRIPE_KEY now reads kerstel://global/STRIPE_KEY");
  expect(out).not.toContain(SECRET);
});

test("direct form: project → plain deletes the unused project copy", async () => {
  const root = makeProject({ ".env": "STRIPE_KEY=kerstel://app/STRIPE_KEY\nOTHER=kerstel://app/OTHER\n" });
  await withVault((v) => {
    v.setSecret({ scope: "app", key: "STRIPE_KEY" }, SECRET);
    v.setSecret({ scope: "app", key: "OTHER" }, "other");
    v.registerProject("app", root);
  });
  const { code, out } = await run(root, ["STRIPE_KEY", "--to", "plaintext", "--yes"], null);

  expect(code).toBe(0);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe(`STRIPE_KEY=${SECRET}\nOTHER=kerstel://app/OTHER\n`);
  expect(await withVault((v) => v.getSecret({ scope: "app", key: "STRIPE_KEY" }))).toBeNull();
  expect(out).not.toContain(SECRET);
});

test("direct form: a value with no plain-text spelling for its line stays in the vault", async () => {
  const root = makeProject({ ".env": 'K="kerstel://app/K"\n' });
  const unwritable = `{"a":"O'B"}`;
  await withVault((v) => {
    v.setSecret({ scope: "app", key: "K" }, unwritable);
    v.registerProject("app", root);
  });
  const { code, out } = await run(root, ["K", "--to", "plaintext", "--yes"], null);

  expect(code).toBe(1);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe('K="kerstel://app/K"\n');
  expect(await withVault((v) => v.getSecret({ scope: "app", key: "K" }))).toBe(unwritable);
  expect(out).toContain("K");
  expect(out).toContain("cannot be written as plain text");
  expect(out).not.toContain(unwritable);
});

test("the last reference moving out points at uninstall", async () => {
  const root = makeProject({ ".env": "K=kerstel://app/K\n" });
  await withVault((v) => v.setSecret({ scope: "app", key: "K" }, "v"));
  const { code, out } = await run(root, ["K", "--to", "plaintext", "--yes"], null);
  expect(code).toBe(0);
  expect(out).toContain("Nothing here reads the vault any more");
});

test("direct form refuses a conflict without --replace, and replaces with it", async () => {
  const root = makeProject({ ".env": "K=kerstel://app/K\n" });
  await withVault((v) => {
    v.setSecret({ scope: "app", key: "K" }, "project-value");
    v.setSecret({ scope: "global", key: "K" }, "shared-value");
  });

  const refused = await run(root, ["K", "--to", "global", "--yes"], null);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain("kerstel://global/K already holds a different value (12 chars).");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("K=kerstel://app/K\n");
  expect(listBackups("app")).toHaveLength(0);

  const replaced = await run(root, ["K", "--to", "global", "--yes", "--replace"], null);
  expect(replaced.code).toBe(0);
  expect(await withVault((v) => v.getSecret({ scope: "global", key: "K" }))).toBe("project-value");
});

test("direct form refuses plain text into a tracked file without --allow-tracked", async () => {
  const root = makeProject({ ".env": "K=kerstel://app/K\n" });
  await withVault((v) => v.setSecret({ scope: "app", key: "K" }, "v"));
  Bun.spawnSync(["git", "-C", root, "init", "-q"]);
  Bun.spawnSync(["git", "-C", root, "add", ".env"]);

  const refused = await run(root, ["K", "--to", "plaintext", "--yes"], null);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain(".env is tracked by git; K's value would be committed.");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("K=kerstel://app/K\n");

  const allowed = await run(root, ["K", "--to", "plaintext", "--yes", "--allow-tracked"], null);
  expect(allowed.code).toBe(0);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("K=v\n");
});

test("a named key that is not here, or already there, is skipped; none left exits 1", async () => {
  const root = makeProject({ ".env": "PORT=3000\n" });
  const missing = await run(root, ["NOPE", "--to", "global", "--yes"], null);
  expect(missing.code).toBe(1);
  expect(missing.out).toContain("NOPE is not in .env");

  const already = await run(root, ["PORT", "--to", "plaintext", "--yes"], null);
  expect(already.code).toBe(1);
  expect(already.out).toContain("PORT is already Plain text");
});

test("no terminal: every row of the spec §2.4 table", async () => {
  const root = makeProject({ ".env": "K=v\n" });

  const bare = await run(root, [], null);
  expect(bare.code).toBe(2);
  expect(bare.out).toContain("move asks questions, and this is not a terminal.");

  const keysOnly = await run(root, ["K"], null);
  expect(keysOnly.code).toBe(2);
  expect(keysOnly.out).toContain("move asks questions, and this is not a terminal.");

  const noYes = await run(root, ["K", "--to", "global"], null);
  expect(noYes.code).toBe(2);
  expect(noYes.out).toContain("K → Vault, shared by all your projects");
  expect(noYes.out).toContain("Apply needs a terminal; re-run with --yes.");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("K=v\n");

  const toOnly = await run(root, ["--to", "global"], null);
  expect(toOnly.code).toBe(2);
  expect(toOnly.out).toContain("--to needs the keys to move.");
});

test("interactive: pick a key, pick a destination, answer a conflict, apply", async () => {
  const root = makeProject({ ".env": "K=kerstel://app/K\nPORT=3000\n" });
  await withVault((v) => {
    v.setSecret({ scope: "app", key: "K" }, "project-value");
    v.setSecret({ scope: "global", key: "K" }, "shared-value");
  });
  const prompter = new ScriptedPrompter([["K:kerstel://app/K"], "global", "keep", "yes"]);
  const { code, out } = await run(root, [], prompter);

  expect(code).toBe(0);
  expect(prompter.asked).toEqual([
    "Which keys?",
    "Move K to:",
    "kerstel://global/K already holds a different value (12 chars). Which one stays?",
    "Apply?",
  ]);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("K=kerstel://global/K\nPORT=3000\n");
  expect(await withVault((v) => v.getSecret({ scope: "global", key: "K" }))).toBe("shared-value");
  expect(out).not.toContain("project-value");
  expect(out).not.toContain("shared-value");
});

test("a file edited while Apply? waits is refused with exit 1 and left alone", async () => {
  const root = makeProject({ ".env": "K=v\n" });
  class EditingPrompter extends ScriptedPrompter {
    override async select<T extends string>(question: string, choices: { value: T; label: string }[], d: T) {
      if (question === "Apply?") writeFileSync(join(root, ".env"), "K=v\nEDITED=1\n");
      return super.select(question, choices, d);
    }
  }
  const { code, out } = await run(root, ["K", "--to", "global"], new EditingPrompter(["yes"]));
  expect(code).toBe(1);
  expect(out).toContain(".env changed since");
  expect(out).toContain("nothing was changed.");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("K=v\nEDITED=1\n");
  expect(listBackups("app")).toHaveLength(0);
});

test("the scope is the vault's project record for this root, even when the files hold only plain values", async () => {
  const root = makeProject({ ".env": "K=v\n" });
  await withVault((v) => v.registerProject("custom", root));
  const { code } = await run(root, ["K", "--to", "project", "--yes"], null);
  expect(code).toBe(0);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("K=kerstel://custom/K\n");
  expect(await withVault((v) => v.getSecret({ scope: "custom", key: "K" }))).toBe("v");
  expect(await withVault((v) => v.getSecret({ scope: "app", key: "K" }))).toBeNull();
});

test("interactive: answering No changes nothing", async () => {
  const root = makeProject({ ".env": "K=v\n" });
  const { code } = await run(root, ["K"], new ScriptedPrompter(["global", "no"]));
  expect(code).toBe(0);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("K=v\n");
  expect(listBackups("app")).toHaveLength(0);
});

test("a named key is reported and skipped when there are no .env files at all; none left exits 1", async () => {
  const root = makeProject({});

  const named = await run(root, ["K", "--to", "global", "--yes"], null);
  expect(named.code).toBe(1);
  expect(named.out).toContain("K is not in any .env file; skipped.");

  const bare = await run(root, [], new ScriptedPrompter([]));
  expect(bare.code).toBe(0);
  expect(bare.out).toContain("Nothing to move.");
});

test("a vault row the vault doesn't hold is reported, not offered, and not asked a destination", async () => {
  const root = makeProject({ ".env": "A=kerstel://app/A\nB=v\n" });
  // A's reference is never stored: the row exists in the file, but not in the vault.
  const prompter = new ScriptedPrompter([["B:plaintext"], "global", "yes"]);
  const { code, out } = await run(root, [], prompter);

  expect(code).toBe(0);
  expect(out).toContain("A: kerstel://app/A is not in the vault. Run");
  expect(out).toContain("init to store it first.");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("A=kerstel://app/A\nB=kerstel://global/B\n");
});

test("a named key whose only row has a missing vault reference is reported once and skipped", async () => {
  const root = makeProject({ ".env": "A=kerstel://app/A\n" });
  const { code, out } = await run(root, ["A", "--to", "plaintext", "--yes"], null);
  expect(code).toBe(1);
  expect(out).toContain("A: kerstel://app/A is not in the vault. Run");
  expect(out.match(/is not in the vault/g)).toHaveLength(1);
});

test("when every row is foreign or has a missing vault reference, nothing is offered", async () => {
  const root = makeProject({ ".env": "A=kerstel://app/A\nB=kerstel://other/B\n" });
  const { code, out } = await run(root, [], new ScriptedPrompter([]));
  expect(code).toBe(0);
  expect(out).toContain("Nothing to move.");
});

test("the key menu header counts distinct keys, not rows", async () => {
  const root = makeProject({
    ".env": "K=kerstel://app/K\nOTHER=v\n",
    ".env.local": "K=kerstel://global/K\n",
  });
  await withVault((v) => {
    v.setSecret({ scope: "app", key: "K" }, "project-value");
    v.setSecret({ scope: "global", key: "K" }, "shared-value");
  });
  const prompter = new ScriptedPrompter([[], "no"]);
  const { out } = await run(root, [], prompter);
  // Two rows share the key K (project and global), plus OTHER: 2 distinct keys.
  expect(out).toContain("2 variables in");
});

test("a cancelled prompt makes moveCommand exit 130 and change nothing", async () => {
  const root = makeProject({ ".env": "K=v\n" });
  const cancels: Prompter = {
    select: async () => {
      throw new CancelledError();
    },
    multiselect: async () => {
      throw new CancelledError();
    },
    text: async () => {
      throw new CancelledError();
    },
  };
  const { code, out } = await run(root, ["K"], cancels);
  expect(code).toBe(130);
  expect(out).toContain("Cancelled. Nothing was changed.");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("K=v\n");
});
