import { expect, test } from "bun:test";
import { join } from "node:path";
import type { LoadedEnvFile } from "../src/init/collect";
import { parseDotenv } from "../src/init/dotenv-file";
import type { GitFileStatus } from "../src/move/git";
import { planMove, type ConflictChoice, type PlanInput } from "../src/move/plan";
import { scanRows, type Place } from "../src/move/scan";
import type { SecretRef } from "../src/reference";

const ROOT = "/project";

function load(files: Record<string, string>): LoadedEnvFile[] {
  return Object.entries(files).map(([name, original], i) => ({
    info: { name, path: join(ROOT, name), rank: 100 - i },
    original,
    file: parseDotenv(original),
  }));
}

interface Setup {
  files: Record<string, string>;
  vault?: Record<string, string>;
  moves: [id: string, to: Place][];
  recordedRoot?: string | null;
  choices?: Record<string, ConflictChoice>;
  git?: Record<string, GitFileStatus>;
}

function plan(setup: Setup) {
  const loaded = load(setup.files);
  const { rows } = scanRows(loaded, "app");
  const vault = setup.vault ?? {};
  const input: PlanInput = {
    scope: "app",
    root: ROOT,
    loaded,
    requests: setup.moves.map(([id, to]) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`no row ${id}; rows: ${rows.map((r) => r.id).join(", ")}`);
      return { row, to };
    }),
    vaultValue: (ref: SecretRef) => vault[`${ref.scope}/${ref.key}`] ?? null,
    recordedRoot: setup.recordedRoot === undefined ? ROOT : setup.recordedRoot,
    choices: new Map(Object.entries(setup.choices ?? {})),
    gitStatus: (name) => setup.git?.[name] ?? null,
  };
  return planMove(input);
}

function after(result: ReturnType<typeof plan>, name: string): string | undefined {
  return result.files.find((f) => f.name === name)?.after;
}

test("plain → project stores the value and writes the reference", () => {
  const result = plan({ files: { ".env": "K=secret-value\n" }, moves: [["K:plaintext", "project"]] });
  expect(after(result, ".env")).toBe("K=kerstel://app/K\n");
  expect(result.vaultWrites).toEqual([{ ref: { scope: "app", key: "K" }, value: "secret-value", previous: null }]);
  expect(result.moves[0]!.outcome).toBe("new");
  expect(result.deletions).toEqual([]);
});

test("plain → shared stores the value in global", () => {
  const result = plan({ files: { ".env": "K=secret-value\n" }, moves: [["K:plaintext", "global"]] });
  expect(after(result, ".env")).toBe("K=kerstel://global/K\n");
  expect(result.vaultWrites[0]!.ref).toEqual({ scope: "global", key: "K" });
});

test("project → shared copies the value and deletes the unused project copy", () => {
  const result = plan({
    files: { ".env": "K=kerstel://app/K\n" },
    vault: { "app/K": "v" },
    moves: [["K:kerstel://app/K", "global"]],
  });
  expect(after(result, ".env")).toBe("K=kerstel://global/K\n");
  expect(result.vaultWrites).toEqual([{ ref: { scope: "global", key: "K" }, value: "v", previous: null }]);
  expect(result.deletions).toEqual([{ ref: { scope: "app", key: "K" }, value: "v" }]);
});

test("shared → project copies the value and never deletes global", () => {
  const result = plan({
    files: { ".env": "K=kerstel://global/K\n" },
    vault: { "global/K": "v" },
    moves: [["K:kerstel://global/K", "project"]],
  });
  expect(after(result, ".env")).toBe("K=kerstel://app/K\n");
  expect(result.vaultWrites[0]!.ref).toEqual({ scope: "app", key: "K" });
  expect(result.deletions).toEqual([]);
  expect(result.kept).toEqual([]);
});

test("project → plain writes the value back and deletes the project copy", () => {
  const result = plan({
    files: { ".env": 'K="kerstel://app/K"\n' },
    vault: { "app/K": "has space" },
    moves: [["K:kerstel://app/K", "plaintext"]],
  });
  expect(after(result, ".env")).toBe('K="has space"\n');
  expect(result.moves[0]!.outcome).toBe("plaintext");
  expect(result.deletions).toEqual([{ ref: { scope: "app", key: "K" }, value: "has space" }]);
});

