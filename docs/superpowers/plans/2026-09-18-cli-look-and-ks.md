# The `ks` shortcut and a friendlier CLI: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `ks` shortcut, and give `init`, `doctor`, `uninstall`, and bare `ks` a friendly, interactive terminal look, without changing what any command does to files, the vault, or keys.

**Architecture:** A new `packages/cli/src/ui/` module owns colour, symbols, the braille banner, tables, and the invoked command name. `@clack/prompts` powers the interactive prompts through a new `ClackPrompter` behind the existing `Prompter` interface, so the wizard's logic never depends on the library. When stdout is not a TTY, every command prints the same plain lines it does today, so tests and CI read stable text.

**Tech Stack:** Bun 1.4.2, TypeScript strict, `bun:test`, `@clack/prompts` 1.8.x, POSIX `sh` for `install.sh`.

**Spec:** `docs/superpowers/specs/2026-09-18-cli-look-and-ks-design.md`

## Global Constraints

- Never print a secret value: not in the overview, a diff, an error, a test, or the pseudo-terminal test. Values headed for the vault show only their length (`•••• 64 chars`).
- Nothing is written before the user approves. Every prompt, including the `.gitignore` question, comes before the first write.
- `init` still writes `kerstel exec -- ` into `package.json` scripts, never `ks`.
- Hints that name a command use `cliName()`: `ks` when invoked as `ks`, otherwise `kerstel`.
- Accent colour `#4ade80` (24-bit when `COLORTERM` is `truecolor` or `24bit`, otherwise ANSI green). `NO_COLOR` or a non-TTY stdout means no colour.
- Symbols: `✓` pass, `!` warning, `✗` problem, `·` information.
- Ctrl-C or Esc at a prompt: print `Cancelled. Nothing was changed.` and exit 130.
- `--yes`, `--keep`, `--global`, `--dry-run`, `--from-stdin`, `--force` behave exactly as now.
- Every PR that changes `packages/*/src` touches `CHANGELOG.md` (Task 10 adds the lines; earlier task commits on the same branch are fine without them).
- Tests: `bun run test` from the repo root builds the hook first. The macOS Keychain tests need `KERSTEL_ALLOW_REAL_KEYCHAIN_TESTS=1`; never touch the real `dev.kerstel.vault` item.
- Conventional Commits, and end every commit message with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File structure

| File | Responsibility |
| --- | --- |
| `packages/cli/src/ui/theme.ts` (new) | Colour decision, colour functions, symbols |
| `packages/cli/src/ui/cli-name.ts` (new) | `cliName()` |
| `packages/cli/src/ui/banner.ts` (new) | Braille bird, `renderBanner()` |
| `packages/cli/src/ui/table.ts` (new) | `renderTable()` measured by display width |
| `packages/cli/src/ui/steps.ts` (new) | `step()`, `note()`, `withSpinner()`: clack in a TTY, plain lines otherwise |
| `packages/cli/src/output.ts` | Keeps `ok`/`fail`/`info`, now built on `theme.ts` |
| `packages/cli/src/init/prompts.ts` | `Prompter` gains `select`/`multiselect`; `ClackPrompter` replaces `TtyPrompter`; `CancelledError` |
| `packages/cli/src/init/classify.ts` | `explain()` returns the suggestion and its reason |
| `packages/cli/src/init/detect.ts` | `framework` on `DetectedProject` |
| `packages/cli/src/init/overview.ts` (new) | Pure renderers: the grouped overview, the per-file change summary |
| `packages/cli/src/commands/init.ts` | The new flow |
| `packages/cli/src/doctor/checks.ts` (new) | Pure: gathers `Check[]` from context, project status, and environment |
| `packages/cli/src/commands/doctor.ts` | Renders checks, `--verbose`, exit code |
| `packages/cli/src/commands/uninstall.ts` | New look, `select` confirm, removes the `ks` link |
| `packages/cli/src/index.ts` | Bare `ks` banner and help |
| `apps/website/src/static/install.sh` | Creates the `ks` link |
| `.github/workflows/release.yml` | Keychain grep wording, `ks --version` in the installer job |

---

### Task 1: Theme, symbols, `cliName()`, and the clack dependency

**Files:**
- Create: `packages/cli/src/ui/theme.ts`, `packages/cli/src/ui/cli-name.ts`
- Modify: `packages/cli/src/output.ts`, `packages/cli/package.json`, `bun.lock`
- Test: `packages/cli/test/ui-theme.test.ts`

**Interfaces:**
- Produces: `detectTheme(stream?, env?): ThemeEnv`, `makeTheme(env: ThemeEnv): Theme`, `theme: Theme` (module default), `SYMBOLS`, `cliName(argv0?: string): "ks" | "kerstel"`. `Theme` has `color: boolean` and `accent`, `dim`, `bold`, `red`, `yellow`, `green`: `(text: string) => string`.
- `output.ts` keeps its exports (`dim`, `bold`, `green`, `red`, `yellow`, `ok`, `fail`, `info`, `mask`), now built on `theme`; `ok` prints `✓`, `fail` prints `✗`.

- [ ] **Step 1: Add the dependency**

Run: `bun add --cwd packages/cli @clack/prompts@^1.8.1`
Then prove it survives compilation: `bun run --cwd packages/hook build && bun run --cwd packages/cli build && ./dist/kerstel --version`
Expected: prints `0.1.0`.

- [ ] **Step 2: Write the failing test**

```ts
// packages/cli/test/ui-theme.test.ts
import { expect, test } from "bun:test";
import { cliName } from "../src/ui/cli-name";
import { detectTheme, makeTheme, SYMBOLS } from "../src/ui/theme";

test("colour is on only for a TTY without NO_COLOR", () => {
  expect(makeTheme({ isTTY: true, noColor: false, truecolor: false }).color).toBe(true);
  expect(makeTheme({ isTTY: false, noColor: false, truecolor: false }).color).toBe(false);
  expect(makeTheme({ isTTY: true, noColor: true, truecolor: false }).color).toBe(false);
});

test("the accent is 24-bit green on a truecolor terminal and ANSI green otherwise", () => {
  expect(makeTheme({ isTTY: true, noColor: false, truecolor: true }).accent("x")).toBe("\x1b[38;2;74;222;128mx\x1b[39m");
  expect(makeTheme({ isTTY: true, noColor: false, truecolor: false }).accent("x")).toBe("\x1b[32mx\x1b[39m");
  expect(makeTheme({ isTTY: false, noColor: false, truecolor: true }).accent("x")).toBe("x");
});

test("detectTheme reads NO_COLOR and COLORTERM", () => {
  const tty = { isTTY: true } as NodeJS.WriteStream;
  expect(detectTheme(tty, { NO_COLOR: "1" })).toEqual({ isTTY: true, noColor: true, truecolor: false });
  expect(detectTheme(tty, { COLORTERM: "24bit" })).toEqual({ isTTY: true, noColor: false, truecolor: true });
  expect(detectTheme({ isTTY: false } as NodeJS.WriteStream, {})).toEqual({ isTTY: false, noColor: false, truecolor: false });
});

test("symbols", () => {
  expect(SYMBOLS).toEqual({ pass: "✓", warn: "!", problem: "✗", info: "·" });
});

test("cliName is ks only when invoked as ks", () => {
  expect(cliName("ks")).toBe("ks");
  expect(cliName("/Users/me/.local/bin/ks")).toBe("ks");
  expect(cliName("./kerstel")).toBe("kerstel");
  expect(cliName("bun")).toBe("kerstel");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test packages/cli/test/ui-theme.test.ts`
Expected: FAIL, cannot find module `../src/ui/theme`.

- [ ] **Step 4: Implement**

```ts
// packages/cli/src/ui/theme.ts
/** Every colour and symbol the CLI prints comes from here. Spec §4.1. */

export interface ThemeEnv {
  isTTY: boolean;
  noColor: boolean;
  truecolor: boolean;
}

export interface Theme {
  color: boolean;
  accent: (text: string) => string;
  dim: (text: string) => string;
  bold: (text: string) => string;
  red: (text: string) => string;
  yellow: (text: string) => string;
  green: (text: string) => string;
}

export function detectTheme(
  stream: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout,
  env: Record<string, string | undefined> = process.env,
): ThemeEnv {
  return {
    isTTY: stream.isTTY === true,
    noColor: Boolean(env.NO_COLOR),
    truecolor: env.COLORTERM === "truecolor" || env.COLORTERM === "24bit",
  };
}

export function makeTheme(env: ThemeEnv): Theme {
  const color = env.isTTY && !env.noColor;
  const sgr = (open: string, close: string) => (text: string) =>
    color ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  return {
    color,
    accent: color && env.truecolor ? sgr("38;2;74;222;128", "39") : sgr("32", "39"),
    dim: sgr("2", "22"),
    bold: sgr("1", "22"),
    red: sgr("31", "39"),
    yellow: sgr("33", "39"),
    green: sgr("32", "39"),
  };
}

export const theme: Theme = makeTheme(detectTheme());

export const SYMBOLS = { pass: "✓", warn: "!", problem: "✗", info: "·" } as const;
```

