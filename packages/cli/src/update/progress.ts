import { theme } from "../ui/theme";

/**
 * The download bar for `kerstel update`, drawn like the one in install.sh so
 * the two paths look the same: a 30-cell bar, the percentage, and the bytes
 * received over the total.
 */
export interface ProgressStyle {
  width?: number;
  accent?: (text: string) => string;
}

/** As install.sh's human_size: MB to one decimal from 1 MiB, whole KB below. */
export function humanSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.floor(bytes / 1024)} KB`;
}

/** One rendering of the bar. With no total, only what has arrived. */
export function progressLine(received: number, total: number | null, style: ProgressStyle = {}): string {
  const width = style.width ?? 30;
  const accent = style.accent ?? theme.accent;
  if (total === null || total <= 0) return `  ${humanSize(received)} received`;
  // A body can outrun its content-length header (a transparently decompressed
  // response, say); the bar never overshoots.
  const got = Math.min(received, total);
  const pct = Math.floor((got * 100) / total);
  const filled = Math.floor((got * width) / total);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `  ${accent(bar)} ${String(pct).padStart(3)}%  ${humanSize(got)} / ${humanSize(total)}`;
}

export interface ProgressBarOptions extends ProgressStyle {
  /** Redraws closer together than this are dropped, except the first and a complete one. */
  minIntervalMs?: number;
  now?: () => number;
}

/** Redraws one line in place with `\r`; `finish` ends it. Safe to finish more than once. */
export class ProgressBar {
  private drawn = false;
  private last = -Infinity;

  constructor(
    private readonly write: (text: string) => void,
    private readonly options: ProgressBarOptions = {},
  ) {}

  update(received: number, total: number | null): void {
    const now = (this.options.now ?? Date.now)();
    const complete = total !== null && received >= total;
    if (this.drawn && !complete && now - this.last < (this.options.minIntervalMs ?? 100)) return;
    this.write(`\r${progressLine(received, total, this.options)}`);
    this.drawn = true;
    this.last = now;
  }

  finish(): void {
    if (!this.drawn) return;
    this.write("\n");
    this.drawn = false;
  }
}
