# Kerstel `init` Wizard & `exec` Shim — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `kerstel init` turn a project whose `.env` files hold plaintext secrets into a project whose `.env` files hold only `kerstel://` references, wired so that `npm run dev` — unchanged — still sees the real values.

**Architecture:** A new `kerstel exec -- <cmd>` shim opens the CLI context (which installs the hook assets), guarantees a running daemon, injects `KERSTEL_SOCKET` / `KERSTEL_TOKEN` / `KERSTEL_HOOK_DIR` / `NODE_OPTIONS=--require <hook>/preload.cjs` into the child environment, and execs the original command verbatim. `kerstel init` is a consent-per-step wizard built from small pure modules — a byte-exact dotenv parser, a scope deriver, a project detector, a key classifier, an encrypted backup writer, a file wirer and a prompter interface — orchestrated by one command that shows a diff before every write.

**Tech Stack:** TypeScript, Bun (runtime, package manager, test runner, `bun build --compile`), `node:fs`, `node:readline/promises`, `node:crypto` (AES-256-GCM via the existing vault crypto module). No new dependencies — no dotenv library, no TOML library, no diff library, no prompt library.

**Spec:** [`docs/superpowers/specs/2026-09-17-kerstel-secrets-manager-design.md`](../specs/2026-09-17-kerstel-secrets-manager-design.md)

**Scope:** This is plan 2 of 5. It implements spec §8's `kerstel init` wizard (all six steps plus the teammate flow), §6.2's wiring for Node and Bun, the `kerstel exec` shim §6.2 names, and the project half of `doctor`'s §6.3 diagnostics. Out of scope here and deliberately deferred: the portal `ui` (plan 3), the website (plan 4), `install.sh` / release pipeline / `uninstall` (plan 5), and cloud sync plus environments (v3, spec §10).

## Global Constraints

> **Amended 2026-09-18:** the bunfig half of ruling 2 was dropped after implementation; see spec §6.2.

Carried verbatim from plan 1 — every one of these still binds:

- **Language/runtime:** TypeScript throughout. Bun is the only toolchain dependency for building. The shipped artifact is a single self-contained binary per platform (`bun build --compile`).
- **Hook portability:** `packages/hook` must have **zero runtime dependencies** and must run unmodified under Node 18+ and Bun. It may import only `node:` builtins. It is never `npm install`ed — it is written to `~/.kerstel/hook/` by the CLI.
- **Crypto:** AES-256-GCM. 256-bit data key. Fresh random 96-bit (12-byte) nonce per encryption. Auth tag verified on every decrypt.
- **Key storage:** the data key is never written to `~/.kerstel/vault.db` and never logged. It lives in the OS credential store, with an explicit, loudly-warned `0600` file fallback.
- **Reference syntax:** `kerstel://<scope>/<KEY>` where `<scope>` is `global` or a project name. Explicit scoping only — a reference resolves in exactly one scope, with **no fallback chain**.
- **Paths:** `~/.kerstel/` (mode `0700`), vault at `vault.db`, socket at `kerstel.sock`, session token at `session.token` (mode `0600`), hook assets in `hook/`, backups in `backups/`. Every path derives from `KERSTEL_HOME`, which defaults to `~/.kerstel` — tests always override it.
- **Privacy:** no network calls, no telemetry, no analytics, no AI. The binary must function fully offline.
- **Secrets in output:** plaintext values are printed only by `kerstel get --reveal` and injected into child environments. Never logged, never in error messages, never in audit rows.
- **Platforms:** macOS (arm64, x64), Linux (x64, arm64), Windows (x64).
- **License:** MIT. Every new source file is original work.

Added by this plan (the design rulings; every task's requirements implicitly include these):

1. **`exec` never resolves.** `kerstel exec -- <cmd>` builds the child env as `process.env` + `KERSTEL_SOCKET=socketPath()` + `KERSTEL_TOKEN=<ensureToken()>` + `KERSTEL_HOOK_DIR=<ctx.hookDir>` + `NODE_OPTIONS` with ` --require <hookDir>/preload.cjs` appended (JSON-quoted exactly as `packages/hook/src/preload.js:109` does, never duplicated), then spawns the command **verbatim** with inherited stdio and propagates its exit code. References stay references in that env — resolving plaintext is `run`'s job, not `exec`'s.
2. **Wiring.** Node: rewrite every `package.json` script as `kerstel exec -- <original>`, except scripts already starting with `kerstel ` and the npm lifecycle hooks `preinstall`, `install`, `postinstall`, `prepare`, `prepublishOnly`. Key order and formatting are preserved (`JSON.parse` in, 2-space indent out, trailing newline; a source indented with tabs or 4 spaces keeps that indent). Bun: the same script rewrite **plus** a top-level `preload = ["<hookDir>/preload.cjs"]` in `bunfig.toml`, merged into an existing array, created when the file is absent — handled by line edits, no TOML library, leaving every other byte untouched. A `[test]` section's own `preload` is out of scope. Both diffs are shown before writing.
3. **Which files.** Every entry in the project root matching `.env` or `.env.*`, excluding names ending `.example`, `.sample`, `.template`, `.dist`. Parsed by a hand-written parser that preserves comments, blank lines, key order, quoting style (`KEY=value`, `KEY="value"`, `KEY='value'`, `export KEY=value`) and inline `# comments`; rewriting a value changes only the value bytes. Round-trip tests on fixtures are mandatory.
4. **Scope name.** Derived from `package.json` `name`: strip a leading `@org/`, lowercase, replace every character outside `[a-z0-9._-]` with `-`, collapse repeats, trim leading/trailing separators; fall back to the directory basename treated the same way; validated with `isValidScope()` from `reference.ts`; `--scope <name>` overrides. Registered with `vault.registerProject(name, rootPath)`.
5. **Classification.** `suggest(key, value)` returns `"plaintext"` for empty values, booleans (`true/false/yes/no/on/off/1/0`), plain numbers, URLs **without** userinfo, values shorter than 8 characters that are a single lowercase word, and keys matching `NODE_ENV|PORT|HOST|LOG_LEVEL|DEBUG|CI|TZ|LANG|LC_.*|PUBLIC_.*|NEXT_PUBLIC_.*|VITE_.*`; `"global"` for a fixed list of shared-service credentials; `"project"` for everything else, including a URL **with** userinfo. The suggestion is a default the user can change per key; it is applied silently only under `--yes`.
6. **Same KEY in several files.** Precedence `.env.<x>.local` > `.env.local` > `.env.<x>` > `.env`. The highest-precedence value is stored; **every** occurrence is rewritten to the same reference; the lower-precedence values survive only in the encrypted backup; a warning names the files. v1 has no environments — this is the honest v1 behaviour and is documented in the README.
7. **Backup.** Before any rewrite, each original file is encrypted with the vault data key via `encrypt()` and written to `backupsDir()/<scope>/<timestamp>/<filename>.enc`, beside a `manifest.json` carrying filenames, byte sizes and the sha256 of each plaintext — never plaintext itself. `restoreBackup()` exists for tests and for a future `uninstall`. Directories `0700`, files `0600`, non-win32.
8. **Prompts.** One `Prompter` interface (`confirm`, `choose`, `text`) with a TTY implementation (`node:readline/promises`, echo disabled for `secret: true`), a scripted implementation for tests that throws when its answers run out, and a defaults implementation for `--yes` / `--non-interactive`. A question with no default under `--non-interactive` exits 2 naming the flag that would supply it. A plaintext secret is never accepted on argv: teammate values arrive through `text({ secret: true })` or `--from-stdin` JSON.
9. **`init` orchestration.** Spec §8's steps, each printed and consented: detect → parse → classify/prompt per key → register project → backup → store → rewrite `.env*` → wire → offer `.gitignore` (default **no**) → self-check → summary. Flags: `--yes`, `--dry-run`, `--scope <name>`, `--global KEY[,KEY]`, `--keep KEY[,KEY]`, `--non-interactive`, `--from-stdin`. A second run finds only references, reports "already migrated", and re-checks wiring.
10. **`doctor` in a project.** When a `package.json` sits in the working directory, `doctor` also reports the scope, whether scripts are wired, whether the `bunfig.toml` preload is present (Bun projects), and how many `.env*` references exist versus how many the vault can resolve.
11. **Docs.** README gains a "Set up a project" section and an `exec` vs `run` explanation; spec §8 gains one sentence stating the same-KEY precedence rule.
12. **Security.** No plaintext secret in any log, error message, argv, or file other than the encrypted backup. Every step is reversible from the backup. `--dry-run` writes nothing. The two darwin-gated keychain tests stay opt-in. Every test isolates `KERSTEL_HOME` and sets `KERSTEL_KEYCHAIN_BACKEND=file` through `test/helpers/isolate-env.ts`. Every test that starts a daemon stops it.

---

### Task 1: Byte-exact dotenv parser

The wizard rewrites files a developer owns. If a rewrite reflows their comments or drops their quoting, they will never trust it again — so the parser is built to reproduce its input byte for byte, and `setValue` is built to touch only the bytes of one value.

**Files:**
- Create: `packages/cli/src/init/dotenv-file.ts`
- Test: `packages/cli/test/init-dotenv.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Quote = "" | "\"" | "'"`
  - `interface DotenvRaw { kind: "raw"; text: string; eol: string }`
  - `interface DotenvPair { kind: "pair"; text: string; eol: string; key: string; value: string; quote: Quote; valueStart: number; valueEnd: number }`
  - `type DotenvLine = DotenvRaw | DotenvPair`
  - `interface UnsupportedValue { key: string; line: number; reason: string }`
  - `interface DotenvFile { lines: DotenvLine[]; unsupported: UnsupportedValue[] }`
  - `parseDotenv(source: string): DotenvFile`
  - `serializeDotenv(file: DotenvFile): string`
  - `entries(file: DotenvFile): DotenvPair[]`
  - `lookup(file: DotenvFile, key: string): string | null`
  - `setValue(file: DotenvFile, key: string, value: string): number`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/init-dotenv.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  entries,
  lookup,
  parseDotenv,
  serializeDotenv,
  setValue,
} from "../src/init/dotenv-file";

const GNARLY = [
  "# Leading comment",
  "",
  "DATABASE_URL=postgres://user:pw@localhost:5432/app",
  'API_KEY="sk-quoted-value"',
  "LITERAL='single $NOT_EXPANDED'",
  "export EXPORTED=exported-value",
  "  INDENTED=indented-value",
  "WITH_COMMENT=value # trailing note",
  "HASH_IN_VALUE=a#b",
  "EMPTY=",
  "ONLY_COMMENT=# nothing before me",
  "SPACED =  spaced-value  ",
  "not a pair at all",
  "",
].join("\n");

test("parse then serialize is byte-identical", () => {
  expect(serializeDotenv(parseDotenv(GNARLY))).toBe(GNARLY);
});

test("parse then serialize is byte-identical for CRLF and a missing final newline", () => {
  const source = "A=1\r\n# c\r\nB=2";
  expect(serializeDotenv(parseDotenv(source))).toBe(source);
});

test("parse then serialize is byte-identical for mixed line endings", () => {
  const source = "A=1\r\nB=2\nC=3\r\n";
  expect(serializeDotenv(parseDotenv(source))).toBe(source);
});

test("parse then serialize is byte-identical for an empty file", () => {
  expect(serializeDotenv(parseDotenv(""))).toBe("");
  expect(serializeDotenv(parseDotenv("\n"))).toBe("\n");
});

test("values decode per quoting style", () => {
  const file = parseDotenv(GNARLY);
  expect(lookup(file, "DATABASE_URL")).toBe("postgres://user:pw@localhost:5432/app");
  expect(lookup(file, "API_KEY")).toBe("sk-quoted-value");
  expect(lookup(file, "LITERAL")).toBe("single $NOT_EXPANDED");
  expect(lookup(file, "EXPORTED")).toBe("exported-value");
  expect(lookup(file, "INDENTED")).toBe("indented-value");
  expect(lookup(file, "WITH_COMMENT")).toBe("value");
  expect(lookup(file, "HASH_IN_VALUE")).toBe("a#b");
  expect(lookup(file, "EMPTY")).toBe("");
  expect(lookup(file, "ONLY_COMMENT")).toBe("");
  expect(lookup(file, "SPACED")).toBe("spaced-value");
  expect(lookup(file, "MISSING")).toBeNull();
});

test("escape sequences decode inside double quotes only", () => {
  const file = parseDotenv(['DQ="line1\\nline2\\t\\"quoted\\""', "SQ='line1\\nline2'"].join("\n"));
  expect(lookup(file, "DQ")).toBe('line1\nline2\t"quoted"');
  expect(lookup(file, "SQ")).toBe("line1\\nline2");
});

test("entries keeps key order and every occurrence", () => {
  const file = parseDotenv("B=1\nA=2\nB=3\n");
  expect(entries(file).map((e) => e.key)).toEqual(["B", "A", "B"]);
  // dotenv semantics: the last assignment in a file wins.
  expect(lookup(file, "B")).toBe("3");
});

test("setValue rewrites only the value bytes", () => {
  const file = parseDotenv(GNARLY);
  expect(setValue(file, "WITH_COMMENT", "kerstel://app/WITH_COMMENT")).toBe(1);
  const out = serializeDotenv(file);
  expect(out).toContain("WITH_COMMENT=kerstel://app/WITH_COMMENT # trailing note");
  // Everything else survives untouched.
  expect(out).toContain("# Leading comment");
  expect(out).toContain("  INDENTED=indented-value");
  expect(out).toContain("not a pair at all");
});

test("setValue preserves the original quoting style", () => {
  const file = parseDotenv(['A="old"', "B='old'", "C=old", "export D=old"].join("\n"));
  setValue(file, "A", "kerstel://app/A");
  setValue(file, "B", "kerstel://app/B");
  setValue(file, "C", "kerstel://app/C");
  setValue(file, "D", "kerstel://app/D");
  expect(serializeDotenv(file)).toBe(
    ['A="kerstel://app/A"', "B='kerstel://app/B'", "C=kerstel://app/C", "export D=kerstel://app/D"].join("\n"),
  );
});

test("setValue quotes an unquoted value that would otherwise change meaning", () => {
  const file = parseDotenv("A=old\n");
  setValue(file, "A", "has spaces # and a hash");
  expect(serializeDotenv(file)).toBe('A="has spaces # and a hash"\n');
});

test("setValue rewrites every occurrence of a duplicated key", () => {
  const file = parseDotenv("K=one\nOTHER=x\nK=two\n");
  expect(setValue(file, "K", "kerstel://app/K")).toBe(2);
  expect(serializeDotenv(file)).toBe("K=kerstel://app/K\nOTHER=x\nK=kerstel://app/K\n");
});