```ts
// packages/cli/src/ui/cli-name.ts
import { basename } from "node:path";

/**
 * The name to put in hints: `ks` when the user typed `ks`, otherwise
 * `kerstel`. A compiled Bun binary sets `process.argv0` to the name it was
 * invoked as, symlink included (`argv[1]` is always `/$bunfs/root/kerstel`).
 */
export function cliName(argv0: string = process.argv0): "ks" | "kerstel" {
  return basename(argv0) === "ks" ? "ks" : "kerstel";
}
```

Replace the colour code at the top of `packages/cli/src/output.ts` so the module reads:

```ts
import { SYMBOLS, theme } from "./ui/theme";

export const dim = theme.dim;
export const bold = theme.bold;
export const green = theme.green;
export const red = theme.red;
export const yellow = theme.yellow;

export function ok(message: string): void {
  console.log(`${green(SYMBOLS.pass)}  ${message}`);
}

export function fail(message: string): void {
  console.log(`${red(SYMBOLS.problem)}  ${message}`);
}

export function info(message: string): void {
  console.log(`${dim(SYMBOLS.info)}  ${message}`);
}

/** Masks a secret for display. Never reveals length beyond a fixed width. */
export function mask(): string {
  return "••••••••••••";
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/cli/test/ui-theme.test.ts && bun run typecheck && bun run test`
Expected: all pass. No existing test asserts on `✔`/`✖`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/ui packages/cli/src/output.ts packages/cli/package.json bun.lock packages/cli/test/ui-theme.test.ts
git commit -m "feat(cli): add the terminal theme, cliName, and @clack/prompts"
```

---

### Task 2: Braille banner

**Files:**
- Create: `packages/cli/src/ui/banner.ts`
- Test: `packages/cli/test/ui-banner.test.ts`

**Interfaces:**
- Consumes: `makeTheme`, `Theme` (Task 1), `VERSION` from `src/version.ts`.
- Produces: `BIRD: string[]` (9 lines), `renderBanner(options: { isTTY: boolean; columns: number; theme: Theme; version: string }): string | null`. `null` when not a TTY; the one-line form `◆ kerstel <version>` when `columns < 44`; otherwise the bird with the name, version, and tagline to its right.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/ui-banner.test.ts
import { expect, test } from "bun:test";
import { BIRD, renderBanner } from "../src/ui/banner";
import { makeTheme } from "../src/ui/theme";

const plain = makeTheme({ isTTY: false, noColor: true, truecolor: false });

test("no banner when stdout is not a terminal", () => {
  expect(renderBanner({ isTTY: false, columns: 120, theme: plain, version: "0.1.0" })).toBeNull();
});

test("a narrow terminal gets the one-line mark", () => {
  expect(renderBanner({ isTTY: true, columns: 43, theme: plain, version: "0.1.0" })).toBe("◆ kerstel 0.1.0");
});

test("a wide terminal gets the bird with the name, version, and tagline beside it", () => {
  const banner = renderBanner({ isTTY: true, columns: 80, theme: plain, version: "0.1.0" })!;
  const lines = banner.split("\n");
  expect(lines).toHaveLength(BIRD.length);
  expect(lines[3]).toContain("kerstel 0.1.0");
  expect(lines[4]).toContain("Local-first secrets");
  expect(lines[5]).toContain("for Node and Bun");
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(44);
});

test("the bird is only braille and spaces", () => {
  for (const line of BIRD) expect(line).toMatch(/^[⠀-⣿ ]*$/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/cli/test/ui-banner.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/ui/banner.ts
import type { Theme } from "./theme";

/**
 * The bird from apps/website/src/static/icon-dark.png, rendered once into
 * braille (2x4 dots per cell) and stored as text. Regenerate by hand if the
 * icon changes; it is never converted at runtime. Spec §4.2.
 */
export const BIRD: string[] = [
  "         ⣴⣾⣟⣳⣄",
  "       ⢀⣾⠿⢿⣿⡏⠉",
  "     ⢠⣴⣶⣶⡗⢸⣿⡇",
  "    ⢠⣿⣿⣿⣿⡇⣿⣿⠇",
  "   ⣠⡾⣿⣿⣿⢟⣴⡿⠋",
  "  ⢀⣵⣾⢟⡋⣴⣿⠋⠁",
  " ⡴⢟⣩⢠⡟⠸⣿⣿⣧⡀",
  " ⢠⡾⢣⡿⠁ ⠘⢿⣿⣿⣆",
  "⣰⠿⠁⠋     ⠉⠉⠉⠁",
];

const MIN_COLUMNS = 44;
const TEXT_COLUMN = 18;

export function renderBanner(options: {
  isTTY: boolean;
  columns: number;
  theme: Theme;
  version: string;
}): string | null {
  const { isTTY, columns, theme, version } = options;
  if (!isTTY) return null;
  if (columns < MIN_COLUMNS) return `${theme.accent("◆")} kerstel ${version}`;

  const beside: Record<number, string> = {
    3: `${theme.bold("kerstel")} ${version}`,
    4: theme.dim("Local-first secrets"),
    5: theme.dim("for Node and Bun"),
  };
  return BIRD.map((line, index) => {
    const text = beside[index];
    const bird = theme.accent(line);
    if (!text) return bird;
    return bird + " ".repeat(Math.max(1, TEXT_COLUMN - Bun.stringWidth(line))) + text;
  }).join("\n");
}

/** Prints the banner for the current stdout, followed by a blank line. */
export function printBanner(theme: Theme, version: string): void {
  const banner = renderBanner({
    isTTY: process.stdout.isTTY === true,
    columns: process.stdout.columns ?? 80,
    theme,
    version,
  });
  if (banner !== null) console.log(`${banner}\n`);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/cli/test/ui-banner.test.ts`
Expected: PASS. If the width assertion fails, lower `TEXT_COLUMN` until every line fits in 44 columns.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/banner.ts packages/cli/test/ui-banner.test.ts
git commit -m "feat(cli): draw the Kerstel bird as a braille banner"
```

---

### Task 3: Table and step helpers

**Files:**
- Create: `packages/cli/src/ui/table.ts`, `packages/cli/src/ui/steps.ts`
- Test: `packages/cli/test/ui-table.test.ts`

**Interfaces:**
- Consumes: `theme`, `SYMBOLS` (Task 1).
- Produces:
  - `renderTable(rows: string[][], options?: { indent?: number; gap?: number }): string[]`: pads every column to its widest cell by `Bun.stringWidth` (ANSI-aware), trims trailing spaces.
  - `interactive(): boolean`: `process.stdout.isTTY === true`.
  - `step(title: string, lines?: string[]): void`: TTY: `clack.log.step(title + lines)`. Otherwise prints `title` then each line indented by two spaces.
  - `note(body: string, title?: string): void`: TTY: `clack.note(body, title)`. Otherwise prints the title (if any) and the body lines.
  - `withSpinner<T>(label: string, done: string, work: () => Promise<T>): Promise<T>`: TTY: clack spinner showing `label`, stopped with `done`. Otherwise runs `work()` and prints `ok(done)`. Rethrows after stopping the spinner with the error message.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/ui-table.test.ts
import { expect, test } from "bun:test";
import { renderTable } from "../src/ui/table";

test("columns align by display width, not string length", () => {
  const lines = renderTable([
    ["DATABASE_URL", "•••• 64 chars", ".env.local"],
    ["PORT", "3000", ".env"],
    ["名前", "x", ".env"],
  ]);
  expect(lines[0]).toBe("DATABASE_URL  •••• 64 chars  .env.local");
  expect(lines[1]).toBe("PORT          3000           .env");
  expect(lines[2]).toBe("名前          x              .env");
});

test("ANSI colour codes do not count toward width", () => {
  const lines = renderTable([["\x1b[32mA\x1b[39m", "b"], ["AAA", "c"]]);
  expect(Bun.stringWidth(lines[0]!)).toBe(Bun.stringWidth(lines[1]!));
});

test("indent and gap", () => {
  expect(renderTable([["a", "b"]], { indent: 4, gap: 1 })).toEqual(["    a b"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/cli/test/ui-table.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/ui/table.ts
/** Aligned columns. Width is measured on screen, so ANSI codes and CJK text line up. */
export function renderTable(rows: string[][], options: { indent?: number; gap?: number } = {}): string[] {
  const indent = " ".repeat(options.indent ?? 0);
  const gap = " ".repeat(options.gap ?? 2);
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, Bun.stringWidth(cell));
    });
  }
  return rows.map((row) => {
    const cells = row.map((cell, column) =>
      column === row.length - 1 ? cell : cell + " ".repeat((widths[column] ?? 0) - Bun.stringWidth(cell)),
    );
    return (indent + cells.join(gap)).trimEnd();
  });
}
```

