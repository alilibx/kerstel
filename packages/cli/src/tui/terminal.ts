/**
 * The real terminal: alternate screen, raw mode, hidden cursor. Terminal UI
 * spec §4.2. `restore` puts all three back, is safe to call twice, and runs on
 * every exit path, an uncaught error and a process exit included, so a crash
 * never leaves the shell in raw mode. Only frames are written, and the
 * alternate screen is discarded on exit, so nothing shown reaches scrollback.
 */

export interface Terminal {
  readonly width: number;
  readonly height: number;
  start(): void;
  write(text: string): void;
  onData(listener: (chunk: string) => void): void;
  onResize(listener: () => void): void;
  restore(): void;
}

export const ENTER = "\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J";
export const LEAVE = "\x1b[?25h\x1b[?1049l";

export function processTerminal(): Terminal {
  const stdin = process.stdin;
  const stdout = process.stdout;
  let started = false;
  const dataListeners: ((chunk: string) => void)[] = [];
  const resizeListeners: (() => void)[] = [];
  const onData = (chunk: Buffer | string) => {
    for (const listener of dataListeners) listener(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  };
  const onResize = () => {
    for (const listener of resizeListeners) listener();
  };

  const restore = () => {
    if (!started) return;
    started = false;
    stdin.off("data", onData);
    stdout.off("resize", onResize);
    process.off("exit", restore);
    try {
      stdin.setRawMode?.(false);
    } catch {
      // stdin may already be closed on the way out.
    }
    stdin.pause();
    stdout.write(LEAVE);
  };

  return {
    get width() {
      return stdout.columns ?? 80;
    },
    get height() {
      return stdout.rows ?? 24;
    },
    start() {
      if (started) return;
      started = true;
      process.on("exit", restore);
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      stdout.write(ENTER);
    },
    write(text) {
      stdout.write(text);
    },
    onData(listener) {
      dataListeners.push(listener);
    },
    onResize(listener) {
      resizeListeners.push(listener);
    },
    restore,
  };
}