test("shared → plain writes the value back and keeps global", () => {
  const result = plan({
    files: { ".env": "K=kerstel://global/K\n" },
    vault: { "global/K": "v" },
    moves: [["K:kerstel://global/K", "plaintext"]],
  });
  expect(after(result, ".env")).toBe("K=v\n");
  expect(result.deletions).toEqual([]);
  expect(result.vaultWrites).toEqual([]);
});

test("every covered file is rewritten, and every assignment in it", () => {
  const result = plan({
    files: { ".env.local": "K=v\nK=v\n", ".env": "K=v\n" },
    moves: [["K:plaintext", "global"]],
  });
  expect(after(result, ".env.local")).toBe("K=kerstel://global/K\nK=kerstel://global/K\n");
  expect(after(result, ".env")).toBe("K=kerstel://global/K\n");
});

for (const dest of ["global", "project"] as const) {
  const destRef = dest === "global" ? "global/K" : "app/K";
  const source = dest === "global" ? "K:kerstel://app/K" : "K:kerstel://global/K";
  const sourceRef = dest === "global" ? "app/K" : "global/K";

  test(`an existing ${dest} entry with the same value asks nothing`, () => {
    const result = plan({
      files: { ".env": `K=kerstel://${sourceRef}\n` },
      vault: { [sourceRef]: "same", [destRef]: "same" },
      moves: [[source, dest]],
    });
    expect(result.conflicts).toEqual([]);
    expect(result.vaultWrites).toEqual([]);
    expect(result.moves[0]!.outcome).toBe("same");
  });

  test(`an existing ${dest} entry with a different value is a conflict until chosen`, () => {
    const base = {
      files: { ".env": `K=kerstel://${sourceRef}\n` },
      vault: { [sourceRef]: "incoming", [destRef]: "existing-value" },
      moves: [[source, dest]] as [string, Place][],
    };
    const open = plan(base);
    expect(open.conflicts).toEqual([
      { key: "K", ref: { scope: destRef.split("/")[0]!, key: "K" }, existingLength: "existing-value".length },
    ]);
    expect(open.moves[0]!.outcome).toBe("conflict");

    const kept = plan({ ...base, choices: { [`kerstel://${destRef}`]: "keep" } });
    expect(kept.conflicts).toEqual([]);
    expect(kept.vaultWrites).toEqual([]);
    expect(kept.moves[0]!.outcome).toBe("kept");
    expect(kept.moves[0]!.length).toBe("existing-value".length);

    const replaced = plan({ ...base, choices: { [`kerstel://${destRef}`]: "replace" } });
    expect(replaced.vaultWrites).toEqual([
      { ref: { scope: destRef.split("/")[0]!, key: "K" }, value: "incoming", previous: "existing-value" },
    ]);
    expect(replaced.moves[0]!.outcome).toBe("replaced");
  });
}

test("two rows for one key moving to the same absent destination: the first request writes, the second merges", () => {
  const result = plan({
    files: { ".env.local": "K=plain-a\n", ".env": "K=kerstel://app/K\n" },
    vault: { "app/K": "vault-b" },
    moves: [
      ["K:plaintext", "global"],
      ["K:kerstel://app/K", "global"],
    ],
  });
  expect(result.vaultWrites).toEqual([{ ref: { scope: "global", key: "K" }, value: "plain-a", previous: null }]);
  expect(result.conflicts).toEqual([]);
  expect(result.mergeWarnings).toEqual([{ key: "K", used: ".env.local", others: [".env"] }]);
  expect(result.moves[0]!.outcome).toBe("new");
  expect(result.moves[1]!.outcome).toBe("kept");
  expect(result.moves[1]!.length).toBe("plain-a".length);
});