```ts
// packages/cli/src/ui/steps.ts
import * as clack from "@clack/prompts";
import { ok } from "../output";

/**
 * The rail (`◆ │ └`) in a terminal, plain lines everywhere else, so logs,
 * CI, and tests read stable text. Spec §4.3 and §4.6.
 */
export function interactive(): boolean {
  return process.stdout.isTTY === true;
}

export function step(title: string, lines: string[] = []): void {
  if (interactive()) {
    clack.log.step([title, ...lines].join("\n"));
    return;
  }
  console.log(title);
  for (const line of lines) console.log(`  ${line}`);
}

export function note(body: string, title?: string): void {
  if (interactive()) {
    clack.note(body, title);
    return;
  }
  if (title) console.log(title);
  for (const line of body.split("\n")) console.log(line);
}

export async function withSpinner<T>(label: string, done: string, work: () => Promise<T>): Promise<T> {
  if (!interactive()) {
    const result = await work();
    ok(done);
    return result;
  }
  const spin = clack.spinner();
  spin.start(label);
  try {
    const result = await work();
    spin.stop(done);
    return result;
  } catch (error) {
    spin.stop((error as Error).message, 1);
    throw error;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/cli/test/ui-table.test.ts && bun run typecheck`
Expected: PASS. If `spin.stop(message, code)` does not typecheck against the installed clack version, use its documented error form (`spin.error(message)` in 1.x) instead.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/table.ts packages/cli/src/ui/steps.ts packages/cli/test/ui-table.test.ts
git commit -m "feat(cli): add table and step helpers for the terminal look"
```

---

### Task 4: `Prompter.select`/`multiselect`, `ClackPrompter`, and cancelling

**Files:**
- Modify: `packages/cli/src/init/prompts.ts`, `packages/cli/src/commands/init.ts` (prompter choice and cancel handling only), `packages/cli/src/commands/uninstall.ts` (prompter choice and cancel handling only)
- Test: `packages/cli/test/init-prompts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Choice<T extends string> { value: T; label: string; hint?: string }
  export interface Prompter {
    confirm(question: string, defaultValue: boolean): Promise<boolean>;
    choose(question: string, options: string[], defaultValue: string): Promise<string>; // removed in Task 6
    select<T extends string>(question: string, choices: Choice<T>[], defaultValue: T): Promise<T>;
    multiselect<T extends string>(question: string, choices: Choice<T>[], initial: T[]): Promise<T[]>;
    text(question: string, options?: TextOptions): Promise<string>;
  }
  export class CancelledError extends Error {}           // message: "Cancelled. Nothing was changed."
  export class ClackPrompter implements Prompter {}
  export class ScriptedPrompter implements Prompter {}   // answers: (string | boolean | string[])[]
  export class DefaultsPrompter implements Prompter {}
  ```
  `TtyPrompter` is deleted.
- `runInit` and `uninstallCommand` catch `CancelledError`, print `fail("Cancelled. Nothing was changed.")`, and return 130.

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/test/init-prompts.test.ts`:

```ts
import { CancelledError, DefaultsPrompter, ScriptedPrompter } from "../src/init/prompts";

const DESTINATIONS = [
  { value: "project", label: "Vault, for this project only" },
  { value: "global", label: "Vault, shared by all your projects" },
  { value: "plaintext", label: "Keep as plain text" },
] as const;

test("ScriptedPrompter answers select and multiselect from its queue", async () => {
  const prompter = new ScriptedPrompter(["global", ["A", "C"]]);
  expect(await prompter.select("Where?", [...DESTINATIONS], "project")).toBe("global");
  expect(
    await prompter.multiselect("Which?", [{ value: "A", label: "A" }, { value: "B", label: "B" }, { value: "C", label: "C" }], []),
  ).toEqual(["A", "C"]);
});

test("ScriptedPrompter rejects an answer that is not one of the choices", async () => {
  await expect(new ScriptedPrompter(["nope"]).select("Where?", [...DESTINATIONS], "project")).rejects.toThrow(/not one of/);
  await expect(
    new ScriptedPrompter([["A", "Z"]]).multiselect("Which?", [{ value: "A", label: "A" }], []),
  ).rejects.toThrow(/not one of/);
});

test("DefaultsPrompter returns the default choice and the initial selection", async () => {
  const prompter = new DefaultsPrompter();
  expect(await prompter.select("Where?", [...DESTINATIONS], "plaintext")).toBe("plaintext");
  expect(await prompter.multiselect("Which?", [{ value: "A", label: "A" }], ["A"])).toEqual(["A"]);
});

test("CancelledError says nothing was changed", () => {
  expect(new CancelledError().message).toBe("Cancelled. Nothing was changed.");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/cli/test/init-prompts.test.ts`
Expected: FAIL, `select` is not a function / `CancelledError` not exported.

- [ ] **Step 3: Implement**

In `packages/cli/src/init/prompts.ts`:
1. Delete `TtyPrompter` and the `node:readline/promises` import.
2. Add `Choice`, extend `Prompter`, add `CancelledError`.
3. Extend `ScriptedPrompter` (answers type becomes `(string | boolean | string[])[]`) and `DefaultsPrompter`.
4. Add `ClackPrompter`.

```ts
import * as clack from "@clack/prompts";
import { dim } from "../output";

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export class CancelledError extends Error {
  constructor() {
    super("Cancelled. Nothing was changed.");
    this.name = "CancelledError";
  }
}

const MOVE_HINT = dim("↑/↓ to move · Enter to confirm");
const TOGGLE_HINT = dim("Space to toggle · Enter to confirm");

function settled<T>(value: T | symbol): T {
  if (clack.isCancel(value)) throw new CancelledError();
  return value as T;
}

/** The interactive default: arrow-key menus, checklists, masked input. Spec §4.4. */
export class ClackPrompter implements Prompter {
  async confirm(question: string, defaultValue: boolean): Promise<boolean> {
    return settled(await clack.confirm({ message: question, initialValue: defaultValue }));
  }

  async choose(question: string, options: string[], defaultValue: string): Promise<string> {
    return this.select(question, options.map((value) => ({ value, label: value })), defaultValue);
  }

  async select<T extends string>(question: string, choices: Choice<T>[], defaultValue: T): Promise<T> {
    return settled(
      await clack.select({
        message: `${question}\n${MOVE_HINT}`,
        options: choices.map((choice) => ({ value: choice.value, label: choice.label, hint: choice.hint })),
        initialValue: defaultValue,
      }),
    ) as T;
  }

  async multiselect<T extends string>(question: string, choices: Choice<T>[], initial: T[]): Promise<T[]> {
    return settled(
      await clack.multiselect({
        message: `${question}\n${TOGGLE_HINT}`,
        options: choices.map((choice) => ({ value: choice.value, label: choice.label, hint: choice.hint })),
        initialValues: initial,
        required: false,
      }),
    ) as T[];
  }

  async text(question: string, options: TextOptions = {}): Promise<string> {
    // A secret goes through clack's password prompt: every typed character is
    // drawn as a mask, never echoed. Same guarantee as the old readline mute.
    const answer = options.secret
      ? await clack.password({ message: question, mask: "•" })
      : await clack.text({ message: question });
    return settled(answer).trim();
  }
}
```

`ScriptedPrompter` additions:

```ts
  async select<T extends string>(question: string, choices: Choice<T>[], _defaultValue: T): Promise<T> {
    const answer = this.next(question);
    const values = choices.map((choice) => choice.value as string);
    if (typeof answer !== "string" || !values.includes(answer)) {
      throw new Error(`ScriptedPrompter answer ${JSON.stringify(answer)} for "${question}" is not one of ${values.join(", ")}`);
    }
    return answer as T;
  }

  async multiselect<T extends string>(question: string, choices: Choice<T>[], _initial: T[]): Promise<T[]> {
    const answer = this.next(question);
    const values = choices.map((choice) => choice.value as string);
    if (!Array.isArray(answer) || answer.some((item) => !values.includes(item))) {
      throw new Error(`ScriptedPrompter answer ${JSON.stringify(answer)} for "${question}" is not one of ${values.join(", ")}`);
    }
    return answer as T[];
  }
```

Change `ScriptedPrompter`'s constructor to `constructor(private readonly answers: (string | boolean | string[])[])` and `next()`'s return type to `string | boolean | string[]`. In `confirm`, `choose`, and `text`, the existing type checks already reject arrays.

