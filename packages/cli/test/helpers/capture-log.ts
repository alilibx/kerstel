/**
 * Collects everything `console.log` prints until `restore()` is called, so a
 * test can assert on a command's output without it reaching the runner's
 * stdout. The CLI's `ok`, `fail`, and `info` helpers all go through
 * `console.log`, which is why this is enough for their messages.
 */
export function captureLog(): { lines: string[]; text: () => string; restore: () => void } {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    text: () => lines.join("\n"),
    restore: () => {
      console.log = realLog;
    },
  };
}
