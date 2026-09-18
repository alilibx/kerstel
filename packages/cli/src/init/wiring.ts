import { bold, dim, green, red } from "../output";

/**
 * Spec §6.2's wiring, and nothing more than it.
 *
 * `package.json` is rewritten through JSON.parse/JSON.stringify, which
 * preserves insertion order for the string keys npm uses, and the source's own
 * indent is detected and reused so the change shows up in `git diff` as the
 * script lines and nothing else.
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

/** The line `init` leaves in .gitignore in place of the env-file lines it removes. */
export const GITIGNORE_NOTE = "# Kerstel: .env files hold references, safe to commit";

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
    contents: serializePackageJson(parsed, source),
    rewrites,
    skipped,
  };
}

/**
 * JSON.stringify with the source file's own indent, line endings, and final
 * newline (or lack of one), so the only lines a rewrite changes are the ones
 * whose content changed.
 */
export function serializePackageJson(parsed: unknown, source: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const body = JSON.stringify(parsed, null, detectIndent(source)).replace(/\n/g, eol);
  const finalNewline = /\r?\n$/.test(source) ? eol : "";
  return body + finalNewline;
}

/** How many unchanged lines to show around an edit. */
const CONTEXT_LINES = 1;

type DiffOp = { kind: "same" | "del" | "add"; text: string };

/**
 * Line-level edit script from a longest-common-subsequence table. The files
 * this wizard diffs are `.env` files and `package.json`, a few hundred lines
 * at most, so the quadratic table costs nothing and needs no dependency.
 */
function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      ops.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  return ops;
}

/**
 * A readable line diff: each run of changes is printed as its removals then
 * its additions, with a line of context either side. Unchanged lines between
 * two edits stay out of it, so a key the wizard leaves alone never shows up as
 * a spurious -/+ pair.
 */
export function renderDiff(label: string, before: string, after: string): string {
  const ops = diffLines(before.split("\n"), after.split("\n"));

  // Which unchanged lines sit close enough to a change to be shown.
  const shown = ops.map((op) => op.kind !== "same");
  ops.forEach((op, index) => {
    if (op.kind === "same") return;
    for (let k = Math.max(0, index - CONTEXT_LINES); k <= Math.min(ops.length - 1, index + CONTEXT_LINES); k += 1) {
      shown[k] = true;
    }
  });

  const lines = [bold(label)];
  let index = 0;
  let printedAny = false;
  while (index < ops.length) {
    if (!shown[index]) {
      index += 1;
      continue;
    }
    // A gap since the last printed line marks the start of a new hunk.
    if (printedAny && !shown[index - 1]) lines.push(dim("  ..."));
    const op = ops[index]!;
    if (op.kind === "same") {
      lines.push(dim(`  ${op.text}`));
      index += 1;
    } else {
      const dels: string[] = [];
      const adds: string[] = [];
      while (index < ops.length && ops[index]!.kind !== "same") {
        const change = ops[index]!;
        (change.kind === "del" ? dels : adds).push(change.text);
        index += 1;
      }
      for (const text of dels) lines.push(red(`- ${text}`));
      for (const text of adds) lines.push(green(`+ ${text}`));
    }
    printedAny = true;
  }
  return lines.join("\n");
}