`DefaultsPrompter` additions:

```ts
  async select<T extends string>(_question: string, _choices: Choice<T>[], defaultValue: T): Promise<T> {
    return defaultValue;
  }

  async multiselect<T extends string>(_question: string, _choices: Choice<T>[], initial: T[]): Promise<T[]> {
    return initial;
  }
```

In `packages/cli/src/commands/init.ts`: import `ClackPrompter` and `CancelledError` instead of `TtyPrompter`; `choosePrompter` returns `new ClackPrompter()`; delete the `finally` block's `prompter.close()` (clack holds nothing open); in `runInit`'s catch, add before the `NonInteractiveError` branch:

```ts
    if (error instanceof CancelledError) {
      fail(error.message);
      return 130;
    }
```

In `packages/cli/src/commands/uninstall.ts`: same swap to `ClackPrompter`; remove the `prompter.close()` in its `finally`; wrap the confirm so a `CancelledError` prints its message and returns 130.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/cli/test/init-prompts.test.ts && bun run typecheck && bun run test`
Expected: all pass. Existing tests use `ScriptedPrompter` and are unaffected.

- [ ] **Step 5: Try it by hand**

Run in a scratch project, with `KERSTEL_HOME=/tmp/ks-try KERSTEL_KEYCHAIN_BACKEND=file bun run packages/cli/src/index.ts init`: each key now shows an arrow-key menu. Press Ctrl-C at the first one: it prints `Cancelled. Nothing was changed.`, exits 130 (`echo $?`), and the terminal cursor is visible. Remove `/tmp/ks-try` afterwards.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/prompts.ts packages/cli/src/commands/init.ts packages/cli/src/commands/uninstall.ts packages/cli/test/init-prompts.test.ts
git commit -m "feat(cli): arrow-key prompts through @clack/prompts, and a clean cancel"
```

---

### Task 5: `explain()`: a reason for every suggestion

**Files:**
- Modify: `packages/cli/src/init/classify.ts`
- Test: `packages/cli/test/init-classify.test.ts` (add to the existing file)

**Interfaces:**
- Produces: `explain(key: string, value: string): { suggestion: Suggestion; reason: string }`. `suggest(key, value)` becomes `explain(key, value).suggestion`. Also `DESTINATION_CHOICES(scope: string): Choice<Suggestion>[]` with the labels and hints from spec §5.2.

- [ ] **Step 1: Write the failing tests**

```ts
import { DESTINATION_CHOICES, explain, suggest } from "../src/init/classify";

test.each([
  ["EMPTY", "", "plaintext", "It's empty, so there's nothing to protect"],
  ["DEBUG", "true", "plaintext", "An on/off switch or a number, not a credential"],
  ["DATABASE_URL", "postgres://u:pw@db/app", "project", "The URL has a username and password in it"],
  ["WEBHOOK", "https://x.test/hook?token=abc", "project", "The URL carries a key or token"],
  ["NEXT_PUBLIC_API", "https://api.test", "plaintext", "A setting, not a credential"],
  ["OPENAI_API_KEY", "sk-abcdefgh12345678", "global", "You probably use this account in every project"],
  ["DB_PASSWORD", "hunter2hunter2", "project", "The name says it's a secret"],
  ["API_BASE", "https://api.test/v1", "plaintext", "A plain URL with no credentials in it"],
  ["MODE", "dev", "plaintext", "A short word, like a mode or a name"],
  ["SESSION_BLOB", "a9f8e7d6c5b4a3f2", "project", "Might be a secret, so it's safer in the vault"],
])("explain(%s) suggests %s with its reason", (key, value, suggestion, reason) => {
  expect(explain(key, value)).toEqual({ suggestion, reason });
  expect(suggest(key, value)).toBe(suggestion);
});

test("the destination choices carry the spec's labels and hints", () => {
  expect(DESTINATION_CHOICES("whasal")).toEqual([
    { value: "project", label: "Vault, for this project only", hint: "Only whasal can read it" },
    { value: "global", label: "Vault, shared by all your projects", hint: "For accounts you use everywhere, like an OpenAI key" },
    { value: "plaintext", label: "Keep as plain text", hint: "Stays in the file. For settings, not secrets" },
  ]);
});
```

Before running, check each row against the existing `suggest()` branches: if an input takes a different branch than the row names, change the INPUT (not the expected reason) so the row exercises the branch it names.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/cli/test/init-classify.test.ts`
Expected: FAIL, `explain` is not exported.

- [ ] **Step 3: Implement**

Rewrite `suggest()` as `explain()` with the same branch order, returning a reason at each `return`, then define `suggest` on top of it:

```ts
import type { Choice } from "./prompts";

export interface Explanation {
  suggestion: Suggestion;
  reason: string;
}

const SHARED = "You probably use this account in every project";

function stored(key: string, reason: string): Explanation {
  return GLOBAL_KEYS.includes(key) ? { suggestion: "global", reason: SHARED } : { suggestion: "project", reason };
}

export function explain(key: string, value: string): Explanation {
  const trimmed = value.trim();

  if (trimmed === "") return { suggestion: "plaintext", reason: "It's empty, so there's nothing to protect" };
  if (BOOLEANS.has(trimmed.toLowerCase()) || NUMBER.test(trimmed)) {
    return { suggestion: "plaintext", reason: "An on/off switch or a number, not a credential" };
  }

  const authority = urlAuthority(trimmed);
  if (authority !== null) {
    if (authority.includes("@")) return { suggestion: "project", reason: "The URL has a username and password in it" };
    if (SECRET_QUERY.test(trimmed)) return { suggestion: "project", reason: "The URL carries a key or token" };
    if (PLAINTEXT_KEYS.test(key)) return { suggestion: "plaintext", reason: "A setting, not a credential" };
    return SECRET_KEYS.test(key)
      ? stored(key, "The name says it's a secret")
      : { suggestion: "plaintext", reason: "A plain URL with no credentials in it" };
  }

  if (PLAINTEXT_KEYS.test(key)) return { suggestion: "plaintext", reason: "A setting, not a credential" };
  if (SECRET_KEYS.test(key)) return stored(key, "The name says it's a secret");
  if (trimmed.length < 8 && SINGLE_LOWERCASE_WORD.test(trimmed)) {
    return { suggestion: "plaintext", reason: "A short word, like a mode or a name" };
  }
  return stored(key, "Might be a secret, so it's safer in the vault");
}

/** What the wizard SUGGESTS. See `explain` for why; the two cannot disagree. */
export function suggest(key: string, value: string): Suggestion {
  return explain(key, value).suggestion;
}

