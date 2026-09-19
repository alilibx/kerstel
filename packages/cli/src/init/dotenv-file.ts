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
  /** This line's terminator: "\n", "\r\n", a lone "\r", or "" for an unterminated last line. */
  eol: string;
}

export interface DotenvPair {
  kind: "pair";
  text: string;
  eol: string;
  key: string;
  /** Decoded value: quotes stripped, and `\n` expanded inside double quotes. */
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

/**
 * Decodes the escapes BOTH runtimes that may read this file decode, and not
 * one more. Measured on 2026-09-18 (bun 1.3.10 auto-load and `--env-file`,
 * node v24.19.0 `--env-file`), reading one key per escape:
 *
 *   escape | bun           | node --env-file
 *   \n     | newline       | newline
 *   \r     | carriage ret. | literal `\r`
 *   \t     | literal `\t`  | literal `\t`
 *   \$     | `$`           | literal `\$`
 *   \"     | literal `\"`  | value ends at the quote
 *   \\     | literal `\\`  | literal `\\`
 *   \U, \x | literal       | literal
 *
 * Only `\n` is decoded by both, so only `\n` is decoded here. Dropping the
 * backslash from anything else would store `C:\Users\x` as `C:Usersx` and
 * `\\server\share` as `\server\share` -- a Windows path the app would then get
 * back mangled, which is worse than leaving the escape alone.
 */
function decodeDoubleQuoted(body: string): string {
  // The pair form matters: it consumes `\\` as one unit, so the `n` in `\\n`
  // is a plain letter and not a newline.
  return body.replace(/\\(.)/g, (match, char: string) => (char === "n" ? "\n" : match));
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
const KEY_SHAPED = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/** Longer than any variable name in practice; base64 lines are often longer. */
const MAX_KEY_LENGTH = 64;

/**
 * The label for a line that has no printable key: prose, a base64 line, a
 * name too long to be one. It names the line, never its text, so a warning
 * can point at it and `plaintextKeysRemaining` can count it without either
 * reprinting what may be key material.
 */
function lineLabel(lineNumber: number): string {
  return `line ${lineNumber}`;
}

/**
 * The last line of an unquoted base64 blob: `kL0tuEJ6...abcd==`. `PAIR`
 * reads it as a key named `kL0tuEJ6...abcd` assigned `=`, which would put
 * 60 characters of key material into the overview, the vault, and the
 * rewritten file as a NAME. No variable is named like that: long, mixed case,
 * digits, no underscore, and nothing after the `=` but more padding.
 */
function looksLikeBase64Line(key: string, rest: string): boolean {
  // `_` is allowed so base64url (JWT segments) is caught too; a real name
  // this long with lower AND upper case AND digits AND an empty value is rarer
  // than the token it would otherwise print.
  return (
    key.length >= 16 &&
    /^[A-Za-z0-9_]+$/.test(key) &&
    /[a-z]/.test(key) &&
    /[A-Z]/.test(key) &&
    /[0-9]/.test(key) &&
    /^=?$/.test(rest.trim())
  );
}

/**
 * An unquoted PEM value spans lines: the header is a pair whose value is
 * `-----BEGIN ...-----`, the body is base64, the footer is `-----END ...-----`.
 * No loader reads it back as one value either, but the developer who pasted
 * it has a secret in the file, so the whole block is treated as ONE unsupported
 * value: named by its key, never rewritten, never mined for key names.
 */
const PEM_BEGIN = /^-----BEGIN [A-Z0-9 ]+-----/;
const PEM_END = /-----END [A-Z0-9 ]+-----\s*$/;

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
  const raw: ParsedLine = { line: { kind: "raw", text, eol }, openQuote: null };

  const match = PAIR.exec(text);
  if (!match) {
    // Every line that is neither blank, a comment, nor a pair is recorded:
    // it stays in the file untouched, so the wizard must count it as
    // plaintext remaining rather than calling the file safe to commit. It is
    // NAMED only when the text before `=` looks like a variable name (`MY-KEY`,
    // `my.key`); anything else is more likely value material and gets a line
    // number instead.
    if (!BLANK_OR_COMMENT.test(text)) {
      const equals = text.indexOf("=");
      const candidate = equals > 0 ? text.slice(0, equals).replace(/^\s*(export[ \t]+)?/, "").trimEnd() : "";
      if (equals > 0 && KEY_SHAPED.test(candidate)) {
        unsupported.push({
          key: candidate,
          line: lineNumber,
          reason: "the key contains characters Kerstel does not support",
        });
      } else {
        unsupported.push({ key: lineLabel(lineNumber), line: lineNumber, reason: "the line is not KEY=value" });
      }
    }
    return raw;
  }

  const prefix = match[1] ?? "";
  const key = match[4] ?? "";
  const rest = match[5] ?? "";

  if (key.length > MAX_KEY_LENGTH || looksLikeBase64Line(key, rest)) {
    unsupported.push({
      key: lineLabel(lineNumber),
      line: lineNumber,
      reason: "the text before = does not look like a variable name",
    });
    return raw;
  }

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
  // A lone "\r" is a line ending too, as it is to dotenv and to Node's own
  // parser; reading it as part of the value would swallow the next key.
  const parts = source.split(/(\r\n|\n|\r)/);
  const lines: DotenvLine[] = [];
  const unsupported: UnsupportedValue[] = [];

  // The quote character of a value that opened on an earlier line and has not
  // closed yet. While it is set, every line is a CONTINUATION of that value:
  // carried through as raw text and never inspected, because inspecting it
  // would mean reading key material looking for something to print.
  let openQuote: string | null = null;
  // Inside an unquoted PEM block (see PEM_BEGIN): every line through the
  // footer is body, carried raw and never inspected, for the same reason.
  let inPem = false;
  // The entry for the open PEM block, so a missing footer can be added to its
  // reason: everything after an unterminated block is left untouched too, and
  // the user has to be told that no later key was migrated.
  let pemEntry: UnsupportedValue | null = null;

  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    const eol = parts[i + 1] ?? "";
    const lineNumber = i / 2 + 1;
    // split() leaves an empty final piece after a trailing terminator. Keeping
    // it would append a phantom empty line on every serialize.
    if (i > 0 && text === "" && eol === "") break;

    if (openQuote !== null) {
      if (findClosingQuote(text, -1, openQuote) !== -1) openQuote = null;
      lines.push({ kind: "raw", text, eol });
      continue;
    }
    if (inPem) {
      if (PEM_END.test(text)) inPem = false;
      lines.push({ kind: "raw", text, eol });
      continue;
    }

    const parsed = parseLine(text, eol, lineNumber, unsupported);
    if (
      parsed.line.kind === "pair" &&
      parsed.line.quote === "" &&
      PEM_BEGIN.test(parsed.line.value) &&
      !PEM_END.test(parsed.line.value)
    ) {
      pemEntry = {
        key: parsed.line.key,
        line: lineNumber,
        reason:
          "the value is a PEM block spanning several lines; store it with `kerstel set` " +
          "(pipe the file in) and reference it, or put it on one line in double quotes with \\n",
      };
      unsupported.push(pemEntry);
      lines.push({ kind: "raw", text, eol });
      inPem = true;
      continue;
    }
    openQuote = parsed.openQuote;
    lines.push(parsed.line);
  }

