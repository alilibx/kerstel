import { dim, yellow } from "../output";
import { renderTable } from "../ui/table";
import type { Suggestion } from "./classify";

export interface OverviewRow {
  key: string;
  value: string;
  source: string;
  conflicts: string[];
  target: Suggestion;
  /**
   * May the value be printed in full? The caller decides, and only for a
   * config value that stays in the file on the suggester's own say-so:
   * see `valueColumn`.
   */
  showValue: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The widest a shown value may be, in terminal columns, "…" included. */
const MAX_VALUE_COLUMNS = 40;

/**
 * Characters a shown value must not carry into the terminal:
 *   - C0 and C1 control characters, ESC and DEL included, which can start an
 *     escape sequence;
 *   - the Unicode bidi embeddings, overrides, and isolates (U+202A–U+202E,
 *     U+2066–U+2069) and the marks U+200E, U+200F, and U+061C, which reorder
 *     the text around them, so `abc<RLO>def` renders as `abcfed` and can swap
 *     the columns after it;
 *   - the invisible formatters: the zero-width characters U+200B–U+200D, the
 *     word joiner and invisible operators U+2060–U+2064, the soft hyphen
 *     U+00AD, the Mongolian vowel separator U+180E, and the byte-order mark
 *     U+FEFF, so a value cannot look shorter than its printed length;
 *   - the line and paragraph separators U+2028 and U+2029, which some
 *     terminals honour as a line break and would split the table row.
 * The masked column (`•••• N chars`) never renders the value, so it needs none
 * of this.
 */
const UNSAFE_CHARACTERS =
  /[\u0000-\u001f\u007f-\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * A shown value made safe for the terminal: unsafe characters removed, so a
 * value cannot smuggle an escape sequence or a reordering mark into the
 * overview, and anything wider than `MAX_VALUE_COLUMNS` cut short with a
 * trailing "…".
 */
function displayable(value: string): string {
  const clean = value.replace(UNSAFE_CHARACTERS, "");
  if (Bun.stringWidth(clean) <= MAX_VALUE_COLUMNS) return clean;
  let out = "";
  for (const char of clean) {
    if (Bun.stringWidth(out + char) > MAX_VALUE_COLUMNS - 1) break;
    out += char;
  }
  return `${out}…`;
}

/**
 * What the overview and the one-by-one prompt show for a value: its length
 * and nothing else, unless `showValue` says it is a config value (plaintext,
 * suggested plaintext, not kept by `--keep`, and configuration by
 * `isSafeToDisplay` in classify.ts -- anything looser prints real secrets into
 * CI logs under `--yes`). Spec §5.1 step 2.
 */
export function valueColumn(value: string, showValue: boolean): string {
  return showValue ? displayable(value) : `•••• ${value.length} chars`;
}

/** Spec §5.1 step 2. */
export function renderOverview(rows: OverviewRow[], scope: string, fileNames: string[]): string[] {
  const groups: [Suggestion, string][] = [
    ["project", `Vault, for ${scope} only`],
    ["global", "Vault, shared by all your projects"],
    ["plaintext", `Stays in ${fileNames.join(", ")} as plain text`],
  ];
  // One table over every row, so the columns line up across groups; the
  // group titles are slotted in between its lines afterwards.
  const ordered = groups.map(([target, title]) => ({
    title,
    members: rows.filter((row) => row.target === target),
  }));
  const table = renderTable(
    ordered.flatMap(({ members }) =>
      members.map((row) => [row.key, valueColumn(row.value, row.showValue), dim(row.source)]),
    ),
    { indent: 2 },
  );
  const lines: string[] = [];
  let next = 0;
  for (const { title, members } of ordered) {
    if (members.length === 0) continue;
    lines.push(`${title} (${members.length})`, ...table.slice(next, next + members.length));
    next += members.length;
  }
  // A key that stays plain text is never rewritten, so each file keeps its own
  // value and nothing "wins": only vault-bound keys get the note.
  for (const row of rows.filter((r) => r.conflicts.length > 0 && r.target !== "plaintext")) {
    lines.push("");
    lines.push(
      yellow(`! ${row.key} has different values in ${[row.source, ...row.conflicts].join(" and ")};`),
      yellow(`  the ${row.source} one wins, and the others are kept in the encrypted backup.`),
    );
  }
  return lines;
}

/** Spec §5.1 step 5. */
export function renderChangeSummary(
  changes: { label: string; kind: "env" | "package" | "gitignore"; count: number }[],
): string[] {
  return changes.map(({ label, kind, count }) => {
    if (kind === "env") return `${label}: ${plural(count, "value becomes a reference", "values become references")}`;
    if (kind === "package") return `${label}: ${plural(count, "script goes through Kerstel", "scripts go through Kerstel")}`;
    return `${label}: ${plural(count, "line hiding .env files is removed", "lines hiding .env files are removed")}`;
  });
}
