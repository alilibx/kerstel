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

/** Blank, whitespace, or a comment: a line that cannot be hiding an assignment. */
const BLANK_OR_COMMENT = /^\s*(#.*)?$/;

/**
 * What the wizard is willing to REPRINT as a key name.
 *
 * A line that is not a recognised pair but does contain `=` is usually a key
 * whose name uses a character `PAIR` rejects (`MY-KEY`, `my.key`). Naming it
 * is the whole point -- silence there leaves a secret in plaintext with no
 * warning. But the text before `=` is only a key name if it LOOKS like one:
 * it has to start like an identifier, carry no whitespace, and stay short.
 * Anything else is more likely to be value material, and rule 1 (never print
 * a value) outranks the warning.
 */
const KEY_SHAPED = /^[A-Za-z_][^\s]{0,63}$/;

interface ParsedLine {
  line: DotenvLine;
  /**
   * Set when this line opened a quote it never closed, so the caller knows the
   * lines that follow are continuations of a value rather than assignments.
   */
  openQuote: string | null;
}

function parseLine(
  text: string,
  eol: string,
  lineNumber: number,
  unsupported: UnsupportedValue[],
): ParsedLine {
  const match = PAIR.exec(text);
  if (!match) {
    const equals = text.indexOf("=");
    if (equals > 0 && !BLANK_OR_COMMENT.test(text)) {
      const candidate = text.slice(0, equals).replace(/^\s*(export[ \t]+)?/, "").trimEnd();
      if (KEY_SHAPED.test(candidate)) {
        unsupported.push({
          key: candidate,
          line: lineNumber,
          reason: "the key contains characters Kerstel does not support",
        });
      }
    }
    return { line: { kind: "raw", text, eol }, openQuote: null };
  }

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
      return { line: { kind: "raw", text, eol }, openQuote: head };
    }
    const body = rest.slice(i + 1, closing);
    return {
      line: {
        kind: "pair",
        text,
        eol,
        key,
        value: head === '"' ? decodeDoubleQuoted(body) : body,
        quote: head,
        valueStart: prefix.length + i,
        valueEnd: prefix.length + closing + 1,
      },
      openQuote: null,
    };
  }

  const commentAt = findInlineComment(rest, i);
  const trimmed = rest.slice(i, commentAt).replace(/[ \t]+$/, "");
  return {
    line: {
      kind: "pair",
      text,
      eol,
      key,
      value: trimmed,
      quote: "",
      valueStart: prefix.length + i,
      valueEnd: prefix.length + i + trimmed.length,
    },
    openQuote: null,
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

  // The quote character of a value that opened on an earlier line and has not
  // closed yet. While it is set, every line is a CONTINUATION of that value:
  // carried through as raw text and never inspected, because inspecting it
  // would mean reading key material looking for something to print.
  let openQuote: string | null = null;

  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    const eol = parts[i + 1] ?? "";
    // split() leaves an empty final piece after a trailing terminator. Keeping
    // it would append a phantom empty line on every serialize.
    if (i > 0 && text === "" && eol === "") break;

    if (openQuote !== null) {
      if (findClosingQuote(text, -1, openQuote) !== -1) openQuote = null;
      lines.push({ kind: "raw", text, eol });
      continue;
    }

    const parsed = parseLine(text, eol, i / 2 + 1, unsupported);
    openQuote = parsed.openQuote;
    lines.push(parsed.line);
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
