/** Aligned columns. Width is measured on screen, so ANSI codes and CJK text line up. */
export function renderTable(rows: string[][], options: { indent?: number; gap?: number } = {}): string[] {
  const indent = " ".repeat(options.indent ?? 0);
  const gap = " ".repeat(options.gap ?? 2);
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, Bun.stringWidth(cell));
    });
  }
  return rows.map((row) => {
    const cells = row.map((cell, column) =>
      column === row.length - 1 ? cell : cell + " ".repeat((widths[column] ?? 0) - Bun.stringWidth(cell)),
    );
    return (indent + cells.join(gap)).trimEnd();
  });
}
