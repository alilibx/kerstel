import { expect, test } from "bun:test";
import { analyseScript, scriptState, type ScriptSkipReason, unwireScript, wireScript } from "../src/init/script-shell";

const P = "kerstel exec -- ";

/** The wired text, or a failed test if the script was refused. */
function wired(script: string): string {
  const result = wireScript(script, P);
  if (result.kind !== "wired") throw new Error(`refused: ${result.reason}`);
  return result.text;
}

// --- wiring ---------------------------------------------------------------

test("a simple command gets the prefix in front of its command word", () => {
  expect(wireScript("next dev", P)).toEqual({ kind: "wired", text: "kerstel exec -- next dev", changed: true });
});

test("a leading assignment stays in front of the prefix", () => {
  expect(wireScript("NODE_ENV=production next start", P)).toMatchObject({
    text: "NODE_ENV=production kerstel exec -- next start",
  });
  expect(wireScript("A=1 B='two words' node x.js", P)).toMatchObject({
    text: "A=1 B='two words' kerstel exec -- node x.js",
  });
});

test("every operator splits, and each command is wired on its own", () => {
  expect(wired("node a.js && next dev")).toBe("kerstel exec -- node a.js && kerstel exec -- next dev");
  expect(wired("tsc || node fallback.js")).toBe("kerstel exec -- tsc || kerstel exec -- node fallback.js");
  expect(wired("node a.js; node b.js")).toBe("kerstel exec -- node a.js; kerstel exec -- node b.js");
  expect(wired("node a.js | tee out.log")).toBe("kerstel exec -- node a.js | kerstel exec -- tee out.log");
});

test("operators inside quotes do not split", () => {
  expect(wired('node -e "console.log(1 && 2 || 3; 4 | 5)"')).toBe(
    'kerstel exec -- node -e "console.log(1 && 2 || 3; 4 | 5)"',
  );
  expect(wired("node -e 'a && b'")).toBe("kerstel exec -- node -e 'a && b'");
});

test("an escaped space keeps a word together", () => {
  expect(wired("node my\\ script.js && next dev")).toBe(
    "kerstel exec -- node my\\ script.js && kerstel exec -- next dev",
  );
});

test("everything outside the inserted prefixes is byte-identical", () => {
  const script = "\tnode  a.js   &&\tNODE_ENV=x   next\tdev  ";
  expect(wired(script)).toBe("\tkerstel exec -- node  a.js   &&\tNODE_ENV=x   kerstel exec -- next\tdev  ");
});

test("words that never run JavaScript are left unwrapped", () => {
  expect(wired("rm -rf dist && next build")).toBe("rm -rf dist && kerstel exec -- next build");
  expect(wireScript("echo start; git rev-parse HEAD; docker build .", P)).toEqual({
    kind: "skipped",
    reason: "nothing-to-wire",
  });
});

test("dispatchers that can run JavaScript are wrapped", () => {
  for (const word of ["make", "env", "sh", "bash", "npx", "bunx", "npm", "pnpm", "yarn", "bun"]) {
    expect(wired(`${word} build`)).toBe(`kerstel exec -- ${word} build`);
  }
});

test("a command already prefixed is left alone, and a half-wired script is finished", () => {
  expect(wireScript("kerstel exec -- next dev", P)).toEqual({ kind: "wired", text: "kerstel exec -- next dev", changed: false });
  expect(wireScript("kerstel exec -- node a.js && next dev", P)).toEqual({
    kind: "wired",
    text: "kerstel exec -- node a.js && kerstel exec -- next dev",
    changed: true,
  });
});

test("a script the user wrote that calls kerstel itself is already wired", () => {
  expect(wireScript("kerstel run -- node x.js", P)).toMatchObject({ kind: "wired", changed: false });
});

test("wiring is idempotent", () => {
  const once = wireScript("NODE_ENV=x node a.js && next dev | cat", P);
  expect(once.kind).toBe("wired");
  if (once.kind !== "wired") throw new Error("unreachable");
  expect(wireScript(once.text, P)).toEqual({ kind: "wired", text: once.text, changed: false });
});

// --- skip reasons ---------------------------------------------------------

