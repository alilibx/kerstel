import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRefs } from "../src/project-refs";
import { MAX_VALUE_CHARS } from "../src/secret-value";
import { initialState, rowsFor, update, type Effect, type Event, type State } from "../src/tui/app";
import { sortSecrets, vaultData, type SecretRow } from "../src/tui/data";
import type { Key } from "../src/tui/keys";
import { render } from "../src/tui/render";
import { frameText, runEffect } from "../src/tui/run";
import { makeTheme } from "../src/ui/theme";
import { generateDataKey } from "../src/vault/crypto";
import { openVault } from "../src/vault/store";

/** Terminal UI spec §4.4: reveal, add, edit and delete on the Secrets screen (#9). */

const plain = makeTheme({ isTTY: false, noColor: true, truecolor: false });
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const secrets: SecretRow[] = sortSecrets([
  { scope: "global", key: "OPENAI_API_KEY", reference: "ks:global/OPENAI_API_KEY", updatedAt: 0 },
  { scope: "web", key: "DATABASE_URL", reference: "ks:web/DATABASE_URL", updatedAt: 0 },
]);
const refs: ProjectRefs = {
  checkouts: [
    {
      scope: "web",
      rootPath: "/src/web",
      files: [
        {
          path: "/src/web/.env",
          name: ".env",
          original: "",
          references: [
            { index: 0, key: "DATABASE_URL", ref: { scope: "web", key: "DATABASE_URL" }, reference: "ks:web/DATABASE_URL", inVault: true },
          ],
        },
      ],
    },
  ],
  unreachable: [],
  unreadable: [],
  unresolvable: [],
  unused: ["ks:global/OPENAI_API_KEY"],
};

const char = (c: string): Event => ({ type: "key", key: { kind: "char", char: c } });
const named = (name: Extract<Key, { kind: "named" }>["name"]): Event => ({ type: "key", key: { kind: "named", name } });
const typed = (text: string): Event[] => [...text].map(char);

function loaded(): State {
  return update(initialState(90, 20), { type: "loaded", secrets, refs }).state;
}