test("a value whose quote never closes is reported, not parsed", () => {
  const file = parseDotenv('GOOD=1\nMULTI="line one\nstill going"\n');
  expect(file.unsupported.map((u) => u.key)).toEqual(["MULTI"]);
  expect(entries(file).map((e) => e.key)).toEqual(["GOOD"]);
  // And it still round-trips: an unparsed line is carried as raw text.
  expect(serializeDotenv(file)).toBe('GOOD=1\nMULTI="line one\nstill going"\n');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/init-dotenv.test.ts`
Expected: FAIL — cannot resolve module `../src/init/dotenv-file`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/init/dotenv-file.ts`:

```ts
/**
 * A `.env` parser built for ONE property the wizard cannot do without:
 * `parseDotenv` followed by `serializeDotenv` returns the input byte for byte,
 * and `setValue` changes only the bytes of one value. Comments, blank lines,
 * indentation, `export` prefixes, quoting style, inline comments and line
 * endings all survive, because the file belongs to the developer and the
 * wizard is only borrowing it.
 *
 * Deliberately NOT a dotenv implementation: no variable expansion, no
 * multi-line values, no `.env` inheritance. Those belong to whatever loads the
 * file at runtime. This module only has to find values and put references back.
 */

export type Quote = "" | '"' | "'";

export interface DotenvRaw {
  kind: "raw";
  /** The line without its terminator, exactly as read. */
  text: string;
  /** This line's terminator: "\n", "\r\n", or "" for an unterminated last line. */
  eol: string;
}

export interface DotenvPair {
  kind: "pair";
  text: string;
  eol: string;
  key: string;
  /** Decoded value: quotes stripped, double-quoted escapes expanded. */
  value: string;
  quote: Quote;
  /** Offsets into `text` of the value token, including its quotes. */
  valueStart: number;
  valueEnd: number;
}

export type DotenvLine = DotenvRaw | DotenvPair;

export interface UnsupportedValue {
  key: string;
  /** 1-based line number, for a message that points the user at the line. */
  line: number;
  reason: string;
}

export interface DotenvFile {
  lines: DotenvLine[];
  /** Keys this parser deliberately refused to touch. Never contains values. */
  unsupported: UnsupportedValue[];
}

/** Group 1 is the whole prefix up to and including `=`, so offsets are exact. */
const PAIR = /^((\s*)(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=)(.*)$/;

function decodeDoubleQuoted(body: string): string {
  return body.replace(/\\(.)/g, (_match, char: string) => {
    if (char === "n") return "\n";
    if (char === "r") return "\r";
    if (char === "t") return "\t";
    return char;
  });
}

/** Index of the closing quote, or -1 when the line ends first. */
function findClosingQuote(rest: string, open: number, quote: string): number {
  for (let i = open + 1; i < rest.length; i += 1) {
    const char = rest[i];
    if (quote === '"' && char === "\\") {
      i += 1;
      continue;
    }
    if (char === quote) return i;
  }
  return -1;
}

/**
 * Index where an inline comment starts, or `rest.length`. A `#` counts as a
 * comment only at the start of the value or after whitespace, so `a#b` stays
 * the value `a#b` — the convention every dotenv loader in the ecosystem uses.
 */
function findInlineComment(rest: string, from: number): number {
  for (let i = from; i < rest.length; i += 1) {
    if (rest[i] !== "#") continue;
    if (i === from) return i;
    const previous = rest[i - 1];
    if (previous === " " || previous === "\t") return i;
  }
  return rest.length;
}

function parseLine(text: string, eol: string, lineNumber: number, unsupported: UnsupportedValue[]): DotenvLine {
  const match = PAIR.exec(text);
  if (!match) return { kind: "raw", text, eol };

  const prefix = match[1] ?? "";
  const key = match[4] ?? "";
  const rest = match[5] ?? "";

  let i = 0;
  while (i < rest.length && (rest[i] === " " || rest[i] === "\t")) i += 1;
  const head = rest[i];

  if (head === '"' || head === "'") {
    const closing = findClosingQuote(rest, i, head);
    if (closing === -1) {
      // A multi-line quoted value. Refusing to parse it means refusing to
      // rewrite it, which is the safe half of the choice: the key keeps its
      // plaintext and `init` says so, rather than writing a mangled file.
      unsupported.push({
        key,
        line: lineNumber,
        reason: "the value opens a quote that does not close on the same line",
      });
      return { kind: "raw", text, eol };
    }
    const body = rest.slice(i + 1, closing);
    return {
      kind: "pair",
      text,
      eol,
      key,
      value: head === '"' ? decodeDoubleQuoted(body) : body,
      quote: head,
      valueStart: prefix.length + i,
      valueEnd: prefix.length + closing + 1,
    };
  }

  const commentAt = findInlineComment(rest, i);
  const trimmed = rest.slice(i, commentAt).replace(/[ \t]+$/, "");
  return {
    kind: "pair",
    text,
    eol,
    key,
    value: trimmed,
    quote: "",
    valueStart: prefix.length + i,
    valueEnd: prefix.length + i + trimmed.length,
  };
}

/**
 * Splits with the terminators CAPTURED, so each line carries its own ending.
 * A file that mixes "\r\n" and "\n" — every repository with more than one
 * contributor on more than one OS — still round-trips exactly.
 */
export function parseDotenv(source: string): DotenvFile {
  const parts = source.split(/(\r\n|\n)/);
  const lines: DotenvLine[] = [];
  const unsupported: UnsupportedValue[] = [];

  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    const eol = parts[i + 1] ?? "";
    // split() leaves an empty final piece after a trailing terminator. Keeping
    // it would append a phantom empty line on every serialize.
    if (i > 0 && text === "" && eol === "") break;
    lines.push(parseLine(text, eol, i / 2 + 1, unsupported));
  }

  return { lines, unsupported };
}

export function serializeDotenv(file: DotenvFile): string {
  let out = "";
  for (const line of file.lines) out += line.text + line.eol;
  return out;
}

export function entries(file: DotenvFile): DotenvPair[] {
  return file.lines.filter((line): line is DotenvPair => line.kind === "pair");
}

/** The effective value of a key: the LAST assignment wins, as dotenv does. */
export function lookup(file: DotenvFile, key: string): string | null {
  let found: string | null = null;
  for (const pair of entries(file)) {
    if (pair.key === key) found = pair.value;
  }
  return found;
}

function renderValue(value: string, quote: Quote): string {
  if (quote === '"') {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n");
    return `"${escaped}"`;
  }
  if (quote === "'") {
    // Single quotes have no escape mechanism, so a value containing one has to
    // change style rather than produce a file that no longer parses.
    if (!value.includes("'") && !value.includes("\n") && !value.includes("\r")) return `'${value}'`;
    return renderValue(value, '"');
  }
  if (value === "") return "";
  if (/[\s#"'\\]/.test(value)) return renderValue(value, '"');
  return value;
}

/**
 * Replaces the value of EVERY assignment of `key` and returns how many were
 * rewritten. Every occurrence, not just the effective one: a key assigned
 * twice in one file would otherwise keep plaintext on the losing line, which
 * is exactly the thing this product exists to remove.
 */
export function setValue(file: DotenvFile, key: string, value: string): number {
  let count = 0;
  for (let i = 0; i < file.lines.length; i += 1) {
    const line = file.lines[i];
    if (!line || line.kind !== "pair" || line.key !== key) continue;

    const rendered = renderValue(value, line.quote);
    const text = line.text.slice(0, line.valueStart) + rendered + line.text.slice(line.valueEnd);
    file.lines[i] = {
      ...line,
      text,
      value,
      valueStart: line.valueStart,
      valueEnd: line.valueStart + rendered.length,
    };
    count += 1;
  }
  return count;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/test/init-dotenv.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/dotenv-file.ts packages/cli/test/init-dotenv.test.ts
git commit -m "feat(cli): add a byte-exact dotenv parser for the init wizard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Scope derivation

**Files:**
- Create: `packages/cli/src/init/project-name.ts`
- Test: `packages/cli/test/init-project-name.test.ts`

**Interfaces:**
- Consumes: `isValidScope(scope: string): boolean` from `packages/cli/src/reference.ts`.
- Produces:
  - `slugifyScope(input: string): string`
  - `interface DerivedScope { scope: string; source: "package.json" | "directory" }`
  - `deriveScope(options: { packageName: string | null; rootPath: string }): DerivedScope` — throws when neither candidate yields a valid scope.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/init-project-name.test.ts`:

```ts
import { expect, test } from "bun:test";
import { deriveScope, slugifyScope } from "../src/init/project-name";
import { isValidScope } from "../src/reference";

const CASES: [input: string, expected: string][] = [
  ["kerstel", "kerstel"],
  ["@acme/web", "web"],
  ["@acme/My_App", "my_app"],
  ["My App!!", "my-app"],
  ["---weird---", "weird"],
  [".hidden.", "hidden"],
  ["_leading_underscore", "leading_underscore"],
  ["a//b", "a-b"],
  ["Über Projekt", "ber-projekt"],
  ["123", "123"],
  ["next.js-app", "next.js-app"],
  ["  spaced  ", "spaced"],
];

test("slugifyScope produces valid scopes", () => {
  for (const [input, expected] of CASES) {
    expect(slugifyScope(input)).toBe(expected);
    expect(isValidScope(expected)).toBe(true);
  }
});

test("slugifyScope truncates to the 64-character scope limit", () => {
  const slug = slugifyScope("x".repeat(200));
  expect(slug.length).toBe(64);
  expect(isValidScope(slug)).toBe(true);
});

test("slugifyScope returns an empty string when nothing usable is left", () => {
  expect(slugifyScope("///")).toBe("");
  expect(slugifyScope("")).toBe("");
});

test("deriveScope prefers the package.json name", () => {
  expect(deriveScope({ packageName: "@acme/web", rootPath: "/tmp/some-dir" })).toEqual({
    scope: "web",
    source: "package.json",
  });
});

test("deriveScope falls back to the directory basename", () => {
  expect(deriveScope({ packageName: null, rootPath: "/tmp/My Project" })).toEqual({
    scope: "my-project",
    source: "directory",
  });
  expect(deriveScope({ packageName: "@acme/", rootPath: "/tmp/fallback-dir" })).toEqual({
    scope: "fallback-dir",
    source: "directory",
  });
});

test("deriveScope throws when neither candidate is usable", () => {
  expect(() => deriveScope({ packageName: null, rootPath: "/" })).toThrow(/--scope/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/init-project-name.test.ts`
Expected: FAIL — cannot resolve module `../src/init/project-name`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/init/project-name.ts`:

```ts
import { basename } from "node:path";
import { isValidScope } from "../reference";

const MAX_SCOPE_CHARS = 64;

/**
 * Turns a package or directory name into a scope that `isValidScope()`
 * accepts: `^[a-z0-9][a-z0-9._-]*$`, at most 64 characters.
 *
 * Returns "" when nothing usable survives, so the caller decides what to do
 * about it rather than being handed an invalid scope that fails later, deeper.
 */
export function slugifyScope(input: string): string {
  // An npm scope (`@acme/web`) names an org, not this project. Keep the part
  // that actually identifies the package.
  const withoutOrg = input.includes("/") ? (input.split("/").pop() ?? "") : input;

  let slug = withoutOrg
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".");

  // Trim every separator from both ends, not only "-" and ".": a leading "_"
  // passes the character class but fails the first-character rule, and a scope
  // that fails validation this late is a crash three steps from its cause.
  slug = slug.replace(/^[._-]+/, "").replace(/[._-]+$/, "");

  if (slug.length > MAX_SCOPE_CHARS) {
    slug = slug.slice(0, MAX_SCOPE_CHARS).replace(/[._-]+$/, "");
  }

  return isValidScope(slug) ? slug : "";
}

export interface DerivedScope {
  scope: string;
  source: "package.json" | "directory";
}

/**
 * The project's vault scope. `package.json` `name` first because it is what
 * the developer already calls this project; the directory basename second
 * because a private project often has no name at all.
 */
export function deriveScope(options: { packageName: string | null; rootPath: string }): DerivedScope {
  if (options.packageName) {
    const fromPackage = slugifyScope(options.packageName);
    if (fromPackage) return { scope: fromPackage, source: "package.json" };
  }

  const fromDirectory = slugifyScope(basename(options.rootPath));
  if (fromDirectory) return { scope: fromDirectory, source: "directory" };

  throw new Error(
    `Kerstel could not derive a project name from "${options.packageName ?? ""}" or the directory ` +
      `"${options.rootPath}". Pass one explicitly: kerstel init --scope <name>`,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/test/init-project-name.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/project-name.ts packages/cli/test/init-project-name.test.ts
git commit -m "feat(cli): derive a vault scope from a project's name or directory

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Project detection and `.env` discovery

**Files:**
- Create: `packages/cli/src/init/detect.ts`
- Test: `packages/cli/test/init-detect.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type PackageManager = "npm" | "pnpm" | "yarn" | "bun"`
  - `type Runtime = "node" | "bun"`
  - `interface EnvFileInfo { name: string; path: string; rank: number }`
  - `interface DetectedProject { root: string; runtime: Runtime; packageManager: PackageManager; packageJsonPath: string; packageJson: Record<string, unknown> | null; packageName: string | null; envFiles: EnvFileInfo[] }`
  - `isEnvFileName(name: string): boolean`
  - `envFileRank(name: string): number`
  - `discoverEnvFiles(root: string): EnvFileInfo[]` — highest precedence first
  - `detectPackageManager(root: string, packageJson: Record<string, unknown> | null): PackageManager`
  - `detectProject(root: string): DetectedProject`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/init-detect.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPackageManager,
  detectProject,
  discoverEnvFiles,
  envFileRank,
  isEnvFileName,
} from "../src/init/detect";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-detect-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return root;
}

test("isEnvFileName accepts .env and its variants and rejects templates", () => {
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    expect(isEnvFileName(name)).toBe(true);
  }
  for (const name of [
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
    ".environment",
    "env",
    ".envrc",
    "package.json",
  ]) {
    expect(isEnvFileName(name)).toBe(false);
  }
});

test("envFileRank implements the documented precedence", () => {
  expect(envFileRank(".env.production.local")).toBeGreaterThan(envFileRank(".env.local"));
  expect(envFileRank(".env.local")).toBeGreaterThan(envFileRank(".env.production"));
  expect(envFileRank(".env.production")).toBeGreaterThan(envFileRank(".env"));
});

test("discoverEnvFiles returns the highest-precedence file first", () => {
  const root = project({
    ".env": "A=1",
    ".env.local": "A=2",
    ".env.production": "A=3",
    ".env.production.local": "A=4",
    ".env.example": "A=",
    "package.json": "{}",
  });
  expect(discoverEnvFiles(root).map((f) => f.name)).toEqual([
    ".env.production.local",
    ".env.local",
    ".env.production",
    ".env",
  ]);
});

test("discoverEnvFiles ignores directories named like env files", () => {
  const root = project({ ".env": "A=1" });
  mkdirSync(join(root, ".env.d"));
  expect(discoverEnvFiles(root).map((f) => f.name)).toEqual([".env"]);
});

test("discoverEnvFiles returns nothing for a project without env files", () => {
  expect(discoverEnvFiles(project({ "package.json": "{}" }))).toEqual([]);
});

test("lockfiles decide the package manager, in the documented order", () => {
  expect(detectPackageManager(project({ "bun.lock": "" }), null)).toBe("bun");
  expect(detectPackageManager(project({ "bun.lockb": "" }), null)).toBe("bun");
  expect(detectPackageManager(project({ "pnpm-lock.yaml": "" }), null)).toBe("pnpm");
  expect(detectPackageManager(project({ "yarn.lock": "" }), null)).toBe("yarn");
  expect(detectPackageManager(project({ "package-lock.json": "" }), null)).toBe("npm");
  // Bun wins when a repo carries more than one lockfile.
  expect(detectPackageManager(project({ "bun.lock": "", "package-lock.json": "" }), null)).toBe("bun");
});

test("the packageManager field decides when no lockfile does", () => {
  const root = project({ "package.json": "{}" });
  expect(detectPackageManager(root, { packageManager: "pnpm@9.1.0" })).toBe("pnpm");
  expect(detectPackageManager(root, { packageManager: "yarn@4.2.2" })).toBe("yarn");
  expect(detectPackageManager(root, { packageManager: "bun@1.1.0" })).toBe("bun");
  expect(detectPackageManager(root, { packageManager: "who-knows@1" })).toBe("npm");
  expect(detectPackageManager(root, null)).toBe("npm");
});

test("detectProject reads the package name and maps bun to the bun runtime", () => {
  const root = project({
    "package.json": JSON.stringify({ name: "@acme/web", scripts: { dev: "vite" } }),
    "bun.lock": "",
    ".env": "A=1",
  });
  const detected = detectProject(root);
  expect(detected.root).toBe(root);
  expect(detected.packageName).toBe("@acme/web");
  expect(detected.packageManager).toBe("bun");
  expect(detected.runtime).toBe("bun");
  expect(detected.envFiles.map((f) => f.name)).toEqual([".env"]);
  expect(detected.packageJsonPath).toBe(join(root, "package.json"));
});

test("detectProject reports a missing or unreadable package.json as null", () => {
  expect(detectProject(project({ ".env": "A=1" })).packageJson).toBeNull();
  expect(detectProject(project({ "package.json": "{ not json" })).packageJson).toBeNull();
});

test("a non-bun project is a node project", () => {
  const root = project({ "package.json": JSON.stringify({ name: "web" }), "pnpm-lock.yaml": "" });
  const detected = detectProject(root);
  expect(detected.packageManager).toBe("pnpm");
  expect(detected.runtime).toBe("node");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/init-detect.test.ts`
Expected: FAIL — cannot resolve module `../src/init/detect`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/init/detect.ts`:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type Runtime = "node" | "bun";

export interface EnvFileInfo {
  /** File name, e.g. ".env.production.local". */
  name: string;
  path: string;
  /** Higher wins when the same KEY appears in several files. */
  rank: number;
}

export interface DetectedProject {
  root: string;
  runtime: Runtime;
  packageManager: PackageManager;
  packageJsonPath: string;
  /** Parsed package.json, or null when it is missing or not valid JSON. */
  packageJson: Record<string, unknown> | null;
  packageName: string | null;
  /** `.env*` files in the root, highest precedence first. */
  envFiles: EnvFileInfo[];
}

/** Names that are templates for humans, never sources of real values. */
const TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"];

export function isEnvFileName(name: string): boolean {
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  if (name === ".env.") return false;
  return !TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Spec §8 / ruling 6 precedence, highest first:
 *   .env.<x>.local (3) > .env.local (2) > .env.<x> (1) > .env (0)
 *
 * v1 has no environments, so this decides only which duplicate value is the
 * one stored in the vault. It is the convention Next.js, Vite and CRA all
 * follow, so it is the one a developer already expects.
 */
export function envFileRank(name: string): number {
  if (name === ".env") return 0;
  if (name === ".env.local") return 2;
  if (name.endsWith(".local")) return 3;
  return 1;
}

export function discoverEnvFiles(root: string): EnvFileInfo[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }

  const found: EnvFileInfo[] = [];
  for (const name of names) {
    if (!isEnvFileName(name)) continue;
    const path = join(root, name);
    try {
      // A directory called `.env.d` is a real thing in some setups; reading it
      // as a file would throw EISDIR halfway through the wizard.
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    found.push({ name, path, rank: envFileRank(name) });
  }

  // Rank descending, then name ascending so the order is stable across
  // filesystems that do not enumerate in a fixed order.
  return found.sort((a, b) => (b.rank - a.rank) || a.name.localeCompare(b.name));
}

const LOCKFILES: ReadonlyArray<readonly [file: string, manager: PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export function detectPackageManager(
  root: string,
  packageJson: Record<string, unknown> | null,
): PackageManager {
  for (const [file, manager] of LOCKFILES) {
    if (existsSync(join(root, file))) return manager;
  }

  // Corepack's `packageManager: "pnpm@9.1.0"`. Present in repos that keep
  // lockfiles out of git, which is exactly when the loop above finds nothing.
  const field = packageJson?.packageManager;
  if (typeof field === "string") {
    const name = field.split("@")[0];
    if (name === "bun" || name === "pnpm" || name === "yarn" || name === "npm") return name;
  }

  return "npm";
}

function readPackageJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // Missing, unreadable, or malformed. The caller reports it; a malformed
    // package.json must not crash `init` before it can say which file is wrong.
    return null;
  }
}

export function detectProject(root: string): DetectedProject {
  const packageJsonPath = join(root, "package.json");
  const packageJson = readPackageJson(packageJsonPath);
  const packageManager = detectPackageManager(root, packageJson);
  const name = packageJson?.name;

  return {
    root,
    runtime: packageManager === "bun" ? "bun" : "node",
    packageManager,
    packageJsonPath,
    packageJson,
    packageName: typeof name === "string" && name.length > 0 ? name : null,
    envFiles: discoverEnvFiles(root),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/test/init-detect.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/detect.ts packages/cli/test/init-detect.test.ts
git commit -m "feat(cli): detect runtime, package manager and .env files for init

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Key classification

The suggestion the wizard offers per key. It is a **default**, never a decision: `init` shows it and the user overrides it, except under `--yes` where the defaults are accepted wholesale by the user's own explicit choice of flag.

**Files:**
- Create: `packages/cli/src/init/classify.ts`
- Test: `packages/cli/test/init-classify.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Suggestion = "project" | "global" | "plaintext"`
  - `const GLOBAL_KEYS: readonly string[]`
  - `const SUGGESTIONS: readonly Suggestion[]` — the three choices, in the order the wizard offers them
  - `suggest(key: string, value: string): Suggestion`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/init-classify.test.ts`:

```ts
import { expect, test } from "bun:test";
import { GLOBAL_KEYS, type Suggestion, suggest } from "../src/init/classify";

const CASES: [key: string, value: string, expected: Suggestion][] = [
  // Plaintext: nothing worth encrypting.
  ["EMPTY", "", "plaintext"],
  ["BLANK", "   ", "plaintext"],
  ["ENABLE_X", "true", "plaintext"],
  ["ENABLE_Y", "FALSE", "plaintext"],
  ["FLAG_ON", "on", "plaintext"],
  ["ZERO", "0", "plaintext"],
  ["RETRIES", "3", "plaintext"],
  ["RATIO", "-1.5", "plaintext"],
  ["API_BASE", "https://api.example.com/v1", "plaintext"],
  ["REDIS_URL", "redis://localhost:6379", "plaintext"],
  ["SHORT_WORD", "local", "plaintext"],
  ["NODE_ENV", "development", "plaintext"],
  ["PORT", "3000", "plaintext"],
  ["HOST", "0.0.0.0", "plaintext"],
  ["LOG_LEVEL", "debug", "plaintext"],
  ["DEBUG", "app:*", "plaintext"],
  ["CI", "true", "plaintext"],
  ["TZ", "Europe/Berlin", "plaintext"],
  ["LANG", "en_US.UTF-8", "plaintext"],
  ["LC_ALL", "en_US.UTF-8", "plaintext"],
  ["PUBLIC_SITE_NAME", "Kerstel", "plaintext"],
  ["NEXT_PUBLIC_ANALYTICS_ID", "G-ABCDEFGHIJ", "plaintext"],
  ["VITE_API_URL", "https://api.example.com", "plaintext"],
  // Global: shared-service credentials that follow the developer, not the app.
  ["OPENAI_API_KEY", "sk-proj-abcdef1234567890", "global"],
  ["ANTHROPIC_API_KEY", "sk-ant-abcdef1234567890", "global"],
  ["GITHUB_TOKEN", "ghp_abcdef1234567890", "global"],
  ["AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "global"],
  ["STRIPE_SECRET_KEY", "sk_live_abcdef1234567890", "global"],
  // Project: everything else, including a URL that carries credentials.
  ["DATABASE_URL", "postgres://user:pass@db.internal:5432/app", "project"],
  ["SESSION_SECRET", "e3b0c44298fc1c149afbf4c8996fb924", "project"],
  ["INTERNAL_WEBHOOK_SECRET", "whsec_abcdefghijklmnop", "project"],
  ["ADMIN_PASSWORD", "hunter2hunter2", "project"],
  ["SMTP_URL", "smtps://postmaster:pw@smtp.example.com:465", "project"],
];

test("suggest classifies every documented case", () => {
  for (const [key, value, expected] of CASES) {
    expect(`${key}=${suggest(key, value)}`).toBe(`${key}=${expected}`);
  }
});

test("an empty value never becomes a stored secret, even for a global key", () => {
  expect(suggest("OPENAI_API_KEY", "")).toBe("plaintext");
});

test("the global list is exactly the documented set", () => {
  expect([...GLOBAL_KEYS].sort()).toEqual(
    [
      "ANTHROPIC_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "GEMINI_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GOOGLE_API_KEY",
      "HF_TOKEN",
      "NPM_TOKEN",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "REPLICATE_API_TOKEN",
      "SENDGRID_API_KEY",
      "STRIPE_SECRET_KEY",
      "TWILIO_AUTH_TOKEN",
    ].sort(),
  );
});

test("a long opaque value under an unknown key stays with the project", () => {
  expect(suggest("SOME_VENDOR_SECRET", "a7Xq02LmNp93ZtRv")).toBe("project");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/init-classify.test.ts`
Expected: FAIL — cannot resolve module `../src/init/classify`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/init/classify.ts`:

```ts
/**
 * What the wizard SUGGESTS for a key. Never what it decides: `init` prints the
 * suggestion, the user changes it per key, and only `--yes` accepts the whole
 * set — which is the user asking for exactly that.
 *
 * The bias is deliberate: guessing "plaintext" for a real secret is the one
 * mistake that leaves a secret in a file, so every plaintext rule below is
 * shape-based and narrow (a boolean, a number, a URL with no credentials in
 * it), and anything ambiguous falls through to "project".
 */

export type Suggestion = "project" | "global" | "plaintext";

/** The three choices, in the order the wizard offers them. */
export const SUGGESTIONS: readonly Suggestion[] = ["project", "global", "plaintext"];

/**
 * Credentials for services a developer holds ONE account with, across every
 * project on the machine. Pointing a project at the global copy is the
 * one-keystroke choice spec §5 asks for.
 */
export const GLOBAL_KEYS: readonly string[] = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "HF_TOKEN",
  "REPLICATE_API_TOKEN",
  "STRIPE_SECRET_KEY",
  "SENDGRID_API_KEY",
  "TWILIO_AUTH_TOKEN",
];

/** Keys whose values are configuration, not credentials, by convention. */
const PLAINTEXT_KEYS =
  /^(NODE_ENV|PORT|HOST|LOG_LEVEL|DEBUG|CI|TZ|LANG|LC_.*|PUBLIC_.*|NEXT_PUBLIC_.*|VITE_.*)$/;

const BOOLEANS = new Set(["true", "false", "yes", "no", "on", "off", "1", "0"]);
const NUMBER = /^-?\d+(\.\d+)?$/;
const URL_HEAD = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
const SINGLE_LOWERCASE_WORD = /^[a-z]+$/;

/**
 * True for `https://api.example.com/v1`, false for
 * `postgres://user:pass@host/db` — the credentials in the second are exactly
 * what the vault is for.
 */
function isCredentiallessUrl(value: string): boolean {
  const match = URL_HEAD.exec(value);
  if (!match) return false;
  const authority = match[2] ?? "";
  return !authority.includes("@");
}

export function suggest(key: string, value: string): Suggestion {
  const trimmed = value.trim();

  if (trimmed === "") return "plaintext";
  if (BOOLEANS.has(trimmed.toLowerCase())) return "plaintext";
  if (NUMBER.test(trimmed)) return "plaintext";
  if (isCredentiallessUrl(trimmed)) return "plaintext";
  if (trimmed.length < 8 && SINGLE_LOWERCASE_WORD.test(trimmed)) return "plaintext";
  if (PLAINTEXT_KEYS.test(key)) return "plaintext";

  if (GLOBAL_KEYS.includes(key)) return "global";

  return "project";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/test/init-classify.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/classify.ts packages/cli/test/init-classify.test.ts
git commit -m "feat(cli): suggest a scope per key for the init wizard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Encrypted backups

Spec §13's mitigation for "wizard rewrites user files". Nothing else in this plan writes to a file the developer owns until this exists.

**Files:**
- Create: `packages/cli/src/init/backup.ts`
- Test: `packages/cli/test/init-backup.test.ts`

**Interfaces:**
- Consumes: `backupsDir(): string` from `packages/cli/src/paths.ts`; `encrypt(plaintext: string, key: Buffer): EncryptedValue` and `decrypt(value: EncryptedValue, key: Buffer): string` from `packages/cli/src/vault/crypto.ts` (`EncryptedValue` is `{ ciphertext: Buffer; nonce: Buffer }`, the ciphertext carrying the 16-byte GCM tag).
- Produces:
  - `interface BackupFileEntry { name: string; bytes: number; sha256: string }`
  - `interface BackupManifest { version: 1; scope: string; timestamp: string; createdAt: number; files: BackupFileEntry[] }`
  - `interface BackupResult { dir: string; timestamp: string; files: BackupFileEntry[] }`
  - `backupTimestamp(now?: Date): string`
  - `createBackup(options: { scope: string; dataKey: Buffer; files: { name: string; contents: string }[]; timestamp?: string }): BackupResult`
  - `listBackups(scope: string): string[]` — timestamps, newest last
  - `restoreBackup(scope: string, timestamp: string, targetDir: string, dataKey: Buffer): string[]` — written paths

- [ ] **Step 1: Write the failing test**

`packages/cli/test/init-backup.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupTimestamp, createBackup, listBackups, restoreBackup } from "../src/init/backup";
import { backupsDir } from "../src/paths";
import { generateDataKey } from "../src/vault/crypto";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

afterEach(() => {
  restoreEnv();
});

const FILES = [
  { name: ".env", contents: "OPENAI_API_KEY=sk-PLAINTEXT-CANARY\n# a comment\n" },
  { name: ".env.local", contents: "DATABASE_URL=postgres://u:PLAINTEXT-PW@localhost/db\n" },
];

test("backupTimestamp is filesystem-safe", () => {
  const stamp = backupTimestamp(new Date("2026-09-18T11:22:33.444Z"));
  expect(stamp).toBe("2026-09-18T11-22-33.444Z");
  expect(stamp).not.toContain(":");
});

test("createBackup then restoreBackup round-trips the originals", () => {
  isolateEnv({ prefix: "backup" });
  const key = generateDataKey();

  const result = createBackup({ scope: "my-app", dataKey: key, files: FILES });
  expect(result.files.map((f) => f.name)).toEqual([".env", ".env.local"]);
  expect(result.dir).toBe(join(backupsDir(), "my-app", result.timestamp));

  const target = mkdtempSync(join(tmpdir(), "kerstel-restore-"));
  const written = restoreBackup("my-app", result.timestamp, target, key);
  expect(written.sort()).toEqual([join(target, ".env"), join(target, ".env.local")].sort());
  for (const file of FILES) {
    expect(readFileSync(join(target, file.name), "utf8")).toBe(file.contents);
  }
});

test("nothing on disk holds the plaintext", () => {
  isolateEnv({ prefix: "backup-enc" });
  const result = createBackup({ scope: "my-app", dataKey: generateDataKey(), files: FILES });

  for (const name of readdirSync(result.dir)) {
    const raw = readFileSync(join(result.dir, name));
    expect(raw.includes(Buffer.from("PLAINTEXT-CANARY"))).toBe(false);
    expect(raw.includes(Buffer.from("PLAINTEXT-PW"))).toBe(false);
  }
});

test("the manifest records sizes and hashes, never contents", () => {
  isolateEnv({ prefix: "backup-manifest" });
  const result = createBackup({ scope: "my-app", dataKey: generateDataKey(), files: FILES });

  const manifest = JSON.parse(readFileSync(join(result.dir, "manifest.json"), "utf8")) as {
    version: number;
    scope: string;
    files: { name: string; bytes: number; sha256: string }[];
  };
  expect(manifest.version).toBe(1);
  expect(manifest.scope).toBe("my-app");
  expect(manifest.files[0]?.name).toBe(".env");
  expect(manifest.files[0]?.bytes).toBe(Buffer.byteLength(FILES[0]!.contents));
  expect(manifest.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("restoring with the wrong key fails instead of writing garbage", () => {
  isolateEnv({ prefix: "backup-wrongkey" });
  const result = createBackup({ scope: "my-app", dataKey: generateDataKey(), files: FILES });
  const target = mkdtempSync(join(tmpdir(), "kerstel-restore-bad-"));
  expect(() => restoreBackup("my-app", result.timestamp, target, generateDataKey())).toThrow();
  expect(readdirSync(target)).toEqual([]);
});

test("listBackups returns this scope's timestamps, oldest first", () => {
  isolateEnv({ prefix: "backup-list" });
  const key = generateDataKey();
  createBackup({ scope: "my-app", dataKey: key, files: FILES, timestamp: "2026-01-01T00-00-00.000Z" });
  createBackup({ scope: "my-app", dataKey: key, files: FILES, timestamp: "2026-02-01T00-00-00.000Z" });
  createBackup({ scope: "other", dataKey: key, files: FILES, timestamp: "2026-03-01T00-00-00.000Z" });

  expect(listBackups("my-app")).toEqual(["2026-01-01T00-00-00.000Z", "2026-02-01T00-00-00.000Z"]);
  expect(listBackups("nobody")).toEqual([]);
});

test.if(process.platform !== "win32")("backups are owner-only", () => {
  isolateEnv({ prefix: "backup-perms" });
  const result = createBackup({ scope: "my-app", dataKey: generateDataKey(), files: FILES });

  expect(statSync(result.dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(result.dir, ".env.enc")).mode & 0o777).toBe(0o600);
  expect(statSync(join(result.dir, "manifest.json")).mode & 0o777).toBe(0o600);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/init-backup.test.ts`
Expected: FAIL — cannot resolve module `../src/init/backup`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/init/backup.ts`:

```ts
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupsDir } from "../paths";
import { decrypt, encrypt } from "../vault/crypto";

/**
 * The undo for everything `init` rewrites (spec §13). Originals are encrypted
 * with the vault data key, so a backup of a plaintext `.env` does not quietly
 * become a second plaintext copy of every secret the wizard just removed.
 *
 * On-disk layout:
 *   ~/.kerstel/backups/<scope>/<timestamp>/<original name>.enc
 *   ~/.kerstel/backups/<scope>/<timestamp>/manifest.json
 *
 * The manifest is plaintext ON PURPOSE and carries no file contents: names,
 * byte counts and sha256 digests only, so `doctor` and a future `uninstall`
 * can list and verify backups without unlocking the vault.
 *
 * Blob format: the 12-byte nonce, then the ciphertext with its GCM tag. One
 * file, one encryption, no framing to get wrong.
 */

const NONCE_BYTES = 12;

export interface BackupFileEntry {
  name: string;
  /** Byte length of the PLAINTEXT original. */
  bytes: number;
  /** sha256 of the plaintext original, hex. Proves a restore is faithful. */
  sha256: string;
}

export interface BackupManifest {
  version: 1;
  scope: string;
  timestamp: string;
  createdAt: number;
  files: BackupFileEntry[];
}

export interface BackupResult {
  dir: string;
  timestamp: string;
  files: BackupFileEntry[];
}

/** An ISO timestamp with the colons replaced, so it is a legal path segment. */
export function backupTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/:/g, "-");
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // mkdirSync's `mode` applies only on creation and is masked by the umask
  // even then, so assert it every time -- the same rule ensureHome() follows.
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function writePrivate(path: string, data: Buffer | string): void {
  writeFileSync(path, data, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function createBackup(options: {
  scope: string;
  dataKey: Buffer;
  files: { name: string; contents: string }[];
  timestamp?: string;
}): BackupResult {
  const timestamp = options.timestamp ?? backupTimestamp();
  const dir = join(backupsDir(), options.scope, timestamp);
  ensureDir(dir);

  const entries: BackupFileEntry[] = [];
  for (const file of options.files) {
    const { ciphertext, nonce } = encrypt(file.contents, options.dataKey);
    writePrivate(join(dir, `${file.name}.enc`), Buffer.concat([nonce, ciphertext]));
    entries.push({
      name: file.name,
      bytes: Buffer.byteLength(file.contents),
      sha256: createHash("sha256").update(file.contents, "utf8").digest("hex"),
    });
  }

  const manifest: BackupManifest = {
    version: 1,
    scope: options.scope,
    timestamp,
    createdAt: Date.now(),
    files: entries,
  };
  writePrivate(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return { dir, timestamp, files: entries };
}

export function listBackups(scope: string): string[] {
  const dir = join(backupsDir(), scope);
  if (!existsSync(dir)) return [];
  try {
    // Timestamps are ISO, so lexicographic order is chronological order.
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Writes one backup's originals into `targetDir`.
 *
 * Every file is decrypted BEFORE anything is written: a wrong key or a
 * corrupted blob must fail with nothing half-restored, because the thing being
 * overwritten is the developer's live `.env`.
 *
 * Reserved for `uninstall` (plan 5) and used by tests today -- which is why it
 * ships now, with the encrypt path it is the inverse of.
 */
export function restoreBackup(
  scope: string,
  timestamp: string,
  targetDir: string,
  dataKey: Buffer,
): string[] {
  const dir = join(backupsDir(), scope, timestamp);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No Kerstel backup at ${dir}. Run \`kerstel doctor\` to see what is there.`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  const restored: { path: string; contents: string }[] = [];

  for (const entry of manifest.files) {
    const blob = readFileSync(join(dir, `${entry.name}.enc`));
    const contents = decrypt(
      { nonce: blob.subarray(0, NONCE_BYTES), ciphertext: blob.subarray(NONCE_BYTES) },
      dataKey,
    );
    const digest = createHash("sha256").update(contents, "utf8").digest("hex");
    if (digest !== entry.sha256) {
      throw new Error(
        `Kerstel backup ${timestamp} is corrupt: ${entry.name} does not match its recorded hash.`,
      );
    }
    restored.push({ path: join(targetDir, entry.name), contents });
  }

  for (const file of restored) writePrivate(file.path, file.contents);
  return restored.map((file) => file.path);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/test/init-backup.test.ts`
Expected: PASS, 7 tests (6 on Windows — the permissions test is gated).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/backup.ts packages/cli/test/init-backup.test.ts
git commit -m "feat(cli): encrypt .env originals into ~/.kerstel/backups before rewriting

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `kerstel exec -- <command>`

The shim the wizard writes into `package.json`. It is the whole reason `npm run dev` keeps working: it wires the hook into one child process and gets out of the way.

**Note on the test shape:** `exec` inherits stdio, so a test cannot capture the child's stdout — the child writes to a file instead and the test reads it. Every `exec` test boots an in-process daemon at `socketPath()` first, because `ensureDaemon()` would otherwise spawn a detached `daemon serve` that `bun test` reaps (the same constraint `cli.test.ts` documents around `resolve`). `test/helpers/boot-daemon.ts` cannot be used here: it boots a daemon over its own throwaway vault at its own socket, and these tests need the daemon that serves **this** `KERSTEL_HOME`'s vault at `socketPath()`.

**Files:**
- Create: `packages/cli/src/commands/exec.ts`
- Modify: `packages/cli/src/index.ts` (usage text + a `case "exec"`)
- Test: `packages/cli/test/exec.test.ts`

**Interfaces:**
- Consumes:
  - `openContext(): Promise<CliContext>` from `packages/cli/src/context.ts`, where `CliContext` is `{ vault: Vault; backend: string; token: string; firstRun: boolean; hookDir: string; hookInstall: HookInstallResult }` and `HookInstallResult` is `{ dir: string; installed: boolean; error?: string }`.
  - `ensureDaemon(options?: EnsureOptions): Promise<DaemonClient>` from `packages/cli/src/daemon/client.ts`; `DaemonClient.close(): void`.
  - `socketPath(): string` from `packages/cli/src/paths.ts`.
  - `fail(message: string): void` from `packages/cli/src/output.ts`.
  - `runCli(argv: string[]): Promise<number>` from `packages/cli/src/index.ts`.
- Produces:
  - `preloadPathFor(hookDir: string): string`
  - `buildExecEnv(options: { base: NodeJS.ProcessEnv; socketPath: string; token: string; hookDir: string }): Record<string, string>`
  - `execCommand(args: string[]): Promise<number>`
  - (branch B only, decided in Step 5) `isBunCommand(command: string[]): boolean`, `withBunPreload(command: string[], hookDir: string): string[]`

- [ ] **Step 1: Write the failing unit test for the child environment**

`packages/cli/test/exec.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExecEnv, preloadPathFor } from "../src/commands/exec";
import { startDaemon, type DaemonHandle } from "../src/daemon/server";
import { ensureToken } from "../src/daemon/token";
import { runCli } from "../src/index";
import { socketPath } from "../src/paths";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

let handle: DaemonHandle | null = null;
let vault: Vault | null = null;

/**
 * The daemon that serves THIS test's KERSTEL_HOME, on the real socketPath().
 * test/helpers/boot-daemon.ts deliberately does something else -- its own
 * throwaway vault on its own socket -- which the child process spawned by
 * `exec` would never find.
 */
async function bootLocalDaemon(): Promise<void> {
  const token = ensureToken();
  const { key, backend } = await loadOrCreateDataKey();
  vault = openVault(key);
  handle = await startDaemon({ vault, socketPath: socketPath(), token, backendName: backend });
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  if (vault) vault.close();
  vault = null;
  restoreEnv();
});

test("buildExecEnv wires the hook without resolving anything", () => {
  const env = buildExecEnv({
    base: { PATH: "/usr/bin", OPENAI_API_KEY: "kerstel://global/OPENAI_API_KEY" },
    socketPath: "/tmp/k.sock",
    token: "tok",
    hookDir: "/home/dev/.kerstel/hook",
  });

  expect(env.PATH).toBe("/usr/bin");
  expect(env.KERSTEL_SOCKET).toBe("/tmp/k.sock");
  expect(env.KERSTEL_TOKEN).toBe("tok");
  expect(env.KERSTEL_HOOK_DIR).toBe("/home/dev/.kerstel/hook");
  // A reference stays a reference: resolving is `run`'s job, never `exec`'s.
  expect(env.OPENAI_API_KEY).toBe("kerstel://global/OPENAI_API_KEY");
  expect(env.NODE_OPTIONS).toBe(`--require ${JSON.stringify(preloadPathFor("/home/dev/.kerstel/hook"))}`);
});

test("buildExecEnv appends to an existing NODE_OPTIONS and never duplicates", () => {
  const hookDir = "/home/dev/.kerstel/hook";
  const first = buildExecEnv({
    base: { NODE_OPTIONS: "--max-old-space-size=4096" },
    socketPath: "/tmp/k.sock",
    token: "tok",
    hookDir,
  });
  expect(first.NODE_OPTIONS).toBe(
    `--max-old-space-size=4096 --require ${JSON.stringify(preloadPathFor(hookDir))}`,
  );

  const second = buildExecEnv({ base: first, socketPath: "/tmp/k.sock", token: "tok", hookDir });
  expect(second.NODE_OPTIONS).toBe(first.NODE_OPTIONS);
});

test("buildExecEnv quotes a hook directory containing spaces", () => {
  const env = buildExecEnv({
    base: {},
    socketPath: "/tmp/k.sock",
    token: "tok",
    hookDir: "/Users/dev name/.kerstel/hook",
  });
  expect(env.NODE_OPTIONS).toBe(
    `--require "${join("/Users/dev name/.kerstel/hook", "preload.cjs")}"`,
  );
});

test("exec with no command exits 2 with usage", async () => {
  isolateEnv({ prefix: "exec-usage" });
  expect(await runCli(["exec"])).toBe(2);
  expect(await runCli(["exec", "--"])).toBe(2);
});

test("exec runs a node command that resolves a reference through the daemon", async () => {
  isolateEnv({ prefix: "exec-node" });
  await runCli(["set", "global/EXEC_KEY", "--value", "exec-value"]);
  await bootLocalDaemon();

  const dir = mkdtempSync(join(tmpdir(), "kerstel-exec-app-"));
  const out = join(dir, "out.txt");
  const script = join(dir, "app.cjs");
  // stdio is inherited, so the child reports through a file, not a pipe.
  writeFileSync(
    script,
    `require("node:fs").writeFileSync(${JSON.stringify(out)}, String(process.env.EXEC_KEY));`,
  );

  process.env.EXEC_KEY = "kerstel://global/EXEC_KEY";
  const code = await runCli(["exec", "--", "node", script]);
  delete process.env.EXEC_KEY;

  expect(code).toBe(0);
  expect(readFileSync(out, "utf8")).toBe("exec-value");
});

test("exec propagates the child's exit code", async () => {
  isolateEnv({ prefix: "exec-code" });
  await bootLocalDaemon();
  expect(await runCli(["exec", "--", "node", "-e", "process.exit(7)"])).toBe(7);
});

test("exec passes the command through verbatim, flags and all", async () => {
  isolateEnv({ prefix: "exec-verbatim" });
  await bootLocalDaemon();

  const dir = mkdtempSync(join(tmpdir(), "kerstel-exec-argv-"));
  const out = join(dir, "argv.json");
  const code = await runCli([
    "exec",
    "--",
    "node",
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))`,
    "--flag",
    "value with spaces",
  ]);

  expect(code).toBe(0);
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["--flag", "value with spaces"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/exec.test.ts`
Expected: FAIL — cannot resolve module `../src/commands/exec`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/commands/exec.ts`:

```ts
import { join } from "node:path";
import { openContext } from "../context";
import { ensureDaemon } from "../daemon/client";
import { fail } from "../output";
import { socketPath } from "../paths";

/**
 * Runs one command with Kerstel's runtime hook wired in, then gets out of the
 * way. This is what the wizard writes into `package.json` scripts, so it has
 * to be boring: no argument rewriting, no shell, no resolution.
 *
 * It deliberately does NOT resolve references. `kerstel run` snapshots the
 * whole environment into plaintext up front (spec §6.2's universal fallback);
 * `exec` hands the child the references untouched and lets the hook resolve
 * each one lazily, on the read, through the daemon -- which is what makes the
 * audit log meaningful and what level 2 (spec §3) will gate on.
 */

export function preloadPathFor(hookDir: string): string {
  return join(hookDir, "preload.cjs");
}

export function buildExecEnv(options: {
  base: NodeJS.ProcessEnv;
  socketPath: string;
  token: string;
  hookDir: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.base)) {
    if (typeof value === "string") env[name] = value;
  }

  env.KERSTEL_SOCKET = options.socketPath;
  env.KERSTEL_TOKEN = options.token;
  env.KERSTEL_HOOK_DIR = options.hookDir;

  const preload = preloadPathFor(options.hookDir);
  const existing = env.NODE_OPTIONS ?? "";
  // JSON.stringify, exactly as packages/hook/src/preload.js does when it
  // propagates the flag to grandchildren: a home directory with a space in it
  // ("/Users/Ada Lovelace/...") otherwise splits into two broken options.
  // Skipped when the path is already there, so a nested `exec` (a wrapped
  // script that calls another wrapped script) does not grow NODE_OPTIONS
  // without bound.
  if (!existing.includes(preload)) {
    const flag = `--require ${JSON.stringify(preload)}`;
    env.NODE_OPTIONS = existing ? `${existing} ${flag}` : flag;
  }

  return env;
}

export async function execCommand(args: string[]): Promise<number> {
  const separator = args.indexOf("--");
  const command = separator === -1 ? args : args.slice(separator + 1);
  if (command.length === 0) {
    fail("Usage: kerstel exec -- <command> [args...]");
    return 2;
  }

  // Opening the context is what installs/refreshes ~/.kerstel/hook/ and mints
  // the session token. The vault itself is not needed here -- `exec` never
  // reads a secret -- so it is closed before anything long-running starts.
  const ctx = await openContext();
  const { token, hookDir, hookInstall } = ctx;
  ctx.vault.close();

  if (!hookInstall.installed) {
    fail(
      `Kerstel could not install its runtime hook into ${hookDir}: ${hookInstall.error ?? "unknown error"}. ` +
        "Without it the child would receive raw kerstel:// references. " +
        "Fix the permissions, or use `kerstel run -- <command>` instead.",
    );
    return 1;
  }

  // The daemon must be listening BEFORE the child starts: the hook resolves on
  // the first property read, which can be microseconds into the process.
  let client;
  try {
    client = await ensureDaemon();
  } catch (error) {
    fail((error as Error).message);
    return 1;
  }
  client.close();

  const env = buildExecEnv({ base: process.env, socketPath: socketPath(), token, hookDir });
  const child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}
```

- [ ] **Step 4: Wire the command into the CLI**

In `packages/cli/src/index.ts`, add the import beside the existing command imports:

```ts
import { execCommand } from "./commands/exec";
```

add the case to the switch, directly after `case "run":`:

```ts
      case "exec":
        return await execCommand(args);
```

and add the usage line directly after the `kerstel run` line:

```
  kerstel exec -- <command>                     Run a command with the hook wired in
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/cli/test/exec.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Probe whether Bun honours `NODE_OPTIONS=--require`**

This is a fact about Bun, not a design choice, and the plan does not assume it. Add this test to `packages/cli/test/exec.test.ts` and let it answer:

```ts
test("bun honours the NODE_OPTIONS --require the exec shim sets", async () => {
  isolateEnv({ prefix: "exec-bun" });
  await runCli(["set", "global/BUN_KEY", "--value", "bun-value"]);
  await bootLocalDaemon();

  const dir = mkdtempSync(join(tmpdir(), "kerstel-exec-bun-"));
  const out = join(dir, "out.txt");
  const script = join(dir, "app.js");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, String(process.env.BUN_KEY));\n`,
  );

  process.env.BUN_KEY = "kerstel://global/BUN_KEY";
  const code = await runCli(["exec", "--", "bun", script]);
  delete process.env.BUN_KEY;

  expect(code).toBe(0);
  expect(readFileSync(out, "utf8")).toBe("bun-value");
});
```

Run: `bun test packages/cli/test/exec.test.ts -t "bun honours"`

Two possible outcomes, and each has its own next step. Record which one you saw in the commit message.

- [ ] **Step 7 — branch A (the probe PASSED): keep the probe as a regression guard**

Bun loads `--require` from `NODE_OPTIONS`, so `exec` needs no Bun-specific argument injection. Do not add `isBunCommand` or `withBunPreload` — an unused export is a lie about how the system works. Instead, add this comment above `buildExecEnv` in `packages/cli/src/commands/exec.ts` so the next reader knows the question was asked and answered:

```ts
// Bun honours NODE_OPTIONS=--require, verified by the "bun honours the
// NODE_OPTIONS --require the exec shim sets" test in test/exec.test.ts. That
// test is the guard: if a future Bun stops honouring it, `exec` has to inject
// `--preload <hookDir>/preload.cjs` as an argument for bun/bunx commands
// instead, and that test is what will say so.
```

Then skip to Step 9.

- [ ] **Step 8 — branch B (the probe FAILED): inject `--preload` for Bun commands**

Bun ignores `--require` in `NODE_OPTIONS`, so `exec` has to pass Bun its own flag. Add to `packages/cli/src/commands/exec.ts`:

```ts
/**
 * True when the command Bun would run is the `bun` runtime itself, so the
 * preload has to arrive as a `--preload` argument rather than through
 * NODE_OPTIONS (which Bun does not honour -- see the probe test in
 * test/exec.test.ts). Covers `bun x.js`, `bun run dev` and `bunx`, with or
 * without a directory in front of the executable and with or without `.exe`.
 */
export function isBunCommand(command: string[]): boolean {
  const executable = command[0];
  if (!executable) return false;
  const name = (executable.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  return name === "bun" || name === "bunx";
}

/**
 * Inserts `--preload <hookDir>/preload.cjs` immediately after the executable,
 * which is where Bun accepts runtime flags -- after a subcommand like `run`
 * they belong to the script, not to Bun. Idempotent: a command that already
 * carries this preload is returned unchanged, and the hook's own
 * KERSTEL_ACTIVE guard makes a double install a no-op anyway.
 */
export function withBunPreload(command: string[], hookDir: string): string[] {
  if (!isBunCommand(command)) return command;
  const preload = preloadPathFor(hookDir);
  if (command.includes(preload)) return command;
  const [executable, ...rest] = command;
  return [executable as string, "--preload", preload, ...rest];
}
```

and change the spawn line in `execCommand` from

```ts
  const child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
```

to

```ts
  const argv = withBunPreload(command, hookDir);
  const child = Bun.spawn(argv, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
```

Then add this unit test to `packages/cli/test/exec.test.ts`:

```ts
test("withBunPreload injects the preload for bun commands only", () => {
  const hookDir = "/home/dev/.kerstel/hook";
  const preload = preloadPathFor(hookDir);

  expect(withBunPreload(["bun", "run", "dev"], hookDir)).toEqual([
    "bun",
    "--preload",
    preload,
    "run",
    "dev",
  ]);
  expect(withBunPreload(["bunx", "vitest"], hookDir)).toEqual(["bunx", "--preload", preload, "vitest"]);
  expect(withBunPreload(["/usr/local/bin/bun", "app.ts"], hookDir)).toEqual([
    "/usr/local/bin/bun",
    "--preload",
    preload,
    "app.ts",
  ]);
  expect(withBunPreload(["node", "app.js"], hookDir)).toEqual(["node", "app.js"]);
  expect(withBunPreload(["vite", "build"], hookDir)).toEqual(["vite", "build"]);
  // Idempotent: a nested exec must not stack preloads.
  expect(withBunPreload(["bun", "--preload", preload, "run", "dev"], hookDir)).toEqual([
    "bun",
    "--preload",
    preload,
    "run",
    "dev",
  ]);
});
```

with the import line in that file updated to:

```ts
import { buildExecEnv, preloadPathFor, withBunPreload } from "../src/commands/exec";
```

- [ ] **Step 9: Run the whole suite and typecheck**

Run: `bun run typecheck && bun test packages/cli/test/exec.test.ts packages/cli/test/cli.test.ts`
Expected: PASS. The `exec` file has 8 tests on branch A, 9 on branch B; `cli.test.ts` is unchanged and must stay green — `index.ts` gained a case, nothing else.

- [ ] **Step 10: Commit**

```bash
git add packages/cli/src/commands/exec.ts packages/cli/src/index.ts packages/cli/test/exec.test.ts
git commit -m "feat(cli): add kerstel exec, the hook-wiring shim for package scripts

Verified against Bun: NODE_OPTIONS=--require is honoured / is not honoured
(keep the branch you actually observed and delete the other).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Wiring `package.json` and `bunfig.toml`, and the diff renderer

Spec §6.2. These are the developer's files; the wizard changes as few bytes as it can and shows every one of them first.

**Files:**
- Create: `packages/cli/src/init/wiring.ts`
- Test: `packages/cli/test/init-wiring.test.ts`

**Interfaces:**
- Consumes: `bold(text: string): string`, `dim(text: string): string`, `green(text: string): string`, `red(text: string): string` from `packages/cli/src/output.ts`.
- Produces:
  - `const LIFECYCLE_SCRIPTS: readonly string[]`
  - `const EXEC_PREFIX: string` (`"kerstel exec -- "`)
  - `wrapScript(command: string): string`
  - `detectIndent(source: string): string`
  - `interface ScriptRewrite { name: string; before: string; after: string }`
  - `interface ScriptSkip { name: string; reason: "lifecycle" | "already-wired" | "not-a-string" }`
  - `interface PackageJsonWiring { changed: boolean; contents: string; rewrites: ScriptRewrite[]; skipped: ScriptSkip[] }`
  - `wirePackageJson(source: string): PackageJsonWiring`
  - `interface BunfigWiring { changed: boolean; created: boolean; contents: string }`
  - `wireBunfig(source: string | null, preloadPath: string): BunfigWiring`
  - `renderDiff(label: string, before: string, after: string): string`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/init-wiring.test.ts`:

```ts
import { expect, test } from "bun:test";
import { renderDiff, wireBunfig, wirePackageJson, wrapScript } from "../src/init/wiring";

const strip = (text: string): string => text.replace(/\[[0-9;]*m/g, "");

const NPM_PACKAGE = `{
  "name": "demo",
  "version": "1.0.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "postinstall": "patch-package",
    "lint": "kerstel exec -- eslint ."
  },
  "dependencies": {
    "next": "^15.0.0"
  }
}
`;

const NPM_PACKAGE_WIRED = `{
  "name": "demo",
  "version": "1.0.0",
  "scripts": {
    "dev": "kerstel exec -- next dev",
    "build": "kerstel exec -- next build",
    "postinstall": "patch-package",
    "lint": "kerstel exec -- eslint ."
  },
  "dependencies": {
    "next": "^15.0.0"
  }
}
`;

test("wrapScript builds the shim invocation", () => {
  expect(wrapScript("next dev")).toBe("kerstel exec -- next dev");
});

test("wirePackageJson rewrites scripts and preserves key order and formatting", () => {
  const result = wirePackageJson(NPM_PACKAGE);
  expect(result.changed).toBe(true);
  expect(result.contents).toBe(NPM_PACKAGE_WIRED);
  expect(result.rewrites.map((r) => r.name)).toEqual(["dev", "build"]);
  expect(result.skipped).toEqual([
    { name: "postinstall", reason: "lifecycle" },
    { name: "lint", reason: "already-wired" },
  ]);
});

test("wirePackageJson never wraps an npm lifecycle hook", () => {
  const source = `{
  "scripts": {
    "preinstall": "node check.js",
    "install": "node-gyp rebuild",
    "postinstall": "patch-package",
    "prepare": "husky",
    "prepublishOnly": "npm test",
    "start": "node server.js"
  }
}
`;
  const result = wirePackageJson(source);
  expect(result.rewrites.map((r) => r.name)).toEqual(["start"]);
  expect(result.contents).toContain('"preinstall": "node check.js"');
  expect(result.contents).toContain('"prepublishOnly": "npm test"');
  expect(result.contents).toContain('"start": "kerstel exec -- node server.js"');
});

test("wirePackageJson is idempotent and leaves an already-wired file byte-identical", () => {
  const once = wirePackageJson(NPM_PACKAGE);
  const twice = wirePackageJson(once.contents);
  expect(twice.changed).toBe(false);
  expect(twice.contents).toBe(once.contents);
  expect(twice.rewrites).toEqual([]);
});

test("wirePackageJson preserves a tab indent", () => {
  const source = '{\n\t"scripts": {\n\t\t"dev": "vite"\n\t}\n}\n';
  expect(wirePackageJson(source).contents).toBe(
    '{\n\t"scripts": {\n\t\t"dev": "kerstel exec -- vite"\n\t}\n}\n',
  );
});

test("wirePackageJson preserves a four-space indent", () => {
  const source = '{\n    "scripts": {\n        "dev": "vite"\n    }\n}\n';
  expect(wirePackageJson(source).contents).toBe(
    '{\n    "scripts": {\n        "dev": "kerstel exec -- vite"\n    }\n}\n',
  );
});

test("wirePackageJson handles a file with no scripts at all", () => {
  const source = '{\n  "name": "demo"\n}\n';
  const result = wirePackageJson(source);
  expect(result.changed).toBe(false);
  expect(result.contents).toBe(source);
});

test("wirePackageJson skips a non-string script value instead of mangling it", () => {
  const source = '{\n  "scripts": {\n    "weird": null,\n    "dev": "vite"\n  }\n}\n';
  const result = wirePackageJson(source);
  expect(result.skipped).toEqual([{ name: "weird", reason: "not-a-string" }]);
  expect(result.contents).toContain('"weird": null');
});

test("wireBunfig creates the file when there is none", () => {
  const result = wireBunfig(null, "/home/dev/.kerstel/hook/preload.cjs");
  expect(result.created).toBe(true);
  expect(result.changed).toBe(true);
  expect(result.contents).toBe('preload = ["/home/dev/.kerstel/hook/preload.cjs"]\n');
});

test("wireBunfig adds a top-level preload above the first section", () => {
  const source = '# project config\n\n[test]\ncoverage = false\n';
  const result = wireBunfig(source, "/hook/preload.cjs");
  expect(result.created).toBe(false);
  expect(result.contents).toBe(
    '# project config\n\npreload = ["/hook/preload.cjs"]\n[test]\ncoverage = false\n',
  );
});

test("wireBunfig appends when the file has no sections", () => {
  const result = wireBunfig("telemetry = false\n", "/hook/preload.cjs");
  expect(result.contents).toBe('telemetry = false\npreload = ["/hook/preload.cjs"]\n');
});

test("wireBunfig merges into an existing preload array", () => {
  const source = 'preload = ["./setup.ts"]\n\n[test]\npreload = ["./test-setup.ts"]\n';
  const result = wireBunfig(source, "/hook/preload.cjs");
  expect(result.contents).toBe(
    'preload = ["./setup.ts", "/hook/preload.cjs"]\n\n[test]\npreload = ["./test-setup.ts"]\n',
  );
});

test("wireBunfig is idempotent", () => {
  const source = 'preload = ["/hook/preload.cjs"]\n';
  const result = wireBunfig(source, "/hook/preload.cjs");
  expect(result.changed).toBe(false);
  expect(result.contents).toBe(source);
});

test("wireBunfig fills an empty preload array", () => {
  expect(wireBunfig("preload = []\n", "/hook/preload.cjs").contents).toBe(
    'preload = ["/hook/preload.cjs"]\n',
  );
});

test("wireBunfig refuses a multi-line preload array rather than corrupting it", () => {
  const source = 'preload = [\n  "./setup.ts"\n]\n';
  expect(() => wireBunfig(source, "/hook/preload.cjs")).toThrow(/by hand/);
});

test("wireBunfig preserves CRLF line endings", () => {
  const result = wireBunfig("telemetry = false\r\n", "/hook/preload.cjs");
  expect(result.contents).toBe('telemetry = false\r\npreload = ["/hook/preload.cjs"]\r\n');
});

test("renderDiff shows the changed lines with context", () => {
  const before = "a\nb\nc\nd\ne\n";
  const after = "a\nb\nCHANGED\nd\ne\n";
  const out = strip(renderDiff("package.json", before, after)).split("\n");
  expect(out[0]).toBe("package.json");
  expect(out).toContain("  b");
  expect(out).toContain("- c");
  expect(out).toContain("+ CHANGED");
  expect(out).toContain("  d");
  // Unchanged lines far from the edit are not printed.
  expect(out.join("\n")).not.toContain("  a");
});

test("renderDiff handles pure insertion", () => {
  const out = strip(renderDiff("bunfig.toml", "", 'preload = ["/hook/preload.cjs"]\n'));
  expect(out).toContain('+ preload = ["/hook/preload.cjs"]');
  expect(out).not.toContain("- ");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/init-wiring.test.ts`
Expected: FAIL — cannot resolve module `../src/init/wiring`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/init/wiring.ts`:

```ts
import { bold, dim, green, red } from "../output";

/**
 * Spec §6.2's wiring, and nothing more than it.
 *
 * `package.json` is rewritten through JSON.parse/JSON.stringify, which
 * preserves insertion order for the string keys npm uses, and the source's own
 * indent is detected and reused so the change shows up in `git diff` as the
 * script lines and nothing else.
 *
 * `bunfig.toml` is edited LINE BY LINE with no TOML library. That is a
 * deliberate constraint, not laziness: a parse-and-reprint round trip through
 * any TOML library reorders keys, normalises strings and drops comments, which
 * would turn a one-line addition into a whole-file rewrite of a file Kerstel
 * does not own.
 */

/** npm lifecycle hooks. Wrapping these would make `npm install` depend on Kerstel. */
export const LIFECYCLE_SCRIPTS: readonly string[] = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublishOnly",
];

export const EXEC_PREFIX = "kerstel exec -- ";

export function wrapScript(command: string): string {
  return `${EXEC_PREFIX}${command}`;
}

/**
 * The indent the source file already uses, so a wired file keeps its own
 * style: two spaces (npm's default), four spaces, or a tab.
 */
export function detectIndent(source: string): string {
  const match = /\n([ \t]+)"/.exec(source);
  const indent = match?.[1];
  if (!indent) return "  ";
  if (indent.startsWith("\t")) return "\t";
  return " ".repeat(Math.min(indent.length, 8));
}

export interface ScriptRewrite {
  name: string;
  before: string;
  after: string;
}

export interface ScriptSkip {
  name: string;
  reason: "lifecycle" | "already-wired" | "not-a-string";
}

export interface PackageJsonWiring {
  changed: boolean;
  /** The file to write. Byte-identical to the input when `changed` is false. */
  contents: string;
  rewrites: ScriptRewrite[];
  skipped: ScriptSkip[];
}

export function wirePackageJson(source: string): PackageJsonWiring {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const rewrites: ScriptRewrite[] = [];
  const skipped: ScriptSkip[] = [];

  const scripts = parsed.scripts;
  if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
    const table = scripts as Record<string, unknown>;
    for (const [name, value] of Object.entries(table)) {
      if (typeof value !== "string") {
        skipped.push({ name, reason: "not-a-string" });
        continue;
      }
      if (LIFECYCLE_SCRIPTS.includes(name)) {
        skipped.push({ name, reason: "lifecycle" });
        continue;
      }
      // Any `kerstel ...` script is already ours (or the user's own deliberate
      // call) -- wrapping it again would nest shims on every re-run.
      if (value.trimStart().startsWith("kerstel ")) {
        skipped.push({ name, reason: "already-wired" });
        continue;
      }

      const after = wrapScript(value);
      table[name] = after;
      rewrites.push({ name, before: value, after });
    }
  }

  if (rewrites.length === 0) {
    // Nothing to do means nothing to write. Returning the re-serialized text
    // here would reformat a file for no reason at all.
    return { changed: false, contents: source, rewrites, skipped };
  }

  return {
    changed: true,
    contents: `${JSON.stringify(parsed, null, detectIndent(source))}\n`,
    rewrites,
    skipped,
  };
}

export interface BunfigWiring {
  changed: boolean;
  created: boolean;
  contents: string;
}

const SECTION_HEADER = /^\s*\[/;
const PRELOAD_LINE = /^(\s*preload\s*=\s*)\[([^\]]*)\](\s*)$/;
const PRELOAD_OPEN = /^\s*preload\s*=\s*\[/;

/**
 * Ensures the TOP-LEVEL `preload` array contains the hook.
 *
 * Only the top level: scanning stops at the first `[section]` header, so a
 * `[test]` table with its own `preload` is left entirely alone (a test preload
 * is a different concern and out of scope for v1).
 *
 * @param source The file's current contents, or null when it does not exist.
 */
export function wireBunfig(source: string | null, preloadPath: string): BunfigWiring {
  const entry = JSON.stringify(preloadPath);

  if (source === null) {
    return { changed: true, created: true, contents: `preload = [${entry}]\n` };
  }

  // Terminators are captured so every untouched line keeps its own ending.
  const parts = source.split(/(\r\n|\n)/);
  const eol = parts.find((part, index) => index % 2 === 1) ?? "\n";

  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    if (SECTION_HEADER.test(text)) {
      // Insert directly above the first section, which is the end of the
      // top-level table.
      parts.splice(i, 0, `preload = [${entry}]`, eol);
      return { changed: true, created: false, contents: parts.join("") };
    }

    const match = PRELOAD_LINE.exec(text);
    if (match) {
      const head = match[1] ?? "";
      const body = match[2] ?? "";
      const tail = match[3] ?? "";
      if (body.includes(preloadPath)) {
        return { changed: false, created: false, contents: source };
      }
      const items = body.trim().replace(/,$/, "");
      parts[i] = `${head}[${items.length === 0 ? entry : `${items}, ${entry}`}]${tail}`;
      return { changed: true, created: false, contents: parts.join("") };
    }

    if (PRELOAD_OPEN.test(text)) {
      throw new Error(
        "Kerstel cannot edit a multi-line `preload` array in bunfig.toml without risking the " +
          `rest of the file. Add ${entry} to it by hand, then re-run \`kerstel init\`.`,
      );
    }
  }

  let contents = source;
  if (contents.length > 0 && !contents.endsWith("\n")) contents += eol;
  return { changed: true, created: false, contents: `${contents}preload = [${entry}]${eol}` };
}

/** How many unchanged lines to show around an edit. */
const CONTEXT_LINES = 2;

/**
 * A minimal line diff: the common prefix and suffix are trimmed, whatever is
 * left is shown as removals then additions, with a little context. No LCS, no
 * dependency -- the edits this wizard makes are a handful of adjacent lines,
 * and a diff the user can read in one glance beats a clever one.
 */
export function renderDiff(label: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const lines = [bold(label)];
  for (const line of a.slice(Math.max(0, head - CONTEXT_LINES), head)) lines.push(dim(`  ${line}`));
  for (const line of a.slice(head, a.length - tail)) lines.push(red(`- ${line}`));
  for (const line of b.slice(head, b.length - tail)) lines.push(green(`+ ${line}`));
  for (const line of a.slice(a.length - tail, a.length - tail + CONTEXT_LINES)) {
    lines.push(dim(`  ${line}`));
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/test/init-wiring.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/wiring.ts packages/cli/test/init-wiring.test.ts
git commit -m "feat(cli): wire package.json scripts and bunfig preload for the hook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Prompts

**Files:**
- Create: `packages/cli/src/init/prompts.ts`
- Test: `packages/cli/test/init-prompts.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks; `createInterface` from `node:readline/promises`.
- Produces:
  - `interface TextOptions { secret?: boolean; flag?: string }`
  - `interface Prompter { confirm(question: string, defaultValue: boolean): Promise<boolean>; choose(question: string, options: string[], defaultValue: string): Promise<string>; text(question: string, options?: TextOptions): Promise<string> }`
  - `class NonInteractiveError extends Error { readonly question: string; readonly flag: string }`
  - `class TtyPrompter implements Prompter` — `constructor(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream)`
  - `class ScriptedPrompter implements Prompter` — `constructor(answers: (string | boolean)[])`, plus `readonly asked: string[]`
  - `class DefaultsPrompter implements Prompter`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/init-prompts.test.ts`:

```ts
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  DefaultsPrompter,
  NonInteractiveError,
  ScriptedPrompter,
  TtyPrompter,
} from "../src/init/prompts";

test("ScriptedPrompter answers in order and records the questions", async () => {
  const prompter = new ScriptedPrompter([true, "global", "sk-typed-value", false]);
  expect(await prompter.confirm("Continue?", false)).toBe(true);
  expect(await prompter.choose("Where?", ["project", "global", "plaintext"], "project")).toBe("global");
  expect(await prompter.text("Value for OPENAI_API_KEY?", { secret: true })).toBe("sk-typed-value");
  expect(await prompter.confirm("Update .gitignore?", false)).toBe(false);
  expect(prompter.asked).toEqual([
    "Continue?",
    "Where?",
    "Value for OPENAI_API_KEY?",
    "Update .gitignore?",
  ]);
});

test("ScriptedPrompter throws when its answers run out", async () => {
  const prompter = new ScriptedPrompter([true]);
  await prompter.confirm("First?", false);
  await expect(prompter.confirm("Second?", false)).rejects.toThrow(/ran out of scripted answers/i);
});

test("ScriptedPrompter rejects an answer of the wrong shape", async () => {
  await expect(new ScriptedPrompter(["yes"]).confirm("Sure?", false)).rejects.toThrow(/boolean/i);
  await expect(new ScriptedPrompter([true]).text("Value?")).rejects.toThrow(/string/i);
  await expect(
    new ScriptedPrompter(["nope"]).choose("Where?", ["project", "global"], "project"),
  ).rejects.toThrow(/not one of/i);
});

test("DefaultsPrompter returns every default without asking", async () => {
  const prompter = new DefaultsPrompter();
  expect(await prompter.confirm("Continue?", true)).toBe(true);
  expect(await prompter.confirm("Update .gitignore?", false)).toBe(false);
  expect(await prompter.choose("Where?", ["project", "global"], "project")).toBe("project");
});

test("DefaultsPrompter refuses a question that has no default, naming the flag", async () => {
  const prompter = new DefaultsPrompter();
  const failure = prompter.text("Value for OPENAI_API_KEY?", { secret: true, flag: "--from-stdin" });
  await expect(failure).rejects.toBeInstanceOf(NonInteractiveError);
  await expect(failure).rejects.toThrow(/--from-stdin/);
});

test("TtyPrompter reads a line and applies the default on an empty answer", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompter = new TtyPrompter(input, output);

  const answer = prompter.confirm("Continue?", true);
  input.write("\n");
  expect(await answer).toBe(true);

  const no = prompter.confirm("Continue?", true);
  input.write("n\n");
  expect(await no).toBe(false);
});

test("TtyPrompter's choose rejects an answer outside the options", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompter = new TtyPrompter(input, output);

  const answer = prompter.choose("Where?", ["project", "global", "plaintext"], "project");
  input.write("nowhere\n");
  input.write("global\n");
  expect(await answer).toBe("global");
});

test("TtyPrompter never echoes a secret", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const seen: string[] = [];
  output.on("data", (chunk: Buffer) => seen.push(chunk.toString("utf8")));

  const prompter = new TtyPrompter(input, output);
  const answer = prompter.text("Value for OPENAI_API_KEY?", { secret: true });
  input.write("sk-super-secret\n");
  expect(await answer).toBe("sk-super-secret");

  const printed = seen.join("");
  expect(printed).toContain("Value for OPENAI_API_KEY?");
  expect(printed).not.toContain("sk-super-secret");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/init-prompts.test.ts`
Expected: FAIL — cannot resolve module `../src/init/prompts`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/init/prompts.ts`:

```ts
import { createInterface } from "node:readline/promises";
import { bold, dim } from "../output";

/**
 * One question-asking interface with three implementations, so the wizard's
 * logic never branches on "are we interactive".
 *
 * A secret NEVER arrives on argv: `text({ secret: true })` reads it from the
 * terminal with the echo suppressed, and the non-interactive path reads JSON
 * from stdin instead. Anything on argv is in the shell history and in `ps`
 * output for every user on the machine -- see the warning `kerstel set
 * --value` prints for the same reason.
 */

export interface TextOptions {
  /** Suppress echo. Always true for a value that will become a secret. */
  secret?: boolean;
  /** The CLI flag that would supply this answer non-interactively. */
  flag?: string;
}

export interface Prompter {
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  choose(question: string, options: string[], defaultValue: string): Promise<string>;
  text(question: string, options?: TextOptions): Promise<string>;
}

/** Thrown when a non-interactive run reaches a question with no default. */
export class NonInteractiveError extends Error {
  constructor(
    public readonly question: string,
    public readonly flag: string,
  ) {
    super(
      `Kerstel needs an answer to "${question}" and this run is non-interactive. ` +
        `Supply it with ${flag}, or drop --yes / --non-interactive and answer at the prompt.`,
    );
    this.name = "NonInteractiveError";
  }
}

export class TtyPrompter implements Prompter {
  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  private async ask(prompt: string, secret: boolean): Promise<string> {
    const rl = createInterface({ input: this.input, output: this.output, terminal: true });
    try {
      if (!secret) return (await rl.question(prompt)).trim();

      // readline echoes by writing to `output`. Write the prompt ourselves,
      // then mute the stream for the duration of the answer: the characters
      // typed never reach the terminal, the scrollback or a screen recording.
      this.output.write(prompt);
      const realWrite = this.output.write.bind(this.output);
      (this.output as { write: unknown }).write = () => true;
      try {
        return (await rl.question("")).trim();
      } finally {
        (this.output as { write: typeof realWrite }).write = realWrite;
        this.output.write("\n");
      }
    } finally {
      rl.close();
    }
  }

  async confirm(question: string, defaultValue: boolean): Promise<boolean> {
    const hint = defaultValue ? "[Y/n]" : "[y/N]";
    for (;;) {
      const answer = (await this.ask(`${question} ${dim(hint)} `, false)).toLowerCase();
      if (answer === "") return defaultValue;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      this.output.write(`Please answer y or n.\n`);
    }
  }

  async choose(question: string, options: string[], defaultValue: string): Promise<string> {
    for (;;) {
      const answer = await this.ask(
        `${question} ${dim(`(${options.join(" / ")})`)} ${dim(`[${defaultValue}]`)} `,
        false,
      );
      if (answer === "") return defaultValue;
      if (options.includes(answer)) return answer;
      this.output.write(`Please choose one of: ${options.join(", ")}.\n`);
    }
  }

  async text(question: string, options: TextOptions = {}): Promise<string> {
    return this.ask(`${bold(question)} `, options.secret === true);
  }
}

/** Answers from a fixed list. Tests only -- it is what makes the wizard testable. */
export class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];
  private index = 0;

  constructor(private readonly answers: (string | boolean)[]) {}

  private next(question: string): string | boolean {
    this.asked.push(question);
    if (this.index >= this.answers.length) {
      throw new Error(
        `ScriptedPrompter ran out of scripted answers at question ${this.index + 1}: "${question}". ` +
          `Asked so far: ${this.asked.join(" | ")}`,
      );
    }
    return this.answers[this.index++] as string | boolean;
  }

  async confirm(question: string, _defaultValue: boolean): Promise<boolean> {
    const answer = this.next(question);
    if (typeof answer !== "boolean") {
      throw new Error(`ScriptedPrompter expected a boolean for "${question}", got ${JSON.stringify(answer)}`);
    }
    return answer;
  }

  async choose(question: string, options: string[], _defaultValue: string): Promise<string> {
    const answer = this.next(question);
    if (typeof answer !== "string" || !options.includes(answer)) {
      throw new Error(
        `ScriptedPrompter answer ${JSON.stringify(answer)} for "${question}" is not one of ${options.join(", ")}`,
      );
    }
    return answer;
  }

  async text(question: string, _options: TextOptions = {}): Promise<string> {
    const answer = this.next(question);
    if (typeof answer !== "string") {
      throw new Error(`ScriptedPrompter expected a string for "${question}", got ${JSON.stringify(answer)}`);
    }
    return answer;
  }
}

/** `--yes` and `--non-interactive`: every default, no questions. */
export class DefaultsPrompter implements Prompter {
  async confirm(_question: string, defaultValue: boolean): Promise<boolean> {
    return defaultValue;
  }

  async choose(_question: string, _options: string[], defaultValue: string): Promise<string> {
    return defaultValue;
  }

  async text(question: string, options: TextOptions = {}): Promise<string> {
    // A free-text answer has no default by definition. Inventing one here
    // would mean storing an empty secret and calling it success.
    throw new NonInteractiveError(question, options.flag ?? "--from-stdin");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/test/init-prompts.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/prompts.ts packages/cli/test/init-prompts.test.ts
git commit -m "feat(cli): add the prompter interface behind the init wizard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The `kerstel init` wizard

Spec §8's six steps, end to end.

**The consent model** — three places the user is asked, and no write happens before the second:

1. one `choose` per plaintext key (project / global / plaintext),
2. one `confirm` covering backup + vault writes + file rewrites + wiring, printed directly under the full diff of every file that would change,
3. one `confirm` for `.gitignore`, defaulting to **no**.

**Files:**
- Create: `packages/cli/src/init/collect.ts`
- Create: `packages/cli/src/commands/init.ts`
- Modify: `packages/cli/src/daemon/spawn.ts` (extract `cliCommand`, which `daemonServeCommand` now calls)
- Modify: `packages/cli/src/index.ts` (usage text + a `case "init"`)
- Test: `packages/cli/test/init.test.ts`

**Interfaces:**
- Consumes:
  - `parseDotenv(source: string): DotenvFile`, `serializeDotenv(file: DotenvFile): string`, `entries(file: DotenvFile): DotenvPair[]`, `lookup(file: DotenvFile, key: string): string | null`, `setValue(file: DotenvFile, key: string, value: string): number` (Task 1)
  - `deriveScope(options: { packageName: string | null; rootPath: string }): DerivedScope` (Task 2)
  - `detectProject(root: string): DetectedProject`, `type EnvFileInfo` (Task 3)
  - `suggest(key: string, value: string): Suggestion`, `SUGGESTIONS: readonly Suggestion[]` (Task 4)
  - `createBackup(options: { scope: string; dataKey: Buffer; files: { name: string; contents: string }[]; timestamp?: string }): BackupResult` (Task 5)
  - `preloadPathFor(hookDir: string): string` (Task 6)
  - `wirePackageJson(source: string): PackageJsonWiring`, `wireBunfig(source: string | null, preloadPath: string): BunfigWiring`, `renderDiff(label: string, before: string, after: string): string` (Task 7)
  - `type Prompter`, `TtyPrompter`, `DefaultsPrompter`, `NonInteractiveError` (Task 8)
  - `openContext(): Promise<CliContext>`; `Vault.setSecret(ref: SecretRef, value: string): void`, `Vault.getSecret(ref: SecretRef): string | null`, `Vault.registerProject(name: string, rootPath: string): void`, `Vault.close(): void`
  - `loadOrCreateDataKey(override?: KeychainBackend): Promise<{ key: Buffer; backend: string; created: boolean }>` from `packages/cli/src/vault/keychain/index.ts`
  - `formatReference(scope: string, key: string): string`, `parseReference(value: string): SecretRef | null`, `isValidScope(scope: string): boolean`, `GLOBAL_SCOPE: string` from `packages/cli/src/reference.ts`
  - `isCompiledBinary(): boolean` from `packages/cli/src/daemon/spawn.ts`
- Produces:
  - `interface LoadedEnvFile { info: EnvFileInfo; original: string; file: DotenvFile }`
  - `interface CollectedKey { key: string; value: string; source: string; files: string[]; conflicts: string[]; reference: SecretRef | null }`
  - `loadEnvFiles(files: EnvFileInfo[]): LoadedEnvFile[]`
  - `collectKeys(loaded: LoadedEnvFile[]): CollectedKey[]`
  - `interface InitOptions { cwd: string; yes: boolean; dryRun: boolean; nonInteractive: boolean; fromStdin: boolean; scope?: string; globalKeys: Set<string>; keepKeys: Set<string> }`
  - `parseInitArgs(args: string[], cwd: string): InitOptions | { error: string }`
  - `runInit(options: InitOptions, prompter: Prompter): Promise<number>`
  - `initCommand(args: string[], prompterOverride?: Prompter): Promise<number>`
  - `cliCommand(args: string[]): string[]` (in `daemon/spawn.ts`)

- [ ] **Step 1: Extract `cliCommand` from `daemonServeCommand`**

`init`'s self-check has to run **this** CLI as a child process, and the "compiled binary vs. `bun run src/index.ts`" problem `daemonServeCommand()` already solves is exactly the same problem. Solve it once. In `packages/cli/src/daemon/spawn.ts`, replace the body of `daemonServeCommand` and add `cliCommand` above it:

```ts
/**
 * The argv that runs THIS CLI with the given arguments.
 *
 * THE CONSTRAINT: `process.execPath` means two different things depending on
 * how this process was started. Compiled, it is the `kerstel` binary and
 * `[execPath, ...args]` is exactly right. From source it is the `bun` binary,
 * and that same argv asks Bun to execute a file called `daemon` -- which fails
 * in a way that looks like the child crashed rather than like the caller built
 * the wrong command. From source we therefore have to name the CLI entry point
 * explicitly.
 *
 * Every site that spawns Kerstel from inside Kerstel (`daemon start`,
 * `ensureDaemon`, `init`'s self-check) goes through here so they cannot drift.
 */
export function cliCommand(args: string[]): string[] {
  if (isCompiledBinary()) return [process.execPath, ...args];
  // src/daemon/spawn.ts -> src/index.ts
  const entry = resolve(dirname(import.meta.path), "..", "index.ts");
  return [process.execPath, "run", entry, ...args];
}

/** The argv that starts a detached resolver daemon. */
export function daemonServeCommand(): string[] {
  return cliCommand(["daemon", "serve"]);
}
```

- [ ] **Step 2: Write the failing test**

`packages/cli/test/init.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand, parseInitArgs, runInit, type InitOptions } from "../src/commands/init";
import { startDaemon, type DaemonHandle } from "../src/daemon/server";
import { ensureToken } from "../src/daemon/token";
import { collectKeys, loadEnvFiles } from "../src/init/collect";
import { discoverEnvFiles } from "../src/init/detect";
import { DefaultsPrompter, ScriptedPrompter } from "../src/init/prompts";
import { backupsDir, socketPath } from "../src/paths";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

let handle: DaemonHandle | null = null;
let daemonVault: Vault | null = null;

/**
 * `init`'s self-check spawns `kerstel exec -- node -e ...`, which needs a
 * daemon serving THIS test's KERSTEL_HOME on the real socketPath().
 * test/helpers/boot-daemon.ts deliberately boots a different thing -- its own
 * throwaway vault on its own socket -- which that child could never find.
 */
async function bootLocalDaemon(): Promise<void> {
  const token = ensureToken();
  const { key, backend } = await loadOrCreateDataKey();
  daemonVault = openVault(key);
  handle = await startDaemon({ vault: daemonVault, socketPath: socketPath(), token, backendName: backend });
}

async function openTestVault<T>(use: (vault: Vault) => T): Promise<T> {
  const { key } = await loadOrCreateDataKey();
  const vault = openVault(key);
  try {
    return use(vault);
  } finally {
    vault.close();
  }
}

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-init-"));
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  return root;
}

function options(root: string, args: string[] = []): InitOptions {
  const parsed = parseInitArgs(args, root);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

const NPM_PACKAGE = `{
  "name": "@acme/demo-app",
  "scripts": {
    "dev": "next dev",
    "postinstall": "patch-package"
  }
}
`;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  if (daemonVault) daemonVault.close();
  daemonVault = null;
  restoreEnv();
});

test("collectKeys applies the documented precedence and records conflicts", () => {
  const root = makeProject({
    ".env": "SHARED=from-env\nONLY_BASE=base\n",
    ".env.local": "SHARED=from-local\n",
    ".env.production.local": "SHARED=from-prod-local\n",
  });
  const keys = collectKeys(loadEnvFiles(discoverEnvFiles(root)));
  const shared = keys.find((k) => k.key === "SHARED");

  expect(shared?.value).toBe("from-prod-local");
  expect(shared?.source).toBe(".env.production.local");
  expect(shared?.files).toEqual([".env.production.local", ".env.local", ".env"]);
  expect(shared?.conflicts).toEqual([".env.local", ".env"]);
  expect(keys.find((k) => k.key === "ONLY_BASE")?.conflicts).toEqual([]);
});

test("collectKeys recognises a value that is already a reference", () => {
  const root = makeProject({ ".env": "A=kerstel://demo/A\nB=plain\n" });
  const keys = collectKeys(loadEnvFiles(discoverEnvFiles(root)));
  expect(keys.find((k) => k.key === "A")?.reference).toEqual({ scope: "demo", key: "A" });
  expect(keys.find((k) => k.key === "B")?.reference).toBeNull();
});

test("parseInitArgs reads every documented flag and rejects the rest", () => {
  const parsed = parseInitArgs(
    ["--yes", "--dry-run", "--non-interactive", "--from-stdin", "--scope", "my-app", "--global", "A,B", "--keep", "C"],
    "/tmp/p",
  );
  if ("error" in parsed) throw new Error(parsed.error);
  expect(parsed.yes).toBe(true);
  expect(parsed.dryRun).toBe(true);
  expect(parsed.nonInteractive).toBe(true);
  expect(parsed.fromStdin).toBe(true);
  expect(parsed.scope).toBe("my-app");
  expect([...parsed.globalKeys]).toEqual(["A", "B"]);
  expect([...parsed.keepKeys]).toEqual(["C"]);

  expect(parseInitArgs(["--frobnicate"], "/tmp/p")).toEqual({
    error: expect.stringContaining("--frobnicate") as unknown as string,
  });
  expect(parseInitArgs(["--scope", "Bad Scope"], "/tmp/p")).toEqual({
    error: expect.stringContaining("Invalid scope") as unknown as string,
  });
});

test("initCommand rejects an unknown flag before touching anything", async () => {
  isolateEnv({ prefix: "init-badflag" });
  expect(await initCommand(["--frobnicate"], new DefaultsPrompter())).toBe(2);
});

test("init migrates an npm project end to end", async () => {
  isolateEnv({ prefix: "init-npm" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    "package-lock.json": "{}",
    ".env": [
      "# app config",
      "NODE_ENV=development",
      "DATABASE_URL=postgres://u:pw@localhost:5432/app",
      'OPENAI_API_KEY="sk-project-key" # from the console',
      "",
    ].join("\n"),
  });

  // Three keys -> three `choose` answers, then apply, then .gitignore is not
  // asked (this project has none).
  const prompter = new ScriptedPrompter(["plaintext", "project", "global", true]);
  expect(await runInit(options(root), prompter)).toBe(0);

  const env = readFileSync(join(root, ".env"), "utf8");
  expect(env).toContain("# app config");
  expect(env).toContain("NODE_ENV=development");
  expect(env).toContain("DATABASE_URL=kerstel://demo-app/DATABASE_URL");
  expect(env).toContain('OPENAI_API_KEY="kerstel://global/OPENAI_API_KEY" # from the console');
  expect(env).not.toContain("sk-project-key");
  expect(env).not.toContain("pw@localhost");

  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(`{
  "name": "@acme/demo-app",
  "scripts": {
    "dev": "kerstel exec -- next dev",
    "postinstall": "patch-package"
  }
}
`);

  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "demo-app", key: "DATABASE_URL" })).toBe(
      "postgres://u:pw@localhost:5432/app",
    );
    expect(vault.getSecret({ scope: "global", key: "OPENAI_API_KEY" })).toBe("sk-project-key");
    expect(vault.getSecret({ scope: "demo-app", key: "NODE_ENV" })).toBeNull();
    expect(vault.listProjects().map((p) => p.name)).toContain("demo-app");
  });

  const backups = readdirSync(join(backupsDir(), "demo-app"));
  expect(backups.length).toBe(1);
  expect(existsSync(join(backupsDir(), "demo-app", backups[0]!, ".env.enc"))).toBe(true);
});

test("init stores the highest-precedence value and points every file at it", async () => {
  isolateEnv({ prefix: "init-conflict" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": '{\n  "name": "conflicted",\n  "scripts": {\n    "dev": "vite"\n  }\n}\n',
    ".env": "API_TOKEN=base-value-aaaa\n",
    ".env.local": "API_TOKEN=local-value-bbbb\n",
  });

  expect(await runInit(options(root), new ScriptedPrompter(["project", true]))).toBe(0);

  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_TOKEN=kerstel://conflicted/API_TOKEN\n");
  expect(readFileSync(join(root, ".env.local"), "utf8")).toBe(
    "API_TOKEN=kerstel://conflicted/API_TOKEN\n",
  );
  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "conflicted", key: "API_TOKEN" })).toBe("local-value-bbbb");
  });
});

test("--dry-run prints the plan and leaves every file byte-identical", async () => {
  isolateEnv({ prefix: "init-dry" });

  const envSource = "SECRET_TOKEN=do-not-touch-me\n";
  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": envSource,
  });

  expect(await runInit(options(root, ["--dry-run", "--yes"]), new DefaultsPrompter())).toBe(0);

  expect(readFileSync(join(root, ".env"), "utf8")).toBe(envSource);
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(NPM_PACKAGE);
  expect(existsSync(backupsDir())).toBe(false);
  await openTestVault((vault) => {
    expect(vault.listSecrets().length).toBe(0);
  });
});

test("a bun project also gets a bunfig preload", async () => {
  isolateEnv({ prefix: "init-bun" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": '{\n  "name": "bunny",\n  "scripts": {\n    "dev": "bun run index.ts"\n  }\n}\n',
    "bun.lock": "",
    ".env": "SERVICE_TOKEN=bun-secret-value\n",
  });

  expect(await runInit(options(root), new ScriptedPrompter(["project", true]))).toBe(0);

  const bunfig = readFileSync(join(root, "bunfig.toml"), "utf8");
  expect(bunfig).toContain("preload = [");
  expect(bunfig).toContain("preload.cjs");
  expect(readFileSync(join(root, "package.json"), "utf8")).toContain(
    '"dev": "kerstel exec -- bun run index.ts"',
  );
});

test("a second run reports an already-migrated project and changes nothing", async () => {
  isolateEnv({ prefix: "init-again" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=first-run-value\n",
  });
  expect(await runInit(options(root), new ScriptedPrompter(["project", true]))).toBe(0);

  const envAfterFirst = readFileSync(join(root, ".env"), "utf8");
  const packageAfterFirst = readFileSync(join(root, "package.json"), "utf8");

  // No prompts at all the second time: nothing is left to decide.
  const second = new ScriptedPrompter([]);
  expect(await runInit(options(root), second)).toBe(0);
  expect(second.asked).toEqual([]);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe(envAfterFirst);
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(packageAfterFirst);
});

test("the teammate flow prompts for references the vault cannot resolve", async () => {
  isolateEnv({ prefix: "init-teammate" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=kerstel://demo-app/SERVICE_TOKEN\n",
  });

  // One `text` for the missing value, then the apply confirm (this fixture's
  // scripts are not wired yet, so there is still a change to approve).
  const prompter = new ScriptedPrompter(["teammate-supplied-value", true]);
  expect(await runInit(options(root), prompter)).toBe(0);
  expect(prompter.asked[0]).toContain("kerstel://demo-app/SERVICE_TOKEN");

  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "demo-app", key: "SERVICE_TOKEN" })).toBe("teammate-supplied-value");
  });
});

test("--non-interactive with a missing value exits 2 naming the flag", async () => {
  isolateEnv({ prefix: "init-noninteractive" });

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=kerstel://demo-app/SERVICE_TOKEN\n",
  });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await runInit(options(root, ["--non-interactive"]), new DefaultsPrompter())).toBe(2);
  } finally {
    console.log = realLog;
  }
  expect(captured.join("\n")).toContain("--from-stdin");
});

test("--keep forces plaintext and --global forces the global scope", async () => {
  isolateEnv({ prefix: "init-flags" });
  await bootLocalDaemon();

  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "KEEP_ME=keep-this-value\nSHARE_ME=share-this-value\n",
  });

  // Both keys are decided by flags, so the only question is the apply confirm.
  expect(
    await runInit(options(root, ["--keep", "KEEP_ME", "--global", "SHARE_ME"]), new ScriptedPrompter([true])),
  ).toBe(0);

  const env = readFileSync(join(root, ".env"), "utf8");
  expect(env).toContain("KEEP_ME=keep-this-value");
  expect(env).toContain("SHARE_ME=kerstel://global/SHARE_ME");
  await openTestVault((vault) => {
    expect(vault.getSecret({ scope: "global", key: "SHARE_ME" })).toBe("share-this-value");
    expect(vault.getSecret({ scope: "demo-app", key: "KEEP_ME" })).toBeNull();
  });
});

test(".gitignore is left alone by default and cleaned up only on an explicit yes", async () => {
  isolateEnv({ prefix: "init-gitignore" });
  await bootLocalDaemon();

  const gitignore = "node_modules/\n.env\n.env.*\ndist/\n";
  const rootDefault = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=a-secret-value\n",
    ".gitignore": gitignore,
  });
  // choose, apply, .gitignore -> no
  expect(await runInit(options(rootDefault), new ScriptedPrompter(["project", true, false]))).toBe(0);
  expect(readFileSync(join(rootDefault, ".gitignore"), "utf8")).toBe(gitignore);

  const rootYes = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "SERVICE_TOKEN=a-secret-value\n",
    ".gitignore": gitignore,
  });
  expect(await runInit(options(rootYes), new ScriptedPrompter(["project", true, true]))).toBe(0);
  const updated = readFileSync(join(rootYes, ".gitignore"), "utf8");
  expect(updated).toContain("# Kerstel: .env files hold references, safe to commit");
  expect(updated).toContain("node_modules/");
  expect(updated).toContain("dist/");
  expect(updated.split("\n")).not.toContain(".env");
  expect(updated.split("\n")).not.toContain(".env.*");
});

test("init refuses to run outside a project", async () => {
  isolateEnv({ prefix: "init-nopackage" });
  const root = makeProject({ ".env": "A=1\n" });
  expect(await runInit(options(root), new DefaultsPrompter())).toBe(2);
});

test("init reports a project with no env files instead of pretending to work", async () => {
  isolateEnv({ prefix: "init-noenv" });
  const root = makeProject({ "package.json": NPM_PACKAGE });
  expect(await runInit(options(root), new DefaultsPrompter())).toBe(1);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/cli/test/init.test.ts`
Expected: FAIL — cannot resolve module `../src/commands/init`.

- [ ] **Step 4: Write the key collector**

`packages/cli/src/init/collect.ts`:

```ts
import { readFileSync } from "node:fs";
import { parseReference, type SecretRef } from "../reference";
import type { EnvFileInfo } from "./detect";
import { entries, lookup, parseDotenv, type DotenvFile } from "./dotenv-file";

export interface LoadedEnvFile {
  info: EnvFileInfo;
  /** The file's bytes as read. The backup and every diff start from this. */
  original: string;
  file: DotenvFile;
}

export interface CollectedKey {
  key: string;
  /** The winning value: the one from the highest-precedence file. */
  value: string;
  /** The file that supplied it. */
  source: string;
  /** Every file this key appears in, highest precedence first. */
  files: string[];
  /** Lower-precedence files whose value DIFFERS from the winner. */
  conflicts: string[];
  /** Set when the winning value is already a kerstel:// reference. */
  reference: SecretRef | null;
}

export function loadEnvFiles(files: EnvFileInfo[]): LoadedEnvFile[] {
  return files.map((info) => {
    const original = readFileSync(info.path, "utf8");
    return { info, original, file: parseDotenv(original) };
  });
}

/**
 * Merges every `.env*` file into one key list, highest precedence first.
 *
 * v1 has no environments (spec §10), so a key defined in several files
 * collapses to ONE vault entry: the value from the highest-precedence file.
 * The other values survive only in the encrypted backup, and `init` warns
 * about every one of them by name -- silently dropping a value the developer
 * wrote would be the single worst thing this wizard could do.
 */
export function collectKeys(loaded: LoadedEnvFile[]): CollectedKey[] {
  const byKey = new Map<string, CollectedKey>();

  for (const entry of loaded) {
    for (const pair of entries(entry.file)) {
      // Within one file the LAST assignment wins, which is what lookup() gives.
      const value = lookup(entry.file, pair.key) ?? pair.value;
      const existing = byKey.get(pair.key);

      if (!existing) {
        byKey.set(pair.key, {
          key: pair.key,
          value,
          source: entry.info.name,
          files: [entry.info.name],
          conflicts: [],
          reference: parseReference(value),
        });
        continue;
      }

      // A key assigned twice inside one file is one occurrence of that file.
      if (existing.files.includes(entry.info.name)) continue;
      existing.files.push(entry.info.name);
      if (value !== existing.value) existing.conflicts.push(entry.info.name);
    }
  }

  return [...byKey.values()];
}
```

- [ ] **Step 5: Write the wizard**

`packages/cli/src/commands/init.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openContext } from "../context";
import { cliCommand } from "../daemon/spawn";
import { SUGGESTIONS, suggest, type Suggestion } from "../init/classify";
import { collectKeys, loadEnvFiles, type CollectedKey, type LoadedEnvFile } from "../init/collect";
import { createBackup } from "../init/backup";
import { detectProject, type DetectedProject } from "../init/detect";
import { parseDotenv, serializeDotenv, setValue } from "../init/dotenv-file";
import { deriveScope } from "../init/project-name";
import {
  DefaultsPrompter,
  NonInteractiveError,
  TtyPrompter,
  type Prompter,
} from "../init/prompts";
import { renderDiff, wireBunfig, wirePackageJson } from "../init/wiring";
import { bold, dim, fail, info, ok, yellow } from "../output";
import { GLOBAL_SCOPE, formatReference, isValidScope } from "../reference";
import { loadOrCreateDataKey } from "../vault/keychain";
import type { Vault } from "../vault/store";
import { preloadPathFor } from "./exec";

/**
 * Spec §8's setup wizard.
 *
 * Three rules shape every line below:
 *   1. NO PLAINTEXT IS EVER PRINTED. Not in the plan, not in a diff, not in an
 *      error, not in the self-check. The user is told a value's length and
 *      shape and nothing else; the value itself only ever moves between the
 *      file, the vault and the encrypted backup.
 *   2. NOTHING IS WRITTEN BEFORE THE USER SAYS YES, and the backup is written
 *      before anything else, so every step has an undo.
 *   3. --dry-run returns before the first write, having printed every diff.
 */

const GITIGNORE_NOTE = "# Kerstel: .env files hold references, safe to commit";
/** A .gitignore line that hides .env files (a `!` negation is left alone). */
const GITIGNORE_ENV_LINE = /^\s*\.env(\..*)?\s*$/;

export interface InitOptions {
  cwd: string;
  yes: boolean;
  dryRun: boolean;
  nonInteractive: boolean;
  fromStdin: boolean;
  scope?: string;
  globalKeys: Set<string>;
  keepKeys: Set<string>;
}

function splitKeys(raw: string): string[] {
  return raw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

export function parseInitArgs(args: string[], cwd: string): InitOptions | { error: string } {
  const options: InitOptions = {
    cwd,
    yes: false,
    dryRun: false,
    nonInteractive: false,
    fromStdin: false,
    globalKeys: new Set<string>(),
    keepKeys: new Set<string>(),
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--non-interactive") {
      options.nonInteractive = true;
    } else if (arg === "--from-stdin") {
      options.fromStdin = true;
    } else if (arg === "--scope") {
      const value = args[++i];
      // A flag as the next token means the value is missing, not that the
      // project is called "--yes".
      if (!value || value.startsWith("--")) return { error: "--scope needs a name, e.g. --scope my-app" };
      if (!isValidScope(value)) {
        return { error: `Invalid scope "${value}". Use a lowercase name of letters, digits, . _ or -.` };
      }
      options.scope = value;
    } else if (arg === "--global" || arg === "--keep") {
      const value = args[++i];
      if (!value || value.startsWith("--")) return { error: `${arg} needs a comma-separated list of KEYs` };
      const target = arg === "--global" ? options.globalKeys : options.keepKeys;
      for (const key of splitKeys(value)) target.add(key);
    } else {
      return {
        error:
          `Unknown option "${arg}". kerstel init accepts: --yes, --dry-run, --scope <name>, ` +
          "--global KEY[,KEY], --keep KEY[,KEY], --non-interactive, --from-stdin.",
      };
    }
  }

  return options;
}

/** Shape and size only. A value's CONTENT never reaches the terminal. */
function describeValue(value: string): string {
  if (value.trim() === "") return "empty";
  const kind = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? "url" : "opaque";
  return `${value.length} chars, ${kind}`;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

/**
 * Spec §8's teammate flow: the repository carries references, this machine's
 * vault does not carry the values. Ask for them, or read them as JSON.
 */
async function fillMissingReferences(
  missing: CollectedKey[],
  vault: Vault,
  options: InitOptions,
  prompter: Prompter,
): Promise<number> {
  console.log("");
  console.log(bold("Values this machine is missing"));
  for (const key of missing) {
    const ref = key.reference!;
    info(`${key.key.padEnd(28)} ${formatReference(ref.scope, ref.key)}`);
  }

  if (options.dryRun) {
    info("--dry-run: no values were requested and nothing was stored.");
    return 0;
  }

  let supplied: Record<string, string> = {};
  if (options.fromStdin) {
    const raw = await readStdin();
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      supplied = parsed as Record<string, string>;
    } catch {
      fail('--from-stdin expects a JSON object of {"KEY": "value"} on stdin.');
      return 2;
    }
  }

  for (const key of missing) {
    const ref = key.reference!;
    const reference = formatReference(ref.scope, ref.key);
    let value = supplied[key.key];
    if (value === undefined) {
      value = await prompter.text(`Value for ${reference}?`, { secret: true, flag: "--from-stdin" });
    }
    if (typeof value !== "string" || value === "") {
      fail(`No value supplied for ${reference}. Nothing was stored for it.`);
      return 2;
    }
    vault.setSecret(ref, value);
    ok(`Stored ${reference}`);
  }

  return 0;
}

interface Decision {
  key: CollectedKey;
  target: Suggestion;
}

async function decideTargets(
  keys: CollectedKey[],
  options: InitOptions,
  prompter: Prompter,
): Promise<Decision[]> {
  const decisions: Decision[] = [];
  for (const key of keys) {
    if (options.keepKeys.has(key.key)) {
      decisions.push({ key, target: "plaintext" });
      continue;
    }
    if (options.globalKeys.has(key.key)) {
      decisions.push({ key, target: "global" });
      continue;
    }
    const answer = await prompter.choose(
      `${key.key}  ${dim(`(${describeValue(key.value)}, from ${key.source})`)}`,
      [...SUGGESTIONS],
      suggest(key.key, key.value),
    );
    decisions.push({ key, target: answer as Suggestion });
  }
  return decisions;
}

interface FileChange {
  path: string;
  label: string;
  before: string;
  after: string;
}

function planEnvRewrites(loaded: LoadedEnvFile[], references: Map<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  for (const entry of loaded) {
    // Re-parse from the original bytes so a rewrite is always computed from
    // what is on disk, never from an object an earlier step already mutated.
    const copy = parseDotenv(entry.original);
    for (const [key, reference] of references) setValue(copy, key, reference);
    const after = serializeDotenv(copy);
    if (after !== entry.original) {
      changes.push({ path: entry.info.path, label: entry.info.name, before: entry.original, after });
    }
  }
  return changes;
}

/** Spec §8 step 5. Default NO: committing `.env` is the user's call, not ours. */
async function offerGitignore(root: string, prompter: Prompter): Promise<void> {
  const path = join(root, ".gitignore");
  if (!existsSync(path)) return;

  const source = readFileSync(path, "utf8");
  const parts = source.split(/(\r\n|\n)/);
  const hidden: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    if (GITIGNORE_ENV_LINE.test(text)) hidden.push(text.trim());
  }
  if (hidden.length === 0) return;

  console.log("");
  info(`.gitignore hides your env files: ${hidden.join(", ")}`);
  info("They now hold references, not secrets, so committing them gives teammates a living .env.example.");
  const remove = await prompter.confirm(
    "Remove those lines from .gitignore so the reference-only files can be committed?",
    false,
  );
  if (!remove) {
    info("Left .gitignore alone.");
    return;
  }

  const kept: string[] = [];
  let noteInserted = false;
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    const eol = parts[i + 1] ?? "";
    if (GITIGNORE_ENV_LINE.test(text)) {
      if (!noteInserted) {
        kept.push(GITIGNORE_NOTE, eol === "" ? "\n" : eol);
        noteInserted = true;
      }
      continue;
    }
    kept.push(text, eol);
  }

  const after = kept.join("");
  console.log(renderDiff(".gitignore", source, after));
  writeFileSync(path, after);
  ok("Updated .gitignore");
}

/**
 * Spec §8 step 6: prove the wiring works by running a probe through it.
 *
 * The probe spawns THIS CLI (`kerstel exec -- <runtime> -e ...`) with one
 * reference in its environment and compares what the child printed to what the
 * vault holds. Neither string is ever printed -- a self-check that leaks the
 * secret it is checking would defeat the product it is checking.
 */
async function selfCheck(
  detected: DetectedProject,
  probe: { key: string; reference: string; expected: string },
): Promise<"passed" | "failed" | "skipped"> {
  const runtime = detected.runtime === "bun" ? "bun" : "node";
  const expression = `process.stdout.write(String(process.env.${probe.key}))`;
  const command = cliCommand(["exec", "--", runtime, "-e", expression]);

  try {
    const child = Bun.spawn(command, {
      cwd: detected.root,
      env: { ...process.env, [probe.key]: probe.reference },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (code === 0 && stdout === probe.expected) return "passed";

    fail(
      `Self-check failed: a ${runtime} process wired through \`kerstel exec\` did not receive the ` +
        `value behind ${probe.reference}. Run \`kerstel doctor\` in this directory.`,
    );
    // stderr is the child's diagnostics, never the resolved value: the probe
    // writes the value to stdout, which is deliberately not echoed anywhere.
    if (stderr.trim().length > 0) console.log(dim(stderr.trim()));
    return "failed";
  } catch (error) {
    console.log(
      yellow(
        `!  Self-check skipped: could not run "${runtime}" (${(error as Error).message}). ` +
          "Your scripts are wired; run one to confirm.",
      ),
    );
    return "skipped";
  }
}

/**
 * The wizard proper. Wrapped by `runInit` below, which is what everything
 * calls: a NonInteractiveError raised anywhere in here means the same thing
 * (this run cannot answer its own question) and deserves the same exit code
 * whether it reached us through `initCommand` or straight from a test.
 */
async function runInitSteps(options: InitOptions, prompter: Prompter): Promise<number> {
  console.log(bold("kerstel init"));

  // --- Step 1: detect -----------------------------------------------------
  const detected = detectProject(options.cwd);
  if (!detected.packageJson) {
    fail(
      `No readable package.json in ${options.cwd}. Run \`kerstel init\` from your project root ` +
        "(Kerstel wires package scripts, so it needs one).",
    );
    return 2;
  }

  const scope = options.scope ?? deriveScope({
    packageName: detected.packageName,
    rootPath: detected.root,
  }).scope;

  info(`Runtime:    ${detected.runtime} (${detected.packageManager})`);
  info(`Scope:      ${bold(scope)}`);

  if (detected.envFiles.length === 0) {
    fail(
      "No .env files here. There is nothing to migrate yet -- create one, or store secrets " +
        "directly with `kerstel set <scope>/<KEY>`.",
    );
    return 1;
  }
  info(`Env files:  ${detected.envFiles.map((file) => file.name).join(", ")}`);

  // --- Step 2: parse ------------------------------------------------------
  const loaded = loadEnvFiles(detected.envFiles);
  for (const entry of loaded) {
    for (const unsupported of entry.file.unsupported) {
      console.log(
        yellow(
          `!  ${entry.info.name}:${unsupported.line} — ${unsupported.key} left untouched because ` +
            `${unsupported.reason}.`,
        ),
      );
    }
  }

  const keys = collectKeys(loaded);
  for (const key of keys) {
    if (key.conflicts.length === 0) continue;
    console.log(
      yellow(
        `!  ${key.key} differs between ${key.source} and ${key.conflicts.join(", ")}. Kerstel stores the ` +
          `${key.source} value and points every file at it; the others survive only in the encrypted ` +
          "backup. (v1 has no environments.)",
      ),
    );
  }

  const ctx = await openContext();
  try {
    const referenced = keys.filter((key) => key.reference !== null);
    const plain = keys.filter((key) => key.reference === null);

    // --- Teammate flow ----------------------------------------------------
    const missing = referenced.filter((key) => ctx.vault.getSecret(key.reference!) === null);
    if (missing.length > 0) {
      const code = await fillMissingReferences(missing, ctx.vault, options, prompter);
      if (code !== 0) return code;
    }

    // --- Step 3: classify and decide --------------------------------------
    const decisions = plain.length > 0 ? await decideTargets(plain, options, prompter) : [];

    const references = new Map<string, string>();
    for (const decision of decisions) {
      if (decision.target === "plaintext") continue;
      const target = decision.target === "global" ? GLOBAL_SCOPE : scope;
      references.set(decision.key.key, formatReference(target, decision.key.key));
    }
    for (const key of referenced) {
      // Already-migrated keys keep their existing reference, which the
      // rewrite planner needs so an unchanged file is detected as unchanged.
      references.set(key.key, key.value);
    }

    // --- Plan ---------------------------------------------------------------
    const envChanges = planEnvRewrites(loaded, references);

    const packageSource = readFileSync(detected.packageJsonPath, "utf8");
    const packageWiring = wirePackageJson(packageSource);

    const bunfigPath = join(detected.root, "bunfig.toml");
    const bunfigSource = existsSync(bunfigPath) ? readFileSync(bunfigPath, "utf8") : null;
    let bunfigWiring: { changed: boolean; created: boolean; contents: string } | null = null;
    if (detected.runtime === "bun") {
      try {
        bunfigWiring = wireBunfig(bunfigSource, preloadPathFor(ctx.hookDir));
      } catch (error) {
        fail((error as Error).message);
        return 1;
      }
    }

    const nothingToDo =
      envChanges.length === 0 && !packageWiring.changed && !(bunfigWiring?.changed ?? false);
    if (nothingToDo) {
      ok(`Already migrated: every value in ${detected.envFiles.map((f) => f.name).join(", ")} is a reference, and your scripts are wired.`);
      return 0;
    }

    if (decisions.length > 0) {
      console.log("");
      console.log(bold("Plan"));
      for (const decision of decisions) {
        const target =
          decision.target === "plaintext"
            ? dim("stays plaintext")
            : formatReference(decision.target === "global" ? GLOBAL_SCOPE : scope, decision.key.key);
        info(`${decision.key.key.padEnd(28)} ${target}`);
      }
    }

    console.log("");
    for (const change of envChanges) console.log(renderDiff(change.label, change.before, change.after));
    if (packageWiring.changed) console.log(renderDiff("package.json", packageSource, packageWiring.contents));
    if (bunfigWiring?.changed) {
      console.log(renderDiff("bunfig.toml", bunfigSource ?? "", bunfigWiring.contents));
    }

    // --- Step 4: --dry-run stops here, before the first write ---------------
    if (options.dryRun) {
      console.log("");
      info("--dry-run: nothing was written.");
      return 0;
    }

    console.log("");
    if (!(await prompter.confirm("Apply these changes to your files and vault?", true))) {
      info("Nothing was changed.");
      return 0;
    }

    // --- Step 5: backup, then store, then rewrite ---------------------------
    // openContext() holds the data key privately; this reads the same key from
    // the same credential store rather than widening CliContext to expose it.
    const { key: dataKey } = await loadOrCreateDataKey();
    const backup = createBackup({
      scope,
      dataKey,
      files: loaded.map((entry) => ({ name: entry.info.name, contents: entry.original })),
    });
    ok(`Encrypted backup of your originals: ${backup.dir}`);

    ctx.vault.registerProject(scope, detected.root);
    let stored = 0;
    for (const decision of decisions) {
      if (decision.target === "plaintext") continue;
      ctx.vault.setSecret(
        { scope: decision.target === "global" ? GLOBAL_SCOPE : scope, key: decision.key.key },
        decision.key.value,
      );
      stored += 1;
    }
    if (stored > 0) ok(`Stored ${stored} secret${stored === 1 ? "" : "s"} in the vault.`);

    for (const change of envChanges) writeFileSync(change.path, change.after);
    if (envChanges.length > 0) ok(`Rewrote ${envChanges.map((c) => c.label).join(", ")} with references.`);

    // --- Step 6: wire -------------------------------------------------------
    if (packageWiring.changed) {
      writeFileSync(detected.packageJsonPath, packageWiring.contents);
      ok(`Wired ${packageWiring.rewrites.length} package.json script${packageWiring.rewrites.length === 1 ? "" : "s"} through \`kerstel exec\`.`);
    }
    if (bunfigWiring?.changed) {
      writeFileSync(bunfigPath, bunfigWiring.contents);
      ok(`${bunfigWiring.created ? "Created" : "Updated"} bunfig.toml with the Kerstel preload.`);
    }

    await offerGitignore(detected.root, prompter);

    // --- Step 7: self-check -------------------------------------------------
    const probeDecision = decisions.find((decision) => decision.target !== "plaintext");
    if (probeDecision) {
      const probeScope = probeDecision.target === "global" ? GLOBAL_SCOPE : scope;
      const expected = ctx.vault.getSecret({ scope: probeScope, key: probeDecision.key.key });
      if (expected !== null) {
        console.log("");
        const result = await selfCheck(detected, {
          key: probeDecision.key.key,
          reference: formatReference(probeScope, probeDecision.key.key),
          expected,
        });
        if (result === "failed") return 1;
        if (result === "passed") ok("Self-check passed: a wired process resolved a reference.");
      }
    }

    console.log("");
    ok(`${bold(scope)} is set up. Run your scripts exactly as before — \`${detected.packageManager} run <script>\` now goes through Kerstel.`);
    return 0;
  } finally {
    ctx.vault.close();
  }
}

export async function runInit(options: InitOptions, prompter: Prompter): Promise<number> {
  try {
    return await runInitSteps(options, prompter);
  } catch (error) {
    if (error instanceof NonInteractiveError) {
      fail(error.message);
      return 2;
    }
    throw error;
  }
}

function choosePrompter(options: InitOptions): Prompter | null {
  if (options.yes || options.nonInteractive) return new DefaultsPrompter();
  if (process.stdin.isTTY !== true) return null;
  return new TtyPrompter();
}

export async function initCommand(args: string[], prompterOverride?: Prompter): Promise<number> {
  const parsed = parseInitArgs(args, process.cwd());
  if ("error" in parsed) {
    fail(parsed.error);
    return 2;
  }

  const prompter = prompterOverride ?? choosePrompter(parsed);
  if (!prompter) {
    fail(
      "kerstel init asks questions, and this is not a terminal. Re-run with --yes to accept every " +
        "suggestion, or --non-interactive to fail loudly on anything it cannot decide.",
    );
    return 2;
  }

  return runInit(parsed, prompter);
}
```

- [ ] **Step 6: Wire the command into the CLI**

In `packages/cli/src/index.ts`, add the import:

```ts
import { initCommand } from "./commands/init";
```

add the case as the FIRST case in the switch (it is the command a new user runs first):

```ts
      case "init":
        return await initCommand(args);
```

and add the usage line directly above the `kerstel set` line:

```
  kerstel init [--yes] [--dry-run]              Migrate this project's .env files
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test packages/cli/test/init.test.ts`
Expected: PASS, 15 tests. The full-migration tests each spawn a child CLI for the self-check, so this file is slower than its neighbours — a few seconds is normal.

- [ ] **Step 8: Run the whole suite**

Run: `bun run typecheck && bun test`
Expected: PASS. `daemon-client.test.ts` and `cli.test.ts` must stay green — `daemonServeCommand()` changed shape but not behaviour.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/init/collect.ts packages/cli/src/commands/init.ts packages/cli/src/daemon/spawn.ts packages/cli/src/index.ts packages/cli/test/init.test.ts
git commit -m "feat(cli): add the kerstel init setup wizard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: `doctor` reports on the project you are standing in

Spec §6.3 and §8: `doctor` is what diagnoses wiring. Until now it only knew about the machine.

**Files:**
- Create: `packages/cli/src/init/status.ts`
- Modify: `packages/cli/src/commands/doctor.ts` (takes an optional `cwd`, prints a project section)
- Test: `packages/cli/test/init-status.test.ts`

**Interfaces:**
- Consumes: `detectProject`, `loadEnvFiles`, `collectKeys`, `deriveScope`, `wirePackageJson`, `wireBunfig`, `preloadPathFor`, `formatReference`, `Vault.getSecret`.
- Produces:
  - `interface ProjectStatus { root: string; scope: string | null; runtime: Runtime; packageManager: PackageManager; envFiles: string[]; scripts: { wrappable: number; wired: number }; bunfig: "not-applicable" | "present" | "missing" | "unknown"; references: { total: number; resolvable: number; unresolved: string[] } }`
  - `projectStatus(root: string, vault: { getSecret(ref: SecretRef): string | null }, hookDir: string): ProjectStatus | null`
  - `doctorCommand(cwd?: string): Promise<number>` (widened signature)

- [ ] **Step 1: Write the failing test**

`packages/cli/test/init-status.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorCommand } from "../src/commands/doctor";
import { projectStatus } from "../src/init/status";
import { runCli } from "../src/index";
import { hookDir } from "../src/paths";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

afterEach(() => {
  restoreEnv();
});

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-status-"));
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  return root;
}

const emptyVault = { getSecret: () => null };

test("projectStatus returns null outside a project", () => {
  const root = makeProject({ ".env": "A=1\n" });
  expect(projectStatus(root, emptyVault, "/hook")).toBeNull();
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/init-status.test.ts`
Expected: FAIL — cannot resolve module `../src/init/status`.

- [ ] **Step 3: Write the status module**

`packages/cli/src/init/status.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { preloadPathFor } from "../commands/exec";
import { formatReference, type SecretRef } from "../reference";
import { collectKeys, loadEnvFiles } from "./collect";
import { detectProject, type PackageManager, type Runtime } from "./detect";
import { deriveScope } from "./project-name";
import { wireBunfig, wirePackageJson } from "./wiring";

export interface ProjectStatus {
  root: string;
  /** Null when no valid scope can be derived -- the user must pass --scope. */
  scope: string | null;
  runtime: Runtime;
  packageManager: PackageManager;
  envFiles: string[];
  /** `wrappable` counts scripts `init` would wire; `wired` those already wired. */
  scripts: { wrappable: number; wired: number };
  bunfig: "not-applicable" | "present" | "missing" | "unknown";
  references: { total: number; resolvable: number; unresolved: string[] };
}

/**
 * What `doctor` knows about the directory it is standing in. Returns null when
 * there is no project here, so `doctor` can simply skip the section.
 *
 * Everything is derived by ASKING THE SAME FUNCTIONS `init` uses -- "is this
 * wired?" is answered by running the wirer and seeing whether it would change
 * anything. A second, parallel notion of "wired" would eventually disagree
 * with the first, and the disagreement would show up as `doctor` calling a
 * working project broken.
 */
export function projectStatus(
  root: string,
  vault: { getSecret(ref: SecretRef): string | null },
  hookDir: string,
): ProjectStatus | null {
  const detected = detectProject(root);
  if (!detected.packageJson) return null;

  let scope: string | null;
  try {
    scope = deriveScope({ packageName: detected.packageName, rootPath: detected.root }).scope;
  } catch {
    scope = null;
  }

  const packageSource = readFileSync(detected.packageJsonPath, "utf8");
  const wiring = wirePackageJson(packageSource);
  const wired = wiring.skipped.filter((skip) => skip.reason === "already-wired").length;

  let bunfig: ProjectStatus["bunfig"] = "not-applicable";
  if (detected.runtime === "bun") {
    const path = join(root, "bunfig.toml");
    const source = existsSync(path) ? readFileSync(path, "utf8") : null;
    try {
      bunfig = wireBunfig(source, preloadPathFor(hookDir)).changed ? "missing" : "present";
    } catch {
      // A multi-line preload array: present or not, this cannot say which.
      bunfig = "unknown";
    }
  }

  let total = 0;
  let resolvable = 0;
  const unresolved: string[] = [];
  for (const key of collectKeys(loadEnvFiles(detected.envFiles))) {
    if (!key.reference) continue;
    total += 1;
    if (vault.getSecret(key.reference) !== null) resolvable += 1;
    else unresolved.push(formatReference(key.reference.scope, key.reference.key));
  }

  return {
    root,
    scope,
    runtime: detected.runtime,
    packageManager: detected.packageManager,
    envFiles: detected.envFiles.map((file) => file.name),
    scripts: { wrappable: wired + wiring.rewrites.length, wired },
    bunfig,
    references: { total, resolvable, unresolved },
  };
}
```

- [ ] **Step 4: Extend `doctor`**

In `packages/cli/src/commands/doctor.ts`, add the import:

```ts
import { projectStatus } from "../init/status";
```

change the signature from `export async function doctorCommand(): Promise<number> {` to:

```ts
export async function doctorCommand(cwd: string = process.cwd()): Promise<number> {
```

and insert this block immediately before the `if (await isDaemonRunning())` line:

```ts
    // Spec §6.3: wiring problems are diagnosed here, in the project, because
    // that is where they are: a machine can be perfectly set up and a project
    // still unwired.
    const project = projectStatus(cwd, ctx.vault, ctx.hookDir);
    if (project) {
      console.log("");
      console.log(bold("Project"));
      info(`Root:       ${project.root}`);
      info(
        `Scope:      ${project.scope ?? yellow("could not be derived — pass --scope to `kerstel init`")}`,
      );
      info(`Runtime:    ${project.runtime} (${project.packageManager})`);
      info(
        `Scripts:    ${project.scripts.wired} of ${project.scripts.wrappable} script${project.scripts.wrappable === 1 ? "" : "s"} wired through \`kerstel exec\`` +
          (project.scripts.wired < project.scripts.wrappable ? yellow("  (run `kerstel init`)") : ""),
      );
      if (project.bunfig !== "not-applicable") {
        info(
          `bunfig:     preload ${project.bunfig}` +
            (project.bunfig === "present" ? "" : yellow("  (run `kerstel init`)")),
        );
      }
      info(
        `References: ${project.references.resolvable} of ${project.references.total} reference${project.references.total === 1 ? "" : "s"} in ${project.envFiles.join(", ") || "no env files"} resolve here`,
      );
      for (const missing of project.references.unresolved) {
        console.log(yellow(`!  ${missing} has no value in this vault. Run \`kerstel init\` to supply it.`));
      }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/cli/test/init-status.test.ts packages/cli/test/cli.test.ts`
Expected: PASS. `cli.test.ts`'s existing doctor test still passes — `doctorCommand()` keeps working with no argument, and a temp `KERSTEL_HOME` is not a project directory, so no project section appears there.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/status.ts packages/cli/src/commands/doctor.ts packages/cli/test/init-status.test.ts
git commit -m "feat(cli): report project wiring and reference health in doctor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: End-to-end proof and documentation

The one test that proves the whole product claim: a shipped binary migrates a project, and the developer's **own script**, run the way npm runs it, still sees the secret.

**Files:**
- Modify: `packages/cli/test/e2e.test.ts` (one new test; add `dirname` to the `node:path` import)
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-17-kerstel-secrets-manager-design.md` (§8)

**Interfaces:**
- Consumes: the compiled binary at `dist/kerstel`, built by the existing `beforeAll` in `e2e.test.ts`; `kerstel init`, `kerstel exec` (Tasks 6 and 9).
- Produces: no new source interfaces.

**CI note:** no workflow change is needed. The fixture carries a `package-lock.json` for detection only — nothing in this suite runs npm, pnpm or yarn, which is exactly why the fixture uses lockfile PRESENCE rather than a real install.

- [ ] **Step 1: Write the end-to-end test**

In `packages/cli/test/e2e.test.ts`, change the path import to:

```ts
import { dirname, join, resolve } from "node:path";
```

and append this test:

```ts
// Windows has no `sh`, and this test's whole point is running the rewritten
// script the way a package manager would -- through a shell.
test.if(process.platform !== "win32")(
  "the binary migrates a project and the rewritten script still resolves the secret",
  async () => {
    home = mkdtempSync(join(tmpdir(), "kerstel-e2e-init-"));
    const project = mkdtempSync(join(tmpdir(), "kerstel-e2e-init-project-"));

    const printScript = 'node -e "process.stdout.write(String(process.env.APP_KEY))"';
    await Bun.write(
      join(project, "package.json"),
      `${JSON.stringify({ name: "e2e-demo", scripts: { printkey: printScript } }, null, 2)}\n`,
    );
    // Presence is all the detector needs; nothing here runs npm.
    await Bun.write(join(project, "package-lock.json"), "{}\n");
    await Bun.write(join(project, ".env"), "APP_KEY=super-secret-e2e\n");

    const init = Bun.spawn([BINARY, "init", "--yes", "--non-interactive"], {
      cwd: project,
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [initOut, initErr, initCode] = await Promise.all([
      new Response(init.stdout).text(),
      new Response(init.stderr).text(),
      init.exited,
    ]);
    if (initCode !== 0) console.error(initOut + initErr);
    expect(initCode).toBe(0);
    // The wizard prints a plan, a diff and a self-check result -- and never the
    // secret it is migrating.
    expect(initOut).not.toContain("super-secret-e2e");

    expect(await Bun.file(join(project, ".env")).text()).toBe("APP_KEY=kerstel://e2e-demo/APP_KEY\n");

    const rewritten = JSON.parse(await Bun.file(join(project, "package.json")).text()) as {
      scripts: Record<string, string>;
    };
    expect(rewritten.scripts.printkey).toBe(`kerstel exec -- ${printScript}`);

    // Run it exactly as npm would: the script text through a shell, in the
    // project directory, with the binary's directory on PATH and the .env
    // reference in the environment.
    const run = Bun.spawn(["sh", "-c", rewritten.scripts.printkey as string], {
      cwd: project,
      env: env({
        APP_KEY: "kerstel://e2e-demo/APP_KEY",
        PATH: `${dirname(BINARY)}:${process.env.PATH ?? ""}`,
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    if (code !== 0) console.error(stdout + stderr);

    expect(code).toBe(0);
    expect(stdout).toBe("super-secret-e2e");
  },
);
```

- [ ] **Step 2: Run the end-to-end suite**

Run: `bun test packages/cli/test/e2e.test.ts`
Expected: PASS, 7 tests. The build step in `beforeAll` runs first and must succeed.

- [ ] **Step 3: Update the README**

In `README.md`, insert this section between the `## Usage` section and `## Security model`:

```markdown
## Set up a project

```bash
cd my-app
kerstel init
```

The wizard walks through six steps and asks before each one:

1. **Detect** your runtime and package manager from your lockfile.
2. **Parse** every `.env` / `.env.*` file in the project root (templates like `.env.example` are skipped) and show what it found — key names, value sizes and shapes, never the values themselves. For each key you choose: store it in this **project**'s scope, point it at a **global** key shared across all your projects, or leave it as **plaintext** (right for `NODE_ENV`, ports and public URLs).
3. **Back up** the originals, encrypted with your vault key, to `~/.kerstel/backups/<project>/<timestamp>/`.
4. **Rewrite** the files, changing only the bytes of the values it stored. Comments, blank lines, key order, quoting style and inline comments all survive byte for byte.
5. **Wire** the hook: every `package.json` script becomes `kerstel exec -- <your original command>` (npm lifecycle hooks are never wrapped), and Bun projects also get a `preload` entry in `bunfig.toml`. You see the diff first.
6. **Self-check** by running a probe through the wiring and confirming a reference resolves.

Afterwards `npm run dev` is still `npm run dev`.

Useful flags:

| Flag | What it does |
|---|---|
| `--dry-run` | Prints every diff and writes nothing. Run this first. |
| `--yes` | Accepts every suggestion, asks nothing. |
| `--scope <name>` | Overrides the project scope (default: your `package.json` name). |
| `--global KEY[,KEY]` | Forces those keys into the `global` scope. |
| `--keep KEY[,KEY]` | Forces those keys to stay plaintext. |
| `--non-interactive` | Fails loudly instead of asking; use in scripts. |
| `--from-stdin` | Reads `{"KEY": "value"}` JSON for keys this machine is missing. |

`kerstel init` is idempotent: run it again after adding a key and it migrates only what is new.

### One key, several files

If the same key appears in more than one file with different values, Kerstel stores the highest-precedence one — `.env.<x>.local` beats `.env.local` beats `.env.<x>` beats `.env` — points **every** occurrence at that one reference, and tells you which files it collapsed. The other values remain in the encrypted backup. v1 has no environments (that is on the roadmap), so one key resolves to one value.

### Joining a project that already uses Kerstel

```bash
git clone git@github.com:acme/my-app.git && cd my-app
kerstel init
```

The committed `.env` holds references, so `init` lists the keys your vault does not have yet and prompts for each one with the echo turned off. The references double as a living `.env.example`. To supply them from a script instead:

```bash
echo '{"DATABASE_URL":"postgres://...","STRIPE_SECRET_KEY":"sk_live_..."}' | kerstel init --from-stdin --non-interactive
```

Secrets are never accepted as command-line arguments — anything on argv is in your shell history and in `ps` output.

### `kerstel exec` vs `kerstel run`

| | `kerstel exec -- <cmd>` | `kerstel run -- <cmd>` |
|---|---|---|
| What the child's environment holds | references, untouched | resolved plaintext |
| When values are resolved | lazily, on each `process.env` read, through the daemon | all at once, before the command starts |
| What it needs | the runtime hook (Node or Bun) | nothing |
| Audit log | one row per key the app actually reads | one row per reference in the environment |
| Used by | your wired `package.json` scripts | IDE run configurations, other languages, anything the hook cannot reach |

`exec` is what the wizard writes into your scripts; `run` is the universal fallback that always works.
```

- [ ] **Step 4: Add the precedence sentence to the spec**

In `docs/superpowers/specs/2026-09-17-kerstel-secrets-manager-design.md`, in §8, insert this paragraph directly after the six-item `kerstel init` list and before the `**Teammate flow:**` paragraph:

```markdown
When one key appears in several files with different values, `init` stores the highest-precedence one (`.env.<x>.local` > `.env.local` > `.env.<x>` > `.env`), rewrites every occurrence to that single reference, keeps the losing values only in the encrypted backup, and names the affected files — v1 has no environments, so one key resolves to exactly one value.
```

- [ ] **Step 5: Run the whole suite**

Run: `bun run typecheck && bun test`
Expected: every test passes on macOS and Linux.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/test/e2e.test.ts README.md docs/superpowers/specs/2026-09-17-kerstel-secrets-manager-design.md
git commit -m "test: prove a migrated project's own scripts resolve references

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Plan Self-Review

**1. Spec coverage.**

| Spec | Requirement | Task |
|---|---|---|
| §3 | No plaintext in a project file after migration; level-1 boundary unchanged | Tasks 1, 5, 9 (the `.env` rewrite, the encrypted backup, `describeValue` never printing a value) |
| §6.2 | Bun projects: `preload` in `bunfig.toml` | Tasks 7, 9 |
| §6.2 | Node projects: scripts prefixed through a `kerstel exec` shim that sets `NODE_OPTIONS=--require <hook>`, user approves the diff | Tasks 6, 7, 9 |
| §6.2 | `kerstel run` stays the universal fallback | Unchanged from plan 1; documented against `exec` in Task 11 |
| §6.3 | Build-time snapshotting works because build scripts are wired too | Task 7 (every non-lifecycle script, including `build`) |
| §6.3 | Edge cases diagnosed by `doctor` | Task 10 |
| §8 step 1 | Detect runtime + package manager | Task 3 |
| §8 step 2 | Parse `.env` and variants, show findings, per-key project/global/plaintext | Tasks 1, 3, 4, 9 |
| §8 step 3 | Encrypted backup, then rewrite with references | Tasks 5, 9 |
| §8 step 4 | Wire the hook, show the diff for approval | Tasks 7, 9 |
| §8 step 5 | Offer the `.gitignore` update | Task 9 (`offerGitignore`, default no) |
| §8 step 6 | Self-check by spawning a probe through the wired scripts | Task 9 (`selfCheck`), proved against the binary in Task 11 |
| §8 | Teammate flow: list keys the vault lacks, prompt for values | Task 9 (`fillMissingReferences`, `--from-stdin`) |
| §12 | Wizard fixture projects (npm/pnpm/yarn/bun, messy multi-file `.env`s) run non-interactively; assert rewrites, backups, wiring, self-check | Task 9 covers npm, bun, conflict, already-migrated, teammate, dry-run; Task 3 covers pnpm/yarn detection from lockfile presence without needing those tools installed |
| §13 | "Wizard rewrites user files" → diff + consent per step, encrypted backups | Tasks 5, 7, 9 |

Deliberately out of scope and named in the Scope line: §9 portal, §11 website, `install.sh`/`uninstall`, §10 sync and environments. `uninstall` is partially prepared — `restoreBackup()` (Task 5) is the half of it that has to exist before any file is rewritten.

**2. Placeholder scan.** No "TBD", no "similar to Task N", no "add error handling", no "write tests for the above". Every code step carries complete code; the two Bun branches in Task 6 (Steps 7 and 8) are both written out in full because which one applies is a fact about Bun that the probe in Step 6 establishes, not a decision left to the implementer. Every type named in a later task is defined in an earlier one: `DotenvFile`/`setValue` (1) → 9, 10; `deriveScope` (2) → 9, 10; `DetectedProject`/`EnvFileInfo` (3) → 9, 10; `Suggestion`/`SUGGESTIONS` (4) → 9; `createBackup` (5) → 9; `preloadPathFor` (6) → 9, 10; `wirePackageJson`/`wireBunfig`/`renderDiff` (7) → 9, 10; `Prompter` (8) → 9; `collectKeys`/`loadEnvFiles` (9) → 10; `cliCommand` (9, in `daemon/spawn.ts`) → 9's self-check.

**3. Type consistency.** `Suggestion` is the single union used for classification, for the `choose` options and for `Decision.target` — one name, one meaning. `CollectedKey.conflicts` is `string[]` (file names) everywhere. `BunfigWiring` is `{ changed, created, contents }` in Task 7 and consumed with exactly those fields in Tasks 9 and 10. `ScriptSkip.reason` is `"lifecycle" | "already-wired" | "not-a-string"` in Task 7 and filtered on `"already-wired"` in Task 10. `projectStatus` takes `{ getSecret }` structurally, so `Vault` satisfies it without the status module importing the store. `doctorCommand(cwd?)` keeps its zero-argument call site in `index.ts` working.

**4. Refinements made while writing, with reasons.**
- `restoreBackup(scope, timestamp, targetDir, dataKey)` takes a fourth parameter: decrypting requires the data key, and reaching into the keychain from inside a pure file module would make it untestable and give it a second reason to fail.
- `TextOptions` carries an optional `flag` beside `secret`, so the non-interactive failure can name the exact flag that would have supplied the answer — ruling 8 requires that message, and the flag has to arrive from the call site.
- `TtyPrompter` takes injectable input/output streams (defaulting to `process.stdin`/`process.stdout`) so the no-echo path is actually tested rather than asserted in prose.
- `slugifyScope` trims `_` from the ends as well as `-` and `.`, because `isValidScope` requires an alphanumeric first character and a leading underscore would otherwise produce an "impossible" invalid scope.
- `init` uses two write-consent points (per-key `choose`, then one apply `confirm` under the complete diff) rather than one per step: a confirm per step with the diff already shown trains users to hold down `y`, which is the opposite of consent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-18-init-wizard.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.