test("two rows for one key moving to the same conflicting destination: exactly one conflict, resolved by one write", () => {
  const base = {
    files: { ".env.local": "K=plain-a\n", ".env": "K=kerstel://app/K\n" },
    vault: { "app/K": "vault-b", "global/K": "existing-different" },
    moves: [
      ["K:plaintext", "global"],
      ["K:kerstel://app/K", "global"],
    ] as [string, Place][],
  };

  const open = plan(base);
  expect(open.conflicts).toEqual([
    { key: "K", ref: { scope: "global", key: "K" }, existingLength: "existing-different".length },
  ]);
  expect(open.moves[0]!.outcome).toBe("conflict");
  expect(open.moves[1]!.outcome).toBe("conflict");

  const replaced = plan({ ...base, choices: { "kerstel://global/K": "replace" } });
  expect(replaced.vaultWrites).toEqual([
    { ref: { scope: "global", key: "K" }, value: "plain-a", previous: "existing-different" },
  ]);
  expect(replaced.conflicts).toEqual([]);
  expect(replaced.moves[0]!.outcome).toBe("replaced");
  expect(replaced.moves[1]!.outcome).toBe("kept");
});

test("a plain value that loses to a kept destination is recorded as discarded; a vault one is not", () => {
  const kept = plan({
    files: { ".env": "K=plain-incoming\n" },
    vault: { "global/K": "existing" },
    moves: [["K:plaintext", "global"]],
    choices: { "kerstel://global/K": "keep" },
  });
  expect(kept.moves[0]!.outcome).toBe("kept");
  expect(kept.discarded).toEqual([{ ref: { scope: "global", key: "K" }, value: "plain-incoming" }]);

  const replaced = plan({
    files: { ".env": "K=plain-incoming\n" },
    vault: { "global/K": "existing" },
    moves: [["K:plaintext", "global"]],
    choices: { "kerstel://global/K": "replace" },
  });
  expect(replaced.discarded).toEqual([]);

  const fromVault = plan({
    files: { ".env": "K=kerstel://app/K\n" },
    vault: { "app/K": "project-value", "global/K": "existing" },
    moves: [["K:kerstel://app/K", "global"]],
    choices: { "kerstel://global/K": "keep" },
  });
  expect(fromVault.discarded).toEqual([]);
  expect(fromVault.deletions).toEqual([{ ref: { scope: "app", key: "K" }, value: "project-value" }]);
});

test("a plain value that loses a cross-request merge is recorded as discarded", () => {
  const result = plan({
    files: { ".env.local": "K=kerstel://app/K\n", ".env": "K=plain-b\n" },
    vault: { "app/K": "vault-a" },
    moves: [
      ["K:kerstel://app/K", "global"],
      ["K:plaintext", "global"],
    ],
  });
  expect(result.vaultWrites).toEqual([{ ref: { scope: "global", key: "K" }, value: "vault-a", previous: null }]);
  expect(result.moves[1]!.outcome).toBe("kept");
  expect(result.discarded).toEqual([{ ref: { scope: "global", key: "K" }, value: "plain-b" }]);
});

test("a project copy another file still references is kept", () => {
  const result = plan({
    files: { ".env.local": "K=kerstel://app/K\n", ".env": "K=kerstel://app/K\nOTHER=kerstel://app/K\n" },
    vault: { "app/K": "v" },
    moves: [["K:kerstel://app/K", "global"]],
  });
  expect(result.deletions).toEqual([]);
  expect(result.kept).toEqual([{ ref: { scope: "app", key: "K" }, reason: "referenced", root: null }]);
});

test("a project copy is kept when the recorded root is another checkout", () => {
  const result = plan({
    files: { ".env": "K=kerstel://app/K\n" },
    vault: { "app/K": "v" },
    moves: [["K:kerstel://app/K", "plaintext"]],
    recordedRoot: "/elsewhere/app",
  });
  expect(result.deletions).toEqual([]);
  expect(result.kept).toEqual([{ ref: { scope: "app", key: "K" }, reason: "other-checkout", root: "/elsewhere/app" }]);
});

test("a project copy is deleted when the vault has no record of the project", () => {
  const result = plan({
    files: { ".env": "K=kerstel://app/K\n" },
    vault: { "app/K": "v" },
    moves: [["K:kerstel://app/K", "plaintext"]],
    recordedRoot: null,
  });
  expect(result.deletions).toEqual([{ ref: { scope: "app", key: "K" }, value: "v" }]);
});

test("different references in different files move as separate rows", () => {
  const result = plan({
    files: { ".env.local": "K=kerstel://global/K\n", ".env": "K=kerstel://app/K\n" },
    vault: { "global/K": "g", "app/K": "p" },
    moves: [["K:kerstel://app/K", "plaintext"]],
  });
  expect(result.moves).toHaveLength(1);
  expect(result.moves[0]!.files).toEqual([".env"]);
  expect(after(result, ".env")).toBe("K=p\n");
  expect(after(result, ".env.local")).toBeUndefined();
});