/** Applies events, collecting every effect along the way. */
function run(state: State, ...events: Event[]): { state: State; effects: Effect[] } {
  const effects: Effect[] = [];
  for (const event of events) {
    const result = update(state, event);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

test("r asks for a reveal; the value shows on its row until the next key", () => {
  const asked = run(loaded(), char("r"));
  expect(asked.effects).toEqual([{ type: "reveal", ref: { scope: "global", key: "OPENAI_API_KEY" } }]);
  let s = run(asked.state, { type: "revealed", reference: "ks:global/OPENAI_API_KEY", value: "sk-revealed-1" }).state;
  expect(render(s, plain)[2]).toContain("sk-revealed-1");
  // Moving hides it: the value is gone from the state, not only from the frame.
  s = run(s, char("j")).state;
  expect(s.revealed).toBeNull();
  expect(frameText(render(s, plain))).not.toContain("sk-revealed-1");
  // r on the revealed row hides it rather than asking again.
  s = run(loaded(), { type: "revealed", reference: "ks:global/OPENAI_API_KEY", value: "sk-revealed-1" }).state;
  const again = run(s, char("r"));
  expect(again.effects).toEqual([]);
  expect(again.state.revealed).toBeNull();
});

test("a reveal of a secret removed meanwhile says so and reloads", () => {
  const r = run(loaded(), { type: "revealed", reference: "ks:global/OPENAI_API_KEY", value: null });
  expect(r.state.status?.tone).toBe("problem");
  expect(r.effects).toEqual([{ type: "reload" }]);
});

test("a adds: scope, key, masked value, confirm, store", () => {
  let r = run(loaded(), char("a"));
  expect(r.state.modal).toMatchObject({ kind: "pick-scope", choices: ["global", "web", "New scope…"] });
  r = run(r.state, named("enter"), ...typed("NEW_TOKEN"), named("enter"), ...typed("tok-value-2"));
  const frame = frameText(render(r.state, plain));
  expect(frame).toContain("Value for ks:global/NEW_TOKEN: •••••••••••▏");
  expect(frame).not.toContain("tok-value-2");
  r = run(r.state, named("enter"));
  expect(render(r.state, plain).join("\n")).toContain("Store ks:global/NEW_TOKEN? Y/n");
  r = run(r.state, char("y"));
  expect(r.effects).toEqual([{ type: "store", ref: { scope: "global", key: "NEW_TOKEN" }, value: "tok-value-2" }]);
  expect(r.state.modal).toBeNull();
  // Once stored: a reload, then the cursor on the new secret.
  const stored = run(r.state, { type: "stored", reference: "ks:global/NEW_TOKEN" });
  expect(stored.effects).toEqual([{ type: "reload" }]);
  const withNew = sortSecrets([...secrets, { scope: "global", key: "NEW_TOKEN", reference: "ks:global/NEW_TOKEN", updatedAt: 0 }]);
  const after = run(stored.state, { type: "loaded", secrets: withNew, refs }).state;
  expect(rowsFor(after)[after.lists.secrets.cursor]!.reference).toBe("ks:global/NEW_TOKEN");
  expect(after.status).toEqual({ text: "Stored ks:global/NEW_TOKEN", tone: "info" });
});

test("a new scope, and rejected input that keeps the input open with the CLI's sentence", () => {
  let r = run(loaded(), char("a"), char("j"), char("j"), named("enter"));
  expect(r.state.modal).toMatchObject({ kind: "input", field: "scope" });
  r = run(r.state, ...typed("Bad"), named("enter"));
  expect(r.state.modal).toMatchObject({ field: "scope", error: 'Invalid scope "Bad". Use a lowercase name of letters, digits, . _ or -.' });
  expect(render(r.state, plain)[19]).toContain('Invalid scope "Bad"');
  r = run(r.state, named("backspace"), named("backspace"), named("backspace"), ...typed("billing"), named("enter"));
  expect(r.state.modal).toMatchObject({ field: "key", scope: "billing" });
  r = run(r.state, ...typed("1BAD"), named("enter"));
  expect(r.state.modal).toMatchObject({ field: "key", error: expect.stringContaining('Invalid key "1BAD"') });
  r = run(r.state, named("backspace"), named("backspace"), named("backspace"), named("backspace"), ...typed("KEY"), named("enter"), named("enter"));
  expect(r.state.modal).toMatchObject({ field: "value", error: expect.stringContaining("No value supplied") });
  const long = { type: "key", key: { kind: "char", char: "x".repeat(MAX_VALUE_CHARS + 1) } } as Event;
  r = run(r.state, long, named("enter"));
  expect(r.state.modal).toMatchObject({ field: "value", error: expect.stringContaining("can transport at most") });
  expect(run(r.state, named("esc")).state.modal).toBeNull();
});

test("adding a key that exists asks to replace it, defaulting to No", () => {
  let r = run(loaded(), char("a"), named("enter"), ...typed("OPENAI_API_KEY"), named("enter"), ...typed("v"), named("enter"));
  expect(render(r.state, plain).join("\n")).toContain("ks:global/OPENAI_API_KEY already exists. Replace its value? y/N");
  r = run(r.state, named("enter"));
  expect(r.effects).toEqual([]);
  expect(r.state.modal).toBeNull();
});

test("e edits the value on the row", () => {
  const r = run(loaded(), char("j"), char("e"), ...typed("new-db-value"), named("enter"), named("enter"));
  expect(r.effects).toEqual([{ type: "store", ref: { scope: "web", key: "DATABASE_URL" }, value: "new-db-value" }]);
});

test("d names how many project files use the secret, and defaults to No", () => {
  let r = run(loaded(), char("j"), char("d"));
  expect(render(r.state, plain).join("\n")).toContain("Referenced by 1 project file. Delete ks:web/DATABASE_URL? y/N");
  expect(run(r.state, named("enter")).effects).toEqual([]);
  r = run(r.state, char("y"));
  expect(r.effects).toEqual([{ type: "remove", ref: { scope: "web", key: "DATABASE_URL" } }]);
  expect(run(loaded(), char("d")).state.modal).toMatchObject({ question: "Referenced by no project file. Delete ks:global/OPENAI_API_KEY?" });
  // A folder that could not be read makes the count a lower bound, and says so.
  const partial = update(initialState(90, 20), {
    type: "loaded",
    secrets,
    refs: { ...refs, unreachable: [{ scope: "old", rootPath: "/gone", reason: "the folder no longer exists" }] },
  }).state;
  expect(run(partial, char("d")).state.modal).toMatchObject({
    question: "Referenced by no project file that could be read. Delete ks:global/OPENAI_API_KEY?",
  });
  const removed = run(loaded(), { type: "removed", reference: "ks:web/DATABASE_URL", existed: true });
  expect(removed.state.status).toEqual({ text: "Deleted ks:web/DATABASE_URL", tone: "info" });
  expect(removed.effects).toEqual([{ type: "reload" }]);
});

test("while a modal is open, q and Tab go to it", () => {
  const r = run(loaded(), char("a"), named("enter"), char("q"), named("tab"));
  expect(r.state.quit).toBe(false);
  expect(r.state.screen).toBe("secrets");
  expect(r.state.modal).toMatchObject({ field: "key", text: "q" });
});

test("the data adapter records a reveal before returning the value, and stores and removes", () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-ui-data-"));
  dirs.push(dir);
  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  try {
    const data = vaultData(vault);
    const ref = { scope: "global", key: "A_TOKEN" };
    expect(runEffect({ type: "store", ref, value: "a-value-3" }, data)).toEqual({ type: "stored", reference: "ks:global/A_TOKEN" });
    expect(vault.listAudit(10).filter((e) => e.event === "reveal")).toHaveLength(0);
    expect(runEffect({ type: "reveal", ref }, data)).toEqual({ type: "revealed", reference: "ks:global/A_TOKEN", value: "a-value-3" });
    expect(vault.listAudit(10).filter((e) => e.event === "reveal" && e.key === "A_TOKEN")).toHaveLength(1);
    expect(runEffect({ type: "remove", ref }, data)).toEqual({ type: "removed", reference: "ks:global/A_TOKEN", existed: true });
    // Gone: no value, and no audit row for a reveal that showed nothing.
    expect(runEffect({ type: "reveal", ref }, data)).toEqual({ type: "revealed", reference: "ks:global/A_TOKEN", value: null });
    expect(vault.listAudit(10).filter((e) => e.event === "reveal")).toHaveLength(1);
  } finally {
    vault.close();
  }
});
