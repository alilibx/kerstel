export interface ClipboardDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  which: (cmd: string) => string | null;
  /** Runs argv with `stdin` on standard input; returns the exit code. */
  run: (argv: string[], stdin: string) => number;
}

/** The command that copies stdin to the clipboard here, or null when there is none. */
export function clipboardCommand(deps: Pick<ClipboardDeps, "platform" | "env" | "which">): string[] | null {
  const { platform, env, which } = deps;
  if (platform === "darwin") {
    const pbcopy = which("pbcopy");
    return pbcopy ? [pbcopy] : null;
  }
  if (platform !== "linux") return null;
  if (env.WAYLAND_DISPLAY) {
    const wl = which("wl-copy");
    if (wl) return [wl];
  }
  if (env.DISPLAY) {
    const xclip = which("xclip");
    if (xclip) return [xclip, "-selection", "clipboard"];
    const xsel = which("xsel");
    if (xsel) return [xsel, "--clipboard", "--input"];
  }
  return null;
}

function defaultRun(argv: string[], stdin: string): number {
  const result = Bun.spawnSync(argv, {
    stdin: Buffer.from(stdin),
    stdout: "ignore",
    stderr: "ignore",
    timeout: 2000,
  });
  return result.exitCode ?? -1;
}

/**
 * Copies `text` to the system clipboard through its stdin, never its argv.
 * True only when the tool exits 0; never throws. Inert under tests unless a
 * test hands it a fake `run`.
 */
export function copyToClipboard(text: string, deps: Partial<ClipboardDeps> = {}): boolean {
  if (!deps.run && process.env.KERSTEL_TEST_NO_CLIPBOARD === "1") return false;
  try {
    const argv = clipboardCommand({
      platform: deps.platform ?? process.platform,
      env: deps.env ?? process.env,
      which: deps.which ?? ((cmd) => Bun.which(cmd)),
    });
    if (!argv) return false;
    return (deps.run ?? defaultRun)(argv, text) === 0;
  } catch {
    return false;
  }
}