test.each<[string, ScriptSkipReason]>([
  ["cd apps/web && next dev", "changes-directory"],
  ["pushd x && node a.js", "changes-directory"],
  ["(cd x && node a.js)", "shell-control"],
  ["node a.js `git rev-parse HEAD`", "shell-control"],
  ["node a.js $(cat v)", "shell-control"],
  ["if [ -f x ]; then node a.js; fi", "shell-control"],
  ["for f in *.js; do node $f; done", "shell-control"],
  ["export A=1 && node a.js", "shell-control"],
  ["source ./env.sh && node a.js", "shell-control"],
  [". ./env.sh && node a.js", "shell-control"],
  ["eval node a.js", "shell-control"],
  ["exec node a.js", "shell-control"],
  ["{ node a.js; }", "shell-control"],
  ["node a.js\nnode b.js", "shell-control"],
  ["node a.js > out.log", "redirection"],
  ["node a.js 2>&1", "redirection"],
  ["node a.js < in.txt", "redirection"],
  ["node a.js &> all.log", "redirection"],
  ["node a.js & node b.js", "redirection"],
  ["node -e 'unterminated", "unbalanced-quote"],
  ['node -e "unterminated', "unbalanced-quote"],
  ["A=1", "no-command"],
  ["A=1 B=2", "no-command"],
  ["node a.js &&", "no-command"],
  ["&& node a.js", "no-command"],
  ["node a.js && && node b.js", "no-command"],
  ["", "no-command"],
  ["   ", "no-command"],
])("%j is skipped as %s", (script, reason) => {
  expect(wireScript(script, P)).toEqual({ kind: "skipped", reason });
});

test("a brace inside a word is not shell control", () => {
  expect(wired("node a.js --glob={a,b}")).toBe("kerstel exec -- node a.js --glob={a,b}");
});

test("quoted control characters are not shell control", () => {
  expect(wired("node -e 'x > 1 && (y)' && next dev")).toBe(
    "kerstel exec -- node -e 'x > 1 && (y)' && kerstel exec -- next dev",
  );
});

// --- state, for doctor ------------------------------------------------------

test("scriptState tells wired, partly wired, not wired, and skipped apart", () => {
  expect(scriptState("kerstel exec -- next dev", P)).toEqual({ state: "wired" });
  expect(scriptState("kerstel exec -- node a.js && kerstel exec -- next dev", P)).toEqual({ state: "wired" });
  expect(scriptState("kerstel exec -- node a.js && next dev", P)).toEqual({ state: "partly-wired" });
  expect(scriptState("next dev", P)).toEqual({ state: "not-wired" });
  expect(scriptState("rm -rf dist && kerstel exec -- next build", P)).toEqual({ state: "wired" });
  expect(scriptState("cd x && next dev", P)).toEqual({ state: "skipped", reason: "changes-directory" });
  expect(scriptState("rm -rf dist", P)).toEqual({ state: "skipped", reason: "nothing-to-wire" });
});

// --- unwiring -------------------------------------------------------------

test("unwireScript strips every prefix and nothing else", () => {
  const script = "NODE_ENV=x node a.js && next dev | cat";
  const wired = wireScript(script, P);
  if (wired.kind !== "wired") throw new Error("unreachable");
  expect(unwireScript(wired.text, [P])).toBe(script);
});

test("unwireScript leaves the user's own kerstel call and unprefixed commands alone", () => {
  expect(unwireScript("kerstel run -- node x.js && next dev", [P])).toBe("kerstel run -- node x.js && next dev");
});

test("unwireScript strips any of several prefixes", () => {
  expect(unwireScript("old -- node a.js && new -- next dev", ["old -- ", "new -- "])).toBe("node a.js && next dev");
});

test("unwireScript returns an unparseable script unchanged", () => {
  expect(unwireScript("kerstel exec -- node a.js > out.log", [P])).toBe("kerstel exec -- node a.js > out.log");
});

// --- analysis -------------------------------------------------------------

test("analyseScript reports the offsets of each command word", () => {
  const analysed = analyseScript("A=1 node a.js && next dev");
  expect(analysed).toEqual({
    kind: "ok",
    commands: [
      { commandStart: 4, commandWord: "node" },
      { commandStart: 17, commandWord: "next" },
    ],
  });
});