test("two different project references for one key: moving one rewrites only its file, with its own value", () => {
  const files = { ".env.local": "K=kerstel://app/K_LOCAL\n", ".env": "K=kerstel://app/K\n" };
  const vault = { "app/K_LOCAL": "local-value", "app/K": "base-value" };

  const base = plan({ files, vault, moves: [["K:kerstel://app/K", "plaintext"]] });
  expect(base.moves).toHaveLength(1);
  expect(base.moves[0]!.files).toEqual([".env"]);
  expect(base.moves[0]!.fromRef).toEqual({ scope: "app", key: "K" });
  expect(after(base, ".env")).toBe("K=base-value\n");
  expect(after(base, ".env.local")).toBeUndefined();
  expect(base.deletions).toEqual([{ ref: { scope: "app", key: "K" }, value: "base-value" }]);

  const local = plan({ files, vault, moves: [["K:kerstel://app/K_LOCAL", "plaintext"]] });
  expect(local.moves[0]!.files).toEqual([".env.local"]);
  expect(local.moves[0]!.fromRef).toEqual({ scope: "app", key: "K_LOCAL" });
  expect(after(local, ".env.local")).toBe("K=local-value\n");
  expect(after(local, ".env")).toBeUndefined();
  expect(local.deletions).toEqual([{ ref: { scope: "app", key: "K_LOCAL" }, value: "local-value" }]);
});

test("a reference in one file and a plain value in another: moving the plain row", () => {
  const result = plan({
    files: { ".env.local": "K=plain\n", ".env": "K=kerstel://app/K\n" },
    vault: { "app/K": "plain" },
    moves: [["K:plaintext", "project"]],
  });
  expect(after(result, ".env.local")).toBe("K=kerstel://app/K\n");
  expect(result.moves[0]!.outcome).toBe("same");
});

test("a reference the vault does not hold is skipped, not moved", () => {
  const result = plan({ files: { ".env": "K=kerstel://app/K\n" }, moves: [["K:kerstel://app/K", "plaintext"]] });
  expect(result.skipped).toEqual([{ key: "K", ref: { scope: "app", key: "K" } }]);
  expect(result.moves).toEqual([]);
  expect(result.files).toEqual([]);
});

test("plain values that differ between files: the first file's value is stored", () => {
  const result = plan({
    files: { ".env.local": "K=local-value\n", ".env": "K=base-value\n" },
    moves: [["K:plaintext", "global"]],
  });
  expect(result.vaultWrites[0]!.value).toBe("local-value");
  expect(result.mergeWarnings).toEqual([{ key: "K", used: ".env.local", others: [".env"] }]);
});

test("plain text into a tracked or unignored file warns; into an ignored one does not", () => {
  const result = plan({
    files: { ".env.local": "K=kerstel://app/K\n", ".env": "K=kerstel://app/K\n" },
    vault: { "app/K": "v" },
    moves: [["K:kerstel://app/K", "plaintext"]],
    git: { ".env": "tracked", ".env.local": "ignored" },
  });
  expect(result.gitWarnings).toEqual([{ file: ".env", key: "K", status: "tracked" }]);
});

test("noReferencesLeft is set when the last reference moves out", () => {
  const last = plan({
    files: { ".env": "K=kerstel://app/K\nPORT=3000\n" },
    vault: { "app/K": "v" },
    moves: [["K:kerstel://app/K", "plaintext"]],
  });
  expect(last.noReferencesLeft).toBe(true);

  const notLast = plan({
    files: { ".env": "K=kerstel://app/K\nJ=kerstel://app/J\n" },
    vault: { "app/K": "v", "app/J": "w" },
    moves: [["K:kerstel://app/K", "plaintext"]],
  });
  expect(notLast.noReferencesLeft).toBe(false);
});

test("a request to where the key already is does nothing", () => {
  const result = plan({ files: { ".env": "K=v\n" }, moves: [["K:plaintext", "plaintext"]] });
  expect(result.moves).toEqual([]);
  expect(result.files).toEqual([]);
  expect(result.noReferencesLeft).toBe(false);
});
