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
/**
 * A single-line array, with whatever follows the closing bracket captured so
 * it can be printed back untouched. A trailing `# comment` is ordinary TOML
 * and used to make this matcher miss, which sent a perfectly editable line
 * into the multi-line branch and aborted `init` with the wrong reason.
 */
const PRELOAD_LINE = /^(\s*preload\s*=\s*)\[([^\]]*)\]([ \t]*(?:#.*)?)$/;
const PRELOAD_OPEN = /^\s*preload\s*=\s*\[/;
/** The string form: `preload = "./setup.ts"`, which TOML allows and bun accepts. */
const PRELOAD_STRING = /^(\s*preload\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')([ \t]*(?:#.*)?)$/;

/** A TOML basic ("...") or literal ('...') string, captured with its offsets. */
const TOML_STRING = /"(?:[^"\\]|\\.)*"|'[^']*'/g;

/**
 * Any machine's copy of the hook, POSIX or Windows. `~/.kerstel` is derived
 * from the running user's home directory, so the path a teammate finds in a
 * committed `bunfig.toml` is almost never the one that works here.
 */
const HOOK_PRELOAD_PATH = /[\\/]\.kerstel[\\/]hook[\\/]preload\.cjs$/;

interface BunfigEntry {
  /** Offset of the token within the array body. */
  start: number;
  end: number;
  /** The path the token denotes, with TOML's quoting undone. */
  path: string;
}

/**
 * The entries of a single-line TOML array, or null when the body holds
 * anything this deliberately small reader cannot account for (a bare value, a
 * nested array, an inline table). Null means "do not reason about this line",
 * which is the only honest answer for a file Kerstel does not own.
 */
/** The path a TOML string token denotes, or null when it does not parse. */
function readTomlString(token: string): string | null {
  if (token.startsWith("'")) return token.slice(1, -1);
  try {
    return JSON.parse(token) as string;
  } catch {
    // TOML basic strings allow escapes JSON does not (`\U0001F600`). Unreadable
    // is not the same as absent, and guessing at it would rewrite the line wrong.
    return null;
  }
}

function readBunfigEntries(body: string): BunfigEntry[] | null {
  const found: BunfigEntry[] = [];
  TOML_STRING.lastIndex = 0;
  let remainder = body;
  for (let match = TOML_STRING.exec(body); match !== null; match = TOML_STRING.exec(body)) {
    const token = match[0];
    const start = match.index;
    const path = readTomlString(token);
    if (path === null) return null;
    found.push({ start, end: start + token.length, path });
    remainder = remainder.replace(token, " ".repeat(token.length));
  }
  // Whatever the tokens did not cover has to be pure array punctuation.
  if (!/^[\s,]*$/.test(remainder)) return null;
  return found;
}

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
      const existing = readBunfigEntries(body);

      // EXACT match, not a substring: "/hook/preload.cjs.disabled" contains
      // "/hook/preload.cjs" and is a different file entirely.
      if (existing?.some((item) => item.path === preloadPath)) {
        return { changed: false, created: false, contents: source };
      }

      // A hook path from ANOTHER machine is REPLACED, never joined. `bunfig.toml`
      // is committed and `~/.kerstel` is per-user, so a teammate who clones
      // inherits a path that does not exist here -- and every `bun` invocation
      // fails on it. Appending would leave the broken one behind forever.
      const stale = existing?.find((item) => HOOK_PRELOAD_PATH.test(item.path));
      if (stale) {
        // Spliced by offset so every other entry, its quoting style, the
        // spacing between them and any trailing comment survive byte for byte.
        const patched = body.slice(0, stale.start) + entry + body.slice(stale.end);
        parts[i] = `${head}[${patched}]${tail}`;
        return { changed: true, created: false, contents: parts.join("") };
      }

      const items = body.trim().replace(/,$/, "");
      parts[i] = `${head}[${items.length === 0 ? entry : `${items}, ${entry}`}]${tail}`;
      return { changed: true, created: false, contents: parts.join("") };
    }

    const stringMatch = PRELOAD_STRING.exec(text);
    if (stringMatch) {
      // A string `preload` is a KEY, so appending another `preload = [...]`
      // line below makes bun fail every launch with "Cannot redefine key
      // 'preload'". The one safe edit is to widen this line into an array.
      const head = stringMatch[1] ?? "";
      const token = stringMatch[2] ?? "";
      const tail = stringMatch[3] ?? "";
      const existing = readTomlString(token);
      if (existing === null) {
        throw new Error(
          "Kerstel cannot read the `preload` value in bunfig.toml without risking the rest of the " +
            `file. Add ${entry} to it by hand, then re-run \`kerstel init\`.`,
        );
      }

      if (existing === preloadPath) return { changed: false, created: false, contents: source };

      // A hook path from another machine is replaced rather than joined, for
      // the same reason it is inside an array.
      parts[i] = HOOK_PRELOAD_PATH.test(existing)
        ? `${head}${entry}${tail}`
        : `${head}[${token}, ${entry}]${tail}`;
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
