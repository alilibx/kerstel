import { UNSAFE_CHARACTERS } from "../init/overview";

/**
 * A frame is the screen as rows of text, built from plain cells that are
 * fitted by display width (`Bun.stringWidth`), so wide and combining
 * characters line up. Colour is applied after fitting, to whole cells, so a
 * cut never lands inside an escape sequence.
 */

export type Frame = string[];

/**
 * Text with every character that could steer the terminal removed: control
 * characters, ESC included, and the bidi and invisible marks the `init`
 * overview strips too. File names and paths come from directory entries, so
 * a file called `.env\x1b[2J` must not clear the screen.
 */
export function clean(text: string): string {
  return text.replace(UNSAFE_CHARACTERS, "");
}

/** Exactly `width` columns: cleaned, cut with "…" when longer, padded with spaces when shorter. */
export function fit(raw: string, width: number): string {
  if (width <= 0) return "";
  const text = clean(raw);
  const w = Bun.stringWidth(text);
  if (w <= width) return text + " ".repeat(width - w);
  let out = "";
  for (const char of text) {
    if (Bun.stringWidth(out + char) > width - 1) break;
    out += char;
  }
  return out + "…" + " ".repeat(Math.max(0, width - 1 - Bun.stringWidth(out)));
}

/** Text centred in `width` columns. */
export function centre(text: string, width: number): string {
  const w = Bun.stringWidth(text);
  if (w >= width) return fit(text, width);
  const left = Math.floor((width - w) / 2);
  return " ".repeat(left) + text + " ".repeat(width - w - left);
}

/**
 * Column widths for rows of cells, shared out within `width`: every column
 * but the last as wide as its widest cell, capped at `max`, and the last
 * column takes what is left.
 */
export function columnWidths(rows: string[][], width: number, gap = 2, max = 60, min = 8): number[] {
  const count = Math.max(0, ...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < count; c += 1) {
    widths.push(Math.min(max, Math.max(0, ...rows.map((r) => Bun.stringWidth(clean(r[c] ?? ""))))));
  }
  // Together they must fit: shrink the widest column a column at a time, down
  // to `min` (or its own width, if narrower), so a 70-character reference
  // cannot push the mask and the update time off the row.
  const available = width - gap * Math.max(0, count - 1);
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > available) {
    let widest = -1;
    for (let c = 0; c < count; c += 1) {
      if (widths[c]! > min && (widest === -1 || widths[c]! > widths[widest]!)) widest = c;
    }
    if (widest === -1) break;
    widths[widest]! -= 1;
    total -= 1;
  }
  const fixed = widths.slice(0, -1).reduce((a, b) => a + b + gap, 0);
  if (count > 0) widths[count - 1] = Math.max(0, width - fixed);
  return widths;
}

/** The first row index to show so `cursor` stays inside a window of `height` rows. */
export function scrollTop(cursor: number, top: number, height: number, total: number): number {
  if (height <= 0) return 0;
  let next = Math.min(top, Math.max(0, total - height));
  if (cursor < next) next = cursor;
  if (cursor >= next + height) next = cursor - height + 1;
  return Math.max(0, next);
}
