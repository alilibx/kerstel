import { resolveHelper } from "./vault/keychain/exec";

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
    // Over SSH, pbcopy would fill the remote Mac's pasteboard, not the one the person is at.
    if (env.SSH_TTY || env.SSH_CONNECTION) return null;
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

/**
 * The default lookup: root-owned system directories only, never the caller's
 * `PATH`. A script run through npm or Bun has `node_modules/.bin` first on
 * `PATH`, and a dependency could put a `pbcopy` there to read the pairing secret.
 */
export function trustedWhich(cmd: string): string | null {
  return resolveHelper(cmd);
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
      which: deps.which ?? trustedWhich,
    });
    if (!argv) return false;
    return (deps.run ?? defaultRun)(argv, text) === 0;
  } catch {
    return false;
  }
}
