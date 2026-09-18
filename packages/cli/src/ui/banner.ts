import type { Theme } from "./theme";

/**
 * The bird from apps/website/src/static/icon-dark.png, rendered once into
 * braille (2x4 dots per cell) and stored as text. Regenerate by hand if the
 * icon changes; it is never converted at runtime. Spec §4.2.
 */
export const BIRD: string[] = [
  "         ⣴⣾⣟⣳⣄",
  "       ⢀⣾⠿⢿⣿⡏⠉",
  "     ⢠⣴⣶⣶⡗⢸⣿⡇",
  "    ⢠⣿⣿⣿⣿⡇⣿⣿⠇",
  "   ⣠⡾⣿⣿⣿⢟⣴⡿⠋",
  "  ⢀⣵⣾⢟⡋⣴⣿⠋⠁",
  " ⡴⢟⣩⢠⡟⠸⣿⣿⣧⡀",
  " ⢠⡾⢣⡿⠁ ⠘⢿⣿⣿⣆",
  "⣰⠿⠁⠋     ⠉⠉⠉⠁",
];

const MIN_COLUMNS = 44;
const TEXT_COLUMN = 18;

export function renderBanner(options: {
  isTTY: boolean;
  columns: number;
  theme: Theme;
  version: string;
}): string | null {
  const { isTTY, columns, theme, version } = options;
  if (!isTTY) return null;
  if (columns < MIN_COLUMNS) return `${theme.accent("◆")} kerstel ${version}`;

  const beside: Record<number, string> = {
    3: `${theme.bold("kerstel")} ${version}`,
    4: theme.dim("Local-first secrets"),
    5: theme.dim("for Node and Bun"),
  };
  return BIRD.map((line, index) => {
    const text = beside[index];
    const bird = theme.accent(line);
    if (!text) return bird;
    return bird + " ".repeat(Math.max(1, TEXT_COLUMN - Bun.stringWidth(line))) + text;
  }).join("\n");
}

/** Prints the banner for the current stdout, followed by a blank line. */
export function printBanner(theme: Theme, version: string): void {
  const banner = renderBanner({
    isTTY: process.stdout.isTTY === true,
    columns: process.stdout.columns ?? 80,
    theme,
    version,
  });
  if (banner !== null) console.log(`${banner}\n`);
}