  if (inPem && pemEntry) {
    pemEntry.reason +=
      "; its -----END line is missing, so every line after it was treated as part of the block and left untouched";
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

/**
 * Characters a double-quoted value cannot spell now that a backslash means
 * itself: `\` because `a\nb` would read back as a newline, `"` because the
 * reader stops at it, `\r` because `\r` no longer decodes to one.
 */
const DOUBLE_HOSTILE = /["\\\r]/;
/** Single quotes have no escapes at all, so only a line of literal bytes fits. */
const SINGLE_HOSTILE = /['\n\r]/;

function renderValue(value: string, quote: Quote): string {
  if (quote === "'" || quote === '"') {
    // The asked-for style first, then the other one, so a value keeps its
    // quoting whenever that quoting can hold it.
    if (quote === "'" && !SINGLE_HOSTILE.test(value)) return `'${value}'`;
    if (!DOUBLE_HOSTILE.test(value)) return `"${value.replace(/\n/g, "\\n")}"`;
    if (!SINGLE_HOSTILE.test(value)) return `'${value}'`;
    // Neither style can hold it: a value carrying a single quote AND a
    // backslash, double quote or carriage return. No dotenv spelling exists,
    // so this escapes and accepts that the reader will see the backslashes.
    // `init` never lands here -- it writes `kerstel://scope/KEY` references.
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n");
    return `"${escaped}"`;
  }
  if (value === "") return "";
  if (/[\s#"'\\]/.test(value)) return renderValue(value, '"');
  return value;
}

/**
 * Rewrites only the value at `file.lines[index]`, which must be a pair.
 * Uses the same rendering as `setValue` preserves quoting style.
 * Throws if the line is not a pair.
 */
export function setLineValue(file: DotenvFile, index: number, value: string): void {
  const line = file.lines[index];
  if (!line || line.kind !== "pair") {
    throw new Error(`Cannot rewrite value at line ${index}: line is not a pair`);
  }

  const rendered = renderValue(value, line.quote);
  const text = line.text.slice(0, line.valueStart) + rendered + line.text.slice(line.valueEnd);
  file.lines[index] = {
    ...line,
    text,
    value,
    valueStart: line.valueStart,
    valueEnd: line.valueStart + rendered.length,
  };
}

/**
 * `uninstall`'s inverse of `init`'s rewrite: puts a plaintext value back on a
 * line that holds a reference, keeping the line's ORIGINAL spelling.
 *
 * `setLineValue` re-renders through `renderValue`, which is right for `init`
 * (it writes references, which fit any quoting) but wrong for a restore:
 * `B="with \"escape\""` would come back as `B='with \"escape\"'`, and `E=a"b`
 * as `E='a"b'`. Both read back the same, but the file is no longer the one the
 * developer wrote. So the line's own quote style is tried verbatim first --
 * `quote + value + quote`, or the raw value when unquoted -- and kept whenever
 * the parser reads that line back to the same value. Only a value its original
 * quoting cannot hold falls back to `renderValue`.
 */
export function restoreLineValue(file: DotenvFile, index: number, value: string): void {
  const line = file.lines[index];
  if (!line || line.kind !== "pair") {
    throw new Error(`Cannot rewrite value at line ${index}: line is not a pair`);
  }

  const verbatim = `${line.quote}${value}${line.quote}`;
  const text = line.text.slice(0, line.valueStart) + verbatim + line.text.slice(line.valueEnd);
  const reread = parseDotenv(text);
  const pair = reread.lines[0];
  if (
    reread.lines.length === 1 &&
    reread.unsupported.length === 0 &&
    pair?.kind === "pair" &&
    pair.key === line.key &&
    pair.value === value &&
    pair.valueStart === line.valueStart &&
    pair.valueEnd === line.valueStart + verbatim.length
  ) {
    file.lines[index] = { ...pair, eol: line.eol };
    return;
  }
  setLineValue(file, index, value);
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
    setLineValue(file, i, value);
    count += 1;
  }
  return count;
}
