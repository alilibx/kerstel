import { parseReference } from "../reference";
import { parseDotenv } from "./dotenv-file";

/** Shape and size only. A value's CONTENT never reaches the terminal. */
export function describeValue(value: string): string {
  if (value.trim() === "") return "empty";
  const kind = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? "url" : "opaque";
  return `${value.length} chars, ${kind}`;
}

/**
 * The stand-in a removed value gets in a printed diff: its shape and size,
 * rendered as one unquoted token so the masked line still parses as the `.env`
 * line it is standing in for.
 */
function redact(value: string): string {
  return `«${describeValue(value).replace(/,?\s+/g, "-")}»`;
}

/**
 * A comment's text for DISPLAY: the `#` and the whitespace around it stay, the
 * text becomes its length. A comment is where an old key gets parked
 * (`# OPENAI_API_KEY=sk-...`), so its text is treated like a value.
 */
function redactComment(comment: string): string {
  const match = /^(\s*#+\s*)([\s\S]*?)(\s*)$/.exec(comment)!;
  const [, lead, text, tail] = match;
  return text === "" ? comment : `${lead}«${text!.length}-chars-comment»${tail}`;
}

/** The part of a pair line after its value: a closing quote, whitespace, and maybe a comment. */
function maskTrailing(trailing: string): string {
  const hash = trailing.indexOf("#");
  return hash === -1 ? trailing : trailing.slice(0, hash) + redactComment(trailing.slice(hash));
}

/** Stands in for a line the parser could not classify at all. */
const UNPARSED_MASK = "«unparsed-line-left-untouched»";
/** A raw line that cannot be hiding a value: empty, whitespace, or a comment. */
const BLANK_OR_COMMENT = /^\s*(#.*)?$/;

/**
 * One `.env` file rendered for DISPLAY: every value that is not already a
 * reference is replaced by its `describeValue` mask, keeping the
 * key, the `export` prefix and the quoting style. Comment text, on a line of
 * its own or after a value, is masked too: it is where an old key gets
 * commented out.
 *
 * It masks EVERY value, not only the ones this run migrates. Rule 1 has no
 * exceptions: `renderDiff` prints a line of context around every edit, so a
 * value the wizard is deliberately leaving alone reaches the terminal whenever
 * it sits next to a rewritten key. That covers `--keep`, a "plaintext" answer,
 * and a value the parser refused.
 *
 * Applied to BOTH sides, which has a second benefit: an untouched key masks to
 * the same text on each side, so its line is identical and falls out of the
 * hunk rather than showing up as a spurious edit.
 *
 * A raw line is masked unless it is blank or a comment. A `.env` line that is
 * neither a pair nor a comment is either the opening of a multi-line quoted
 * value or one of its continuation lines -- precisely the material the parser
 * has just told us it cannot reason about, and which `DotenvFile.unsupported`
 * records only the first line of.
 */
export function maskForDisplay(source: string): string {
  const file = parseDotenv(source);
  const unsupportedKeys = new Map(file.unsupported.map((entry) => [entry.line, entry.key]));

  let out = "";
  for (let i = 0; i < file.lines.length; i += 1) {
    const line = file.lines[i]!;

    if (line.kind === "pair") {
      // A value that is ALREADY a reference is not a secret and keeps its own
      // text -- masking it would invent a diff line for a key nothing touches.
      if (parseReference(line.value, line.key) !== null) {
        out += line.text.slice(0, line.valueEnd) + maskTrailing(line.text.slice(line.valueEnd)) + line.eol;
        continue;
      }
      const mask = redact(line.value);
      // The mask contains no whitespace, quote, `#` or backslash, so wrapping
      // it in the line's own quotes is all the rendering it needs.
      const rendered = line.quote === "" ? mask : `${line.quote}${mask}${line.quote}`;
      out += line.text.slice(0, line.valueStart) + rendered + maskTrailing(line.text.slice(line.valueEnd)) + line.eol;
      continue;
    }

    if (BLANK_OR_COMMENT.test(line.text)) {
      out += (line.text.trim() === "" ? line.text : redactComment(line.text)) + line.eol;
      continue;
    }

    // `unsupported` is 1-based, and naming the key matches the warning the
    // wizard already printed for this line.
    // A `line N` label is not a key, so it is not rendered as one.
    const key = unsupportedKeys.get(i + 1);
    const named = key !== undefined && !key.startsWith("line ");
    out += (named ? `${key}=${UNPARSED_MASK}` : UNPARSED_MASK) + line.eol;
  }

  return out;
}

/** `NAME=value` at the start of a shell word, with a bare, single- or double-quoted value. */
const ASSIGNMENT = /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=((?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s;&|()'"]+)+)/g;
/** A flag whose name says it carries a credential, and the value after `=` or a space. */
const SECRET_FLAG =
  /(--?[A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|pwd|key|auth|credential)[A-Za-z0-9_-]*)(=|\s+)(?!-)('[^']*'|"(?:[^"\\]|\\.)*"|[^\s;&|()]+)/gi;
/** The password in a URL's `user:password@`. */
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]*:)([^\s/@'"]+)@/gi;

/** A value as it appears in a command, masked, keeping a single surrounding pair of quotes. */
function redactWord(word: string, key?: string): string {
  const quote = word.length >= 2 && (word[0] === "'" || word[0] === '"') && word.at(-1) === word[0] ? word[0] : "";
  const inner = quote === "" ? word : word.slice(1, -1);
  if (key !== undefined && parseReference(inner, key) !== null) return word;
  return `${quote}${redact(inner)}${quote}`;
}

/**
 * One command line for DISPLAY: the values a script can carry inline are
 * masked, and the commands around them are kept, so a wiring diff still shows
 * what runs. That covers `NAME=value` assignments (`API_TOKEN=... next dev`),
 * the value of a flag named for a credential (`--token ...`, `--api-key=...`),
 * and the password in a URL (`postgres://user:...@host`). A reference stays.
 */
export function maskCommandForDisplay(command: string): string {
  return command
    .replace(ASSIGNMENT, (_m, lead: string, key: string, value: string) => `${lead}${key}=${redactWord(value, key)}`)
    .replace(SECRET_FLAG, (_m, flag: string, sep: string, value: string) => `${flag}${sep}${redactWord(value)}`)
    .replace(URL_PASSWORD, (_m, head: string, password: string) => `${head}${redact(password)}@`);
}

/** A JSON string literal, escapes and all. */
const JSON_STRING = /"(?:[^"\\\n]|\\.)*"/g;

/**
 * A package.json rendered for DISPLAY: every string in it goes through
 * `maskCommandForDisplay`, so a script that sets a secret inline never
 * reaches the terminal. A string with nothing to mask keeps its exact bytes,
 * escapes included, and the file keeps its layout, so both sides of a diff
 * line up as the files do.
 */
export function maskPackageJsonForDisplay(source: string): string {
  return source.replace(JSON_STRING, (literal) => {
    let decoded: string;
    try {
      decoded = JSON.parse(literal) as string;
    } catch {
      return literal;
    }
    const masked = maskCommandForDisplay(decoded);
    return masked === decoded ? literal : JSON.stringify(masked);
  });
}