/** The three destinations, in the words every menu uses. Spec §5.2. */
export function DESTINATION_CHOICES(scope: string): Choice<Suggestion>[] {
  return [
    { value: "project", label: "Vault, for this project only", hint: `Only ${scope} can read it` },
    { value: "global", label: "Vault, shared by all your projects", hint: "For accounts you use everywhere, like an OpenAI key" },
    { value: "plaintext", label: "Keep as plain text", hint: "Stays in the file. For settings, not secrets" },
  ];
}
```

Keep the existing doc comment on the branch order (move it above `explain`). Delete the old `store()` helper.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/cli/test/init-classify.test.ts && bun run test`
Expected: all pass, including every existing `suggest()` test unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/classify.ts packages/cli/test/init-classify.test.ts
git commit -m "feat(cli): explain why init suggests each destination"
```

---

### Task 6: The new `init` flow

**Files:**
- Create: `packages/cli/src/init/overview.ts`
- Modify: `packages/cli/src/init/detect.ts`, `packages/cli/src/commands/init.ts`, `packages/cli/src/init/prompts.ts` (remove `choose`)
- Test: `packages/cli/test/init-overview.test.ts` (new), `packages/cli/test/init.test.ts`, `packages/cli/test/init-detect.test.ts` (or wherever `detectProject` is tested; find it with `grep -ln detectProject packages/cli/test`), `packages/cli/test/init-prompts.test.ts`

**Interfaces:**
- Consumes: `explain`, `DESTINATION_CHOICES`, `Suggestion` (Task 5); `Prompter.select`/`multiselect` (Task 4); `renderTable` (Task 3); `step`, `note`, `withSpinner`, `interactive` (Task 3); `printBanner` (Task 2); `theme` (Task 1); `cliName` (Task 1); `describeValue`, `maskForDisplay` (`init/display.ts`).
- Produces:
  - `DetectedProject.framework: string | null` (`"Next.js" | "Nuxt" | "SvelteKit" | "Astro" | "Remix" | "Vite"`).
  - `overview.ts`:
    ```ts
    export interface OverviewRow { key: string; value: string; source: string; conflicts: string[]; target: Suggestion }
    export function renderOverview(rows: OverviewRow[], scope: string, fileNames: string[]): string[];
    export function renderChangeSummary(changes: { label: string; kind: "env" | "package" | "gitignore"; count: number }[]): string[];
    ```
  - `Prompter.choose` removed.

**Flow to implement in `runInitSteps` (spec §5.1).** Keep every existing check, flag, warning, and early return; only the presentation and the question sequence change:

1. `printBanner(theme, VERSION)`, then `step(setupLine)` where `setupLine = "Setting up <scope> · <framework ?? runtime> on <packageManager> · <env file names>"`. The existing unreadable-file, unsupported-line, and flag warnings follow as before.
2. Teammate flow (`fillMissingReferences`): ask each missing value with `prompter.text(\`${key.key} · ${i + 1} of ${missing.length}\`, { secret: true, flag: "--from-stdin" })`, after a `step()` that names the files referencing them.
3. Decisions (`decideTargets`, rewritten):
   - Start from `explain()` for each plain key, overridden by `--keep`/`--global` as today.
   - Print `renderOverview(...)` under `step("Found N variables. Here's where I'd put them:")`.
   - Loop: `const answer = await prompter.select("Look right?", [{value:"accept",label:"Yes, use these"},{value:"change",label:"Let me change some"},{value:"each",label:"Go through them one by one"}], "accept")`.
     - `accept`: done.
     - `change`: `prompter.multiselect("Which ones do you want to change?", rows.map(r => ({ value: r.key, label: r.key, hint: destinationLabel(r.target) })), [])`, then for each picked key `prompter.select(\`${key} · where should it go?\`, DESTINATION_CHOICES(scope), current)`; reprint the overview; loop.
     - `each`: for each key, `prompter.select(\`${key} · ${i + 1} of ${n}\n${valueColumn} · from ${source}\n${reason}\`, DESTINATION_CHOICES(scope) with the suggested choice's hint suffixed " (suggested)", current)`; reprint the overview; loop.
   - Keys fixed by `--keep`/`--global` appear in the overview but are not offered for change.
   - With `DefaultsPrompter` (`--yes`), `select` returns `"accept"` immediately, so behaviour matches today's defaults.
4. Plan the `.gitignore` change BEFORE applying anything: compute the plaintext keys remaining from the PLANNED env-file contents (parse each `change.after`, plus unchanged files' originals) instead of reading the disk, then ask `prompter.select("Remove the .env lines from .gitignore so these files can be committed?", [{value:"keep",label:"No, leave .gitignore as it is",hint:"Safest if any value is still plain text"},{value:"remove",label:"Yes, remove them",hint:"The files hold references, so teammates get a working .env.example"}], "keep")`. Its write happens in step 6.
5. `step("Here's what will change:", renderChangeSummary(...))`, then `--dry-run` prints every masked diff and returns 0 (as today). Otherwise loop on `prompter.select("Apply these changes?", [{value:"apply",label:"Apply"},{value:"diff",label:"Show the full diff first"},{value:"cancel",label:"Cancel"}], "apply")`: `diff` prints the masked diffs and asks again without the `diff` option; `cancel` prints `info("Nothing was changed.")` and returns 0.
6. Apply with `withSpinner` per step, in today's order: backup, register project + store values, rewrite env files, wire `package.json`, write `.gitignore`, self-check. Each spinner's `done` text is today's `ok(...)` message.
7. `note(body, "Next steps")` where the body is: `<scope> is ready. Run <packageManager> run dev as usual.` (use the first wired script name if there is no `dev` script), `${cliName()} doctor checks the setup any time.`, and `Your .env files hold only references now, so they're safe to commit.` (omit that line if any plaintext key remains). The failed-self-check path keeps `summaryLines(...)` content and returns 1.

Replace every hardcoded `` `kerstel doctor` ``, `` `kerstel init` ``, `` `kerstel daemon start` ``, and `` `kerstel set` `` in `init.ts` with `` `${cliName()} doctor` `` etc. `kerstel exec` in the "Wired … through `kerstel exec`" message stays, because that is what the script literally says.

- [ ] **Step 1: Write the failing overview tests**

```ts
// packages/cli/test/init-overview.test.ts
import { expect, test } from "bun:test";
import { renderChangeSummary, renderOverview, type OverviewRow } from "../src/init/overview";

const rows: OverviewRow[] = [
  { key: "DATABASE_URL", value: "postgres://u:hunter2@db/app", source: ".env.local", conflicts: [], target: "project" },
  { key: "OPENAI_API_KEY", value: "sk-live-abcdef0123456789", source: ".env", conflicts: [], target: "global" },
  { key: "PORT", value: "3000", source: ".env", conflicts: [], target: "plaintext" },
  { key: "API_TOKEN", value: "tok-local-bbbb", source: ".env.local", conflicts: [".env"], target: "project" },
];

test("groups by destination, in the spec's order, with counts", () => {
  const text = renderOverview(rows, "whasal", [".env", ".env.local"]).join("\n");
  const project = text.indexOf("Vault, for whasal only (2)");
  const shared = text.indexOf("Vault, shared by all your projects (1)");
  const plain = text.indexOf("Stays in .env, .env.local as plain text (1)");
  expect(project).toBeGreaterThanOrEqual(0);
  expect(shared).toBeGreaterThan(project);
  expect(plain).toBeGreaterThan(shared);
});

test("never prints a value headed for the vault, only its length", () => {
  const text = renderOverview(rows, "whasal", [".env"]).join("\n");
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("sk-live");
  expect(text).not.toContain("tok-local");
  expect(text).toContain("•••• 27 chars");
});

test("prints a plain-text value in full", () => {
  expect(renderOverview(rows, "whasal", [".env"]).join("\n")).toContain("3000");
});

test("names a conflicting key's files and which one wins, without values", () => {
  const text = renderOverview(rows, "whasal", [".env"]).join("\n");
  expect(text).toContain("API_TOKEN has different values in .env.local and .env");
  expect(text).toContain("the .env.local one wins");
});

test("an empty group is left out", () => {
  const text = renderOverview(rows.filter((r) => r.target !== "global"), "whasal", [".env"]).join("\n");
  expect(text).not.toContain("shared by all your projects");
});

test("the change summary is one line per file", () => {
  expect(
    renderChangeSummary([
      { label: ".env.local", kind: "env", count: 7 },
      { label: "package.json", kind: "package", count: 1 },
      { label: ".gitignore", kind: "gitignore", count: 2 },
    ]),
  ).toEqual([
    ".env.local: 7 values become references",
    "package.json: 1 script goes through Kerstel",
    ".gitignore: 2 lines hiding .env files are removed",
  ]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/cli/test/init-overview.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `overview.ts`**

```ts
// packages/cli/src/init/overview.ts
import { dim, yellow } from "../output";
import { renderTable } from "../ui/table";
import type { Suggestion } from "./classify";

export interface OverviewRow {
  key: string;
  value: string;
  source: string;
  conflicts: string[];
  target: Suggestion;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Spec §5.1 step 2. A vault-bound value is shown as its length and nothing else. */
export function renderOverview(rows: OverviewRow[], scope: string, fileNames: string[]): string[] {
  const groups: [Suggestion, string][] = [
    ["project", `Vault, for ${scope} only`],
    ["global", "Vault, shared by all your projects"],
    ["plaintext", `Stays in ${fileNames.join(", ")} as plain text`],
  ];
  const lines: string[] = [];
  for (const [target, title] of groups) {
    const members = rows.filter((row) => row.target === target);
    if (members.length === 0) continue;
    lines.push(`${title} (${members.length})`);
    lines.push(
      ...renderTable(
        members.map((row) => [
          row.key,
          target === "plaintext" ? row.value : `•••• ${row.value.length} chars`,
          dim(row.source),
        ]),
        { indent: 2 },
      ),
    );
  }
  for (const row of rows.filter((r) => r.conflicts.length > 0)) {
    lines.push("");
    lines.push(
      yellow(`! ${row.key} has different values in ${[row.source, ...row.conflicts].join(" and ")};`),
      yellow(`  the ${row.source} one wins, and the others are kept in the encrypted backup.`),
    );
  }
  return lines;
}

/** Spec §5.1 step 4. */
export function renderChangeSummary(
  changes: { label: string; kind: "env" | "package" | "gitignore"; count: number }[],
): string[] {
  return changes.map(({ label, kind, count }) => {
    if (kind === "env") return `${label}: ${plural(count, "value becomes a reference", "values become references")}`;
    if (kind === "package") return `${label}: ${plural(count, "script goes through Kerstel", "scripts go through Kerstel")}`;
    return `${label}: ${plural(count, "line hiding .env files is removed", "lines hiding .env files are removed")}`;
  });
}
```

The length uses `value.length` (UTF-16 units), matching `describeValue`'s existing count; if `describeValue` counts differently, use `describeValue(row.value)` for the vault column instead and adjust the test's expected text to its output.

- [ ] **Step 4: Run the overview tests**

Run: `bun test packages/cli/test/init-overview.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `framework` detection, test first**

Add to the `detectProject` tests:

```ts
test.each([
  [{ dependencies: { next: "15" } }, "Next.js"],
  [{ devDependencies: { vite: "5", "@sveltejs/kit": "2" } }, "SvelteKit"],
  [{ dependencies: { "@remix-run/node": "2" } }, "Remix"],
  [{ dependencies: { express: "4" } }, null],
])("detects the framework from package.json %#", (deps, framework) => {
  const root = makeProject({ "package.json": JSON.stringify({ name: "x", ...deps }) });
  expect(detectProject(root).framework).toBe(framework);
});
```

(Use the test file's existing project helper; if it has none, create a temp dir with `mkdtempSync(join(tmpdir(), "kerstel-detect-"))`, write the file, and remove it in `afterEach`.)

Implement in `detect.ts`: add `framework: string | null` to `DetectedProject`, and

```ts
/** First match wins: Vite sits under most of the others, so it goes last. Spec §5.1. */
const FRAMEWORKS: ReadonlyArray<readonly [test: (name: string) => boolean, label: string]> = [
  [(n) => n === "next", "Next.js"],
  [(n) => n === "nuxt", "Nuxt"],
  [(n) => n === "@sveltejs/kit", "SvelteKit"],
  [(n) => n === "astro", "Astro"],
  [(n) => n.startsWith("@remix-run/"), "Remix"],
  [(n) => n === "vite", "Vite"],
];

export function detectFramework(packageJson: Record<string, unknown> | null): string | null {
  const names = ["dependencies", "devDependencies"].flatMap((field) => {
    const deps = packageJson?.[field];
    return deps && typeof deps === "object" ? Object.keys(deps) : [];
  });
  for (const [matches, label] of FRAMEWORKS) if (names.some(matches)) return label;
  return null;
}
```

and set `framework: detectFramework(packageJson)` in `detectProject`'s return.

Run: `bun test packages/cli/test` for the detect file. Expected: PASS.

- [ ] **Step 6: Rewrite the `init` flow**

Implement the seven-step flow above in `packages/cli/src/commands/init.ts`. Then remove `choose` from `Prompter`, `ClackPrompter`, `ScriptedPrompter`, and `DefaultsPrompter`, and delete the `choose` assertion in `init-prompts.test.ts`.

- [ ] **Step 7: Update the existing `init` tests' scripted answers**

The question sequence changed. Translate each `new ScriptedPrompter([...])` in `packages/cli/test/init.test.ts` and `packages/cli/test/init-prompts.test.ts` mechanically:

| Old answers | New answers |
| --- | --- |
| one destination per key, then `true` (apply) | `"each"`, one destination per key, `"accept"`, `"apply"` |
| destinations, then `false` (don't apply) | `"each"`, destinations, `"accept"`, `"cancel"` |
| a `.gitignore` `true`/`false` after apply | `"remove"`/`"keep"`, now asked BEFORE `"apply"`/`"cancel"` |
| a teammate value (string) | unchanged, still first |

Example, `init migrates an npm project end to end`: `["plaintext", "project", "global", true]` becomes `["each", "plaintext", "project", "global", "accept", "apply"]`. Keep every assertion on files, vault contents, and backups unchanged: they prove the behaviour did not change. Update assertions on printed wording only where the wording changed.

Add these tests to `init.test.ts`:

```ts
test("accepting the suggestions stores exactly what --yes would", async () => {
  isolateEnv({ prefix: "init-accept" });
  await bootLocalDaemon();
  const files = {
    "package.json": NPM_PACKAGE,
    ".env": "NODE_ENV=development\nDATABASE_URL=postgres://u:pw@localhost:5432/app\n",
  };
  const interactiveRoot = makeProject(files);
  expect(await runInit(options(interactiveRoot), new ScriptedPrompter(["accept", "apply"]))).toBe(0);
  const yesRoot = makeProject(files);
  expect(await runInit({ ...options(yesRoot), yes: true }, new DefaultsPrompter())).toBe(0);
  expect(readFileSync(join(interactiveRoot, ".env"), "utf8")).toBe(readFileSync(join(yesRoot, ".env"), "utf8"));
});

test("changing some asks only about the ticked keys", async () => {
  isolateEnv({ prefix: "init-change" });
  await bootLocalDaemon();
  const root = makeProject({
    "package.json": NPM_PACKAGE,
    ".env": "NODE_ENV=development\nDATABASE_URL=postgres://u:pw@localhost:5432/app\n",
  });
  const prompter = new ScriptedPrompter(["change", ["NODE_ENV"], "project", "accept", "apply"]);
  expect(await runInit(options(root), prompter)).toBe(0);
  expect(readFileSync(join(root, ".env"), "utf8")).toContain("NODE_ENV=kerstel://demo-app/NODE_ENV");
  expect(prompter.asked.filter((q) => q.startsWith("DATABASE_URL"))).toEqual([]);
});

test("showing the full diff first, then applying", async () => {
  isolateEnv({ prefix: "init-diff" });
  await bootLocalDaemon();
  const root = makeProject({ "package.json": NPM_PACKAGE, ".env": "DATABASE_URL=postgres://u:pw@localhost/app\n" });
  const prompter = new ScriptedPrompter(["accept", "diff", "apply"]);
  expect(await runInit(options(root), prompter)).toBe(0);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("DATABASE_URL=kerstel://demo-app/DATABASE_URL\n");
});

test("cancelling at any prompt writes nothing", async () => {
  isolateEnv({ prefix: "init-cancel" });
  const original = "DATABASE_URL=postgres://u:pw@localhost/app\n";
  for (const answers of [[], ["accept"], ["each"]]) {
    const root = makeProject({ "package.json": NPM_PACKAGE, ".env": original });
    const prompter = new CancellingPrompter(answers);
    expect(await runInit(options(root), prompter)).toBe(130);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(original);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(NPM_PACKAGE);
  }
});

test("the overview never prints a vault-bound value", async () => {
  isolateEnv({ prefix: "init-no-leak" });
  await bootLocalDaemon();
  const root = makeProject({ "package.json": NPM_PACKAGE, ".env": "DB_PASSWORD=correct-horse-battery\n" });
  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    expect(await runInit(options(root), new ScriptedPrompter(["accept", "diff", "apply"]))).toBe(0);
  } finally {
    console.log = realLog;
  }
  expect(captured.join("\n")).not.toContain("correct-horse-battery");
});
```

`CancellingPrompter` (define it in the test file): extends `ScriptedPrompter`, and when its answers run out, every method throws `new CancelledError()` instead of the out-of-answers error.

- [ ] **Step 8: Run everything**

Run: `bun run typecheck && bun run test`
Expected: all pass.

- [ ] **Step 9: Try it by hand in a terminal**

In a copy of a real project, with `KERSTEL_HOME=/tmp/ks-try KERSTEL_KEYCHAIN_BACKEND=file bun run <repo>/packages/cli/src/index.ts init`: the banner, the grouped overview, Enter to accept, the change summary, Enter to apply, spinners, and the closing note all appear, and no vault-bound value is on screen. Then pipe it: `... init --yes | cat` prints plain lines with no escape codes. Remove `/tmp/ks-try`.

- [ ] **Step 10: Commit**

```bash
git add packages/cli/src/init packages/cli/src/commands/init.ts packages/cli/test
git commit -m "feat(cli): show every variable first in init, then accept or adjust"
```

---

### Task 7: `doctor`: grouped checks, fixes, `--verbose`, and an exit code

**Files:**
- Create: `packages/cli/src/doctor/checks.ts`
- Modify: `packages/cli/src/commands/doctor.ts`, `packages/cli/src/index.ts` (pass args to `doctorCommand`), `.github/workflows/release.yml` (Keychain grep)
- Test: `packages/cli/test/doctor-checks.test.ts` (new), `packages/cli/test/cli.test.ts`, `packages/cli/test/e2e.test.ts`

**Interfaces:**
- Consumes: `openContext`, `isDaemonRunning`, `projectStatus`, `modeReport`'s logic, `cliName`, `printBanner`, `step`, `SYMBOLS`, `theme`.
- Produces:
  ```ts
  export type CheckStatus = "pass" | "warn" | "problem";
  export interface Check { group: "machine" | "project"; status: CheckStatus; label: string; detail: string; fix?: string }
  export interface DoctorFacts {
    backend: string; secretCount: number; daemonRunning: boolean;
    hook: { installed: boolean; error?: string };
    modes: { path: string; actual: number | null; expected: number }[];
    shortcut: "linked" | "missing" | "other" | "not-applicable";
    project: ProjectStatus | null;   // the existing projectStatus() return type
    cli: "ks" | "kerstel";
  }
  export function gatherChecks(facts: DoctorFacts): Check[];
  export function exitCode(checks: Check[]): 0 | 1;
  export function backendLabel(backend: string): string; // "macos" -> "macOS Keychain", "linux" -> "Secret Service", "windows" -> "Windows Credential Manager", "file" -> "a key file"
  doctorCommand(args: string[], cwd?: string): Promise<number>
  ```

Check rules (spec §6):
- **Vault**: pass, `"<n> secrets, unlocked with your <backendLabel>"`; with the file backend, warn, detail `"<n> secrets, key kept in a file"`, fix `"install secret-tool (libsecret) and re-run"` on Linux.
- **Daemon**: pass `"running"`; warn `"not running"`, fix `` `${cli} daemon start` ``.
- **Runtime hook**: pass `"installed"`; warn `"not installed: <error>"`, fix `` `${cli} run -- <command>` works without it ``.
- **Permissions**: pass `"~/.kerstel, token, and socket are private"`; problem when any path is looser than expected: `"<path> is <mode>, should be <expected>"`, fix `chmod <expected> <path>`.
- **Shortcut**: pass `"ks runs this Kerstel"`; warn when `missing`: `"ks isn't on your PATH"`, fix `"re-run the installer"`; warn when `other`: `"ks on your PATH is a different program"`, no fix; omitted when `not-applicable` (running from source).
- **Project** (only when `project` is non-null): **Scope** warn if it could not be derived (fix `` `${cli} init --scope <name>` ``); **Scripts** pass when all wrappable scripts are wired, else warn `"<w> of <n> go through Kerstel"` with fix `` `${cli} init` ``; **References** pass `"<r> of <t> resolve"`, problem when any are unresolved: `"<u> can't be found: <names>"`, fix `` `${cli} init` ``; **Env files** warn if any are unreadable, fix `"check the file permissions"`.
- `exitCode`: 1 if any check is `problem`, else 0.
- If `openContext()` throws (vault can't open, key mismatch), `doctorCommand` prints one `✗ Vault` line with the error message and returns 1.

Rendering: `printBanner`; `step("This machine")` with one line per machine check (`<symbol> <label padded> <detail>`, and a second dim line `Fix: <fix>` under warnings and problems); `step("This project · <scope>")` likewise; last line `"<p> problem(s), <w> warning(s). Everything else looks good."` or `"All good."`. `--verbose` adds, after the machine group, the old path lines (home, vault, token, socket, hook with modes). Unknown arguments: `fail("Unknown option …. kerstel doctor accepts: --verbose.")`, return 2.

The Shortcut fact is computed in `doctorCommand`: `not-applicable` unless `isCompiledBinary()`; otherwise `Bun.which("ks")`, then `realpathSync` of it compared with `realpathSync(process.execPath)`: equal is `linked`, a different file is `other`, none is `missing`.

- [ ] **Step 1: Write the failing tests** for `gatherChecks` and `exitCode`: one `DoctorFacts` fixture where everything passes (assert every check is `pass` and `exitCode` is 0), then one test per rule above that flips one fact and asserts the check's `status`, `detail`, and `fix` (for example `daemonRunning: false` gives `{ status: "warn", label: "Daemon", detail: "not running", fix: "ks daemon start" }` with `cli: "ks"`), and `exitCode` returning 1 exactly when a `problem` is present. Also `backendLabel` for all four backends.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/cli/test/doctor-checks.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `checks.ts`, then rewrite `doctor.ts` to gather facts, call `gatherChecks`, and render as described.** Move `modeReport`'s stat logic into the facts gathering (`actual: number | null`).

- [ ] **Step 4: Update the existing tests**

In `cli.test.ts` (`doctor reports the keychain backend and vault location`), assert on the new wording (`"secrets, unlocked with your"` or the file-backend detail) and run `doctor --verbose` for the vault location. In `e2e.test.ts`, the `join(home, "hook")` assertion moves to `doctor --verbose`. A test where the daemon is down now expects exit 0 (warning); a test with an unresolvable reference expects exit 1.

- [ ] **Step 5: Update the release smoke step**

In `.github/workflows/release.yml`, change `./kerstel doctor | grep -q 'Keychain:.*macos'` to `./kerstel doctor | grep -q 'macOS Keychain'`. `doctor` may now exit 1 in the smoke environment only if a check is a problem; the step's fresh home has none, and `set -o pipefail` would surface it if it did.

- [ ] **Step 6: Run everything**

Run: `bun run typecheck && bun run test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/doctor packages/cli/src/commands/doctor.ts packages/cli/src/index.ts packages/cli/test .github/workflows/release.yml
git commit -m "feat(cli): group doctor's checks with fixes, add --verbose, exit 1 on problems"
```

---

### Task 8: `uninstall`'s look, the `ks` link, and bare `ks`

**Files:**
- Modify: `packages/cli/src/commands/uninstall.ts`, `packages/cli/src/index.ts`
- Test: `packages/cli/test/uninstall.test.ts`, `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `printBanner`, `step`, `cliName`, `Prompter.select`, `CancelledError`.
- Produces: `removeShortcut(binaryPath: string): "removed" | "absent" | "not-ours"` exported from `uninstall.ts`; `runCli([])` returns 0 and prints the banner (TTY only) and the command list.

Changes:
- `printPlan` uses `printBanner`, then one `step("<project>")` per restored project listing its diffs, and one `step("Would be lost", lines)` block in yellow for the four loss lists (same content as today).
- The final question: `prompter.select("Restore these files and delete Kerstel from this machine?", [{value:"no",label:"No, keep Kerstel"},{value:"yes",label:"Yes, restore and delete"}], "no")`. Proceed only on `"yes"`.
- After deleting the binary (only when compiled, as today), call `removeShortcut(binary.path)`: if `<dirname>/ks` is a symlink whose resolved target equals `realpathSync(binary.path)` (checked BEFORE the binary is deleted; resolve the link with `resolve(dirname(link), readlinkSync(link))`), delete it and `ok("Removed <dir>/ks.")`. Anything else is left alone.
- Hints use `cliName()`, here and in the remaining files that name a command: `packages/cli/src/daemon/client.ts` and `packages/cli/src/init/backup.ts`. Find any others with `grep -rn '\`kerstel [a-z]' packages/cli/src` and convert those in user-facing strings (not comments). The hook package (`packages/hook`) keeps `kerstel`, since it runs inside the user's app and cannot know which name they type.
- `index.ts`: split `USAGE` into `COMMANDS` (the command list, with `kerstel` replaced by `${cliName()}`) and a header. Bare invocation: `printBanner(theme, VERSION)`, print `COMMANDS`, return 0 (today it returns 2). `--help`/`-h`/`help`: print the header and `COMMANDS` without the banner, return 0. Unknown command: unchanged (fail, `COMMANDS`, return 2).

- [ ] **Step 1: Write the failing tests**

In `uninstall.test.ts`, translate the confirm answers: `true` becomes `"yes"`, `false` becomes `"no"`. Add:

```ts
test("removeShortcut deletes a ks link to the binary and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-ks-"));
  dirs.push(dir);
  const binary = join(dir, "kerstel");
  writeFileSync(binary, "bin");
  symlinkSync("kerstel", join(dir, "ks"));
  expect(removeShortcut(binary)).toBe("removed");
  expect(existsSync(join(dir, "ks"))).toBe(false);

  expect(removeShortcut(binary)).toBe("absent");

  writeFileSync(join(dir, "ks"), "someone else's tool");
  expect(removeShortcut(binary)).toBe("not-ours");
  expect(readFileSync(join(dir, "ks"), "utf8")).toBe("someone else's tool");

  rmSync(join(dir, "ks"));
  writeFileSync(join(dir, "other"), "x");
  symlinkSync("other", join(dir, "ks"));
  expect(removeShortcut(binary)).toBe("not-ours");
});
```

In `cli.test.ts`:

```ts
test("bare kerstel lists the commands and exits 0; --help does the same", async () => {
  expect(await runCli([])).toBe(0);
  expect(await runCli(["--help"])).toBe(0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/cli/test/uninstall.test.ts packages/cli/test/cli.test.ts`
Expected: FAIL (`removeShortcut` not exported; bare run returns 2; `"yes"` not a boolean for `confirm`).

- [ ] **Step 3: Implement** the changes listed above.

- [ ] **Step 4: Run everything**

Run: `bun run typecheck && bun run test`
Expected: all pass. Check that any existing test asserting `runCli([])` returns 2 is updated to 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/uninstall.ts packages/cli/src/index.ts packages/cli/test
git commit -m "feat(cli): uninstall and bare ks get the new look; uninstall removes the ks link"
```

---

### Task 9: `install.sh` creates `ks`

**Files:**
- Modify: `apps/website/src/static/install.sh`, `.github/workflows/release.yml` (installer job)
- Test: `apps/website/test/install.test.ts`

**Interfaces:**
- Produces: after a successful install, `<dir>/ks` is a relative symlink to `kerstel`, unless another `ks` exists; output line `Linked ks -> kerstel`, or `ks is already taken by <path>, so use kerstel`.

- [ ] **Step 1: Write the failing tests** (use the file's existing `install()` helper, `installDir`, and `shim()`):

```ts
test("creates ks as a link to kerstel", async () => {
  const result = await install({});
  expect(result.code).toBe(0);
  expect(readlinkSync(join(installDir, "ks"))).toBe("kerstel");
  expect(result.stdout).toContain("Linked ks -> kerstel");
});

test("a re-run keeps the ks link", async () => {
  await install({});
  const again = await install({});
  expect(again.code).toBe(0);
  expect(readlinkSync(join(installDir, "ks"))).toBe("kerstel");
});

test("another ks on PATH is left alone", async () => {
  shim("ks", "echo someone else's ks");
  const result = await install({});
  expect(result.code).toBe(0);
  expect(existsSync(join(installDir, "ks"))).toBe(false);
  expect(result.stdout).toContain("ks is already taken by");
  expect(result.stdout).toContain("so use kerstel");
});

test("a regular file named ks in the install directory is left alone", async () => {
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, "ks"), "mine");
  const result = await install({});
  expect(result.code).toBe(0);
  expect(readFileSync(join(installDir, "ks"), "utf8")).toBe("mine");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test apps/website/test/install.test.ts`
Expected: the four new tests FAIL.

- [ ] **Step 3: Implement** in `install.sh`, a function called from `main` right after the version check:

```sh
link_shortcut() {
  local dir="$1" found
  if [ -L "${dir}/ks" ]; then
    case "$(readlink "${dir}/ks")" in
      kerstel | "${dir}/kerstel")
        ln -sf kerstel "${dir}/ks"
        say "Linked ks -> kerstel"
        return
        ;;
    esac
  fi
  if [ -e "${dir}/ks" ] || [ -L "${dir}/ks" ]; then
    say "ks is already taken by ${dir}/ks, so use kerstel"
    return
  fi
  found="$(command -v ks 2>/dev/null || true)"
  if [ -n "$found" ]; then
    say "ks is already taken by ${found}, so use kerstel"
    return
  fi
  ln -s kerstel "${dir}/ks" && say "Linked ks -> kerstel"
}
```

Change the final line of `main` to: `say "Next: run 'ks doctor', then 'ks init' inside a project."` when the link exists, and the `kerstel` form otherwise.

In `release.yml`'s `installer` job, after the `kerstel --version` check, add `"$HOME/.local/bin/ks" --version` (the runners have no other `ks`).

- [ ] **Step 4: Run the tests and shellcheck**

Run: `bun test apps/website/test/install.test.ts && shellcheck apps/website/src/static/install.sh && bun run --cwd apps/website build`
Expected: PASS, no shellcheck findings, `docs/install.sh` regenerated.

- [ ] **Step 5: Commit**

```bash
git add apps/website/src/static/install.sh apps/website/test/install.test.ts docs/install.sh .github/workflows/release.yml
git commit -m "feat(install): add ks as a shortcut for kerstel"
```

---

### Task 10: Pseudo-terminal end to end, docs, changelog, and roadmap

**Files:**
- Create: `packages/cli/test/e2e-tty.test.ts`
- Modify: `README.md`, `apps/website/src/pages/docs/getting-started.md`, `apps/website/src/pages/docs/cli.md`, `apps/website/src/pages/index.md` (terminal examples, if any show `init` or `doctor` output), `CHANGELOG.md`, `ROADMAP.md`, generated `docs/`

- [ ] **Step 1: Write the pseudo-terminal test**

```ts
// packages/cli/test/e2e-tty.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const BINARY = join(REPO, "dist", "kerstel");
const dirs: string[] = [];

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], { cwd: join(REPO, "packages/cli"), stdout: "ignore", stderr: "pipe" });
  expect(await build.exited).toBe(0);
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Runs argv inside a pseudo-terminal, pressing Enter each time `prompt` appears. */
async function inTerminal(argv: string[], cwd: string, env: Record<string, string>, prompts: string[]) {
  const command = argv.map((a) => `'${a}'`).join(" ");
  const wrapped =
    process.platform === "darwin" ? ["script", "-q", "/dev/null", ...argv] : ["script", "-qec", command, "/dev/null"];
  const proc = Bun.spawn(wrapped, { cwd, env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let seen = "";
  let next = 0;
  const decoder = new TextDecoder();
  const timer = setTimeout(() => proc.kill(), 30_000);
  for await (const chunk of proc.stdout) {
    seen += decoder.decode(chunk);
    while (next < prompts.length && seen.includes(prompts[next]!)) {
      await Bun.sleep(150);
      proc.stdin.write("\r");
      proc.stdin.flush();
      next += 1;
    }
  }
  clearTimeout(timer);
  return { code: await proc.exited, output: seen };
}

test.if(process.platform === "darwin" || process.platform === "linux")(
  "init in a real terminal: Enter accepts the suggestions and applies them",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "kerstel-tty-home-"));
    const root = mkdtempSync(join(tmpdir(), "kerstel-tty-app-"));
    dirs.push(home, root);
    writeFileSync(join(root, "package.json"), '{\n  "name": "tty-app",\n  "scripts": {\n    "dev": "node app.js"\n  }\n}\n');
    writeFileSync(join(root, ".env"), "PORT=3000\nDB_PASSWORD=correct-horse-battery\n");

    const { code, output } = await inTerminal(
      [BINARY, "init"],
      root,
      { KERSTEL_HOME: home, KERSTEL_KEYCHAIN_BACKEND: "file", COLUMNS: "100" },
      ["Look right?", "Apply these changes?"],
    );

    expect(code).toBe(0);
    expect(output).not.toContain("correct-horse-battery");
    expect(output).toContain("Look right?");
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("PORT=3000\nDB_PASSWORD=kerstel://tty-app/DB_PASSWORD\n");
    expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"dev": "kerstel exec -- node app.js"');

    const stop = Bun.spawn([BINARY, "daemon", "stop"], { env: { ...process.env, KERSTEL_HOME: home, KERSTEL_KEYCHAIN_BACKEND: "file" } });
    await stop.exited;
  },
  60_000,
);
```

Run: `bun test packages/cli/test/e2e-tty.test.ts`
Expected: PASS on macOS; on Linux CI too (util-linux `script`). If a prompt string differs from the implementation, fix the test's prompt list to the exact text from Task 6.

- [ ] **Step 2: Docs**

- `README.md`: introduce `ks` in the install section ("The installer also adds `ks`, a shortcut for `kerstel`."), use `ks` in the everyday examples, and describe the new `init` flow in one short paragraph (overview, Enter to accept, change some, one by one).
- `apps/website/src/pages/docs/getting-started.md`: same `ks` introduction; update any `init`/`doctor` output examples to the new look.
- `apps/website/src/pages/docs/cli.md`: add a line under the table saying `ks` works everywhere `kerstel` does; update the `init` row (the overview and three choices), the `doctor` row (`--verbose`, exit code 1 on a problem), the `uninstall` row (removes the `ks` link), and bare `kerstel` (lists the commands, exit 0).
- Check every command, flag, and message against the source (`packages/cli/src`).

- [ ] **Step 3: Changelog and roadmap**

Add under `## 0.1.0 (unreleased)` in `CHANGELOG.md`:
- Added: `ks`, a shortcut for `kerstel`, installed by `install.sh` when nothing else is called `ks`, and removed by `uninstall`.
- Added: `kerstel doctor --verbose` shows the paths and permissions behind each check.
- Changed: `kerstel init` shows every variable and where it would go, then lets you accept the suggestions with Enter, change a few, or go one by one, with arrow-key menus.
- Changed: `kerstel doctor` groups its checks, shows how to fix each problem, and exits 1 when something is wrong.
- Changed: bare `kerstel` lists the commands and exits 0.

Add under `## 0.1.0: first release` in `ROADMAP.md`, ticked:
- `- [x] \`ks\` shortcut, and a friendlier \`init\` and \`doctor\``

- [ ] **Step 4: Build the site and run everything**

Run: `bun run --cwd apps/website build && bun run typecheck && bun run test && shellcheck apps/website/src/static/install.sh`
Expected: all pass; `docs/` updated.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/test/e2e-tty.test.ts README.md apps/website/src/pages CHANGELOG.md ROADMAP.md docs
git commit -m "docs: introduce ks and the new init and doctor; test init in a real terminal"
```
