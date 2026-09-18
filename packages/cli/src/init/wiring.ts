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

/** How many unchanged lines to show around an edit. */
const CONTEXT_LINES = 1;

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
