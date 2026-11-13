import type { Theme } from "../../ui/theme";
import { columnWidths, fit } from "../frame";

/** One list row: plain cells, a tone for colour, and the secret it names, if any. */
export interface Row {
  cells: string[];
  tone: "normal" | "heading" | "dim" | "problem";
  reference?: string;
  /** Spans the row instead of filling the first column, like a heading. */
  span?: boolean;
}

export function inverse(theme: Theme, text: string): string {
  return theme.color ? `\x1b[7m${text}\x1b[27m` : text;
}

/**
 * The visible window of a list: `height` lines, each exactly `width` columns,
 * the cursor row marked with "›" and, in colour, shown in reverse video.
 */
export function renderList(
  rows: Row[],
  header: string[] | null,
  options: { width: number; height: number; cursor: number; top: number; empty: string },
  theme: Theme,
): string[] {
  const { width, height, cursor, top, empty } = options;
  const inner = width - 2;
  // A heading spans the row, so a long one ("Referenced by no project") does
  // not widen the first column for every row under it.
  const spans = (row: Row) => row.tone === "heading" || row.span === true;
  const cellRows = rows.filter((r) => !spans(r)).map((r) => r.cells);
  const widths = columnWidths(header ? [header, ...cellRows] : cellRows, inner);
  const line = (cells: string[]) => fit(cells.map((cell, i) => fit(cell, widths[i] ?? 0)).join("  "), inner);
  const text = (row: Row) => (spans(row) ? fit(row.cells.filter((c) => c !== "").join("  "), inner) : line(row.cells));

  const out: string[] = [];
  if (header) out.push(theme.dim(`  ${line(header)}`));
  const body = height - out.length;
  if (rows.length === 0) {
    out.push(theme.dim(fit(`  ${empty}`, width)));
    while (out.length < height) out.push(" ".repeat(width));
    return out;
  }
  for (let i = top; i < Math.min(rows.length, top + body); i += 1) {
    const row = rows[i]!;
    const shown = text(row);
    const styled =
      row.tone === "heading"
        ? theme.bold(shown)
        : row.tone === "dim"
          ? theme.dim(shown)
          : row.tone === "problem"
            ? theme.red(shown)
            : shown;
    out.push(i === cursor ? inverse(theme, `› ${shown}`) : `  ${styled}`);
  }
  while (out.length < height) out.push(" ".repeat(width));
  return out;
}
