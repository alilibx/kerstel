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

/** Stands in for a line the parser could not classify at all. */
const UNPARSED_MASK = "«unparsed-line-left-untouched»";
/** A raw line that cannot be hiding a value: empty, whitespace, or a comment. */
const BLANK_OR_COMMENT = /^\s*(#.*)?$/;

/**
 * One `.env` file rendered for DISPLAY: every value that is not already a
 * `kerstel://` reference is replaced by its `describeValue` mask, keeping the
 * key, the `export` prefix, the quoting style and any inline comment.
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
      if (parseReference(line.value) !== null) {
        out += line.text + line.eol;
        continue;
      }
      const mask = redact(line.value);
      // The mask contains no whitespace, quote, `#` or backslash, so wrapping
      // it in the line's own quotes is all the rendering it needs.
      const rendered = line.quote === "" ? mask : `${line.quote}${mask}${line.quote}`;
      out += line.text.slice(0, line.valueStart) + rendered + line.text.slice(line.valueEnd) + line.eol;
      continue;
    }

    if (BLANK_OR_COMMENT.test(line.text)) {
      out += line.text + line.eol;
      continue;
    }

    // `unsupported` is 1-based, and naming the key matches the warning the
    // wizard already printed for this line.
    const key = unsupportedKeys.get(i + 1);
    out += (key === undefined ? UNPARSED_MASK : `${key}=${UNPARSED_MASK}`) + line.eol;
  }

  return out;
}
