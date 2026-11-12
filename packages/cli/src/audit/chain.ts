import { readFileSync } from "node:fs";

export interface ProcessInfo {
  ppid: number;
  name: string;
}

export type ProcessLookup = (pid: number) => ProcessInfo | null;

const MAX_NAMES = 6;
const ROOT_NAMES = new Set(["launchd", "systemd", "init", "kernel_task"]);
const TERMINAL_NAMES = new Set([
  "Terminal",
  "iTerm2",
  "ghostty",
  "kitty",
  "alacritty",
  "wezterm-gui",
  "gnome-terminal-server",
  "konsole",
  "xterm",
  "tmux",
  "sshd",
]);

/** The basename of a command, with one leading `-` (a login shell) removed. */
function displayName(command: string): string {
  const trimmed = command.trim();
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base.startsWith("-") ? base.slice(1) : base;
}

/**
 * Names the programs that started `pid`, nearest first, e.g.
 * `["kerstel", "zsh", "claude", "zsh", "Terminal"]`. Stops at the init
 * process, after a terminal, at six names, on a repeated pid, or when the
 * lookup runs out.
 */
export function processChain(pid: number, lookup: ProcessLookup): string[] {
  const chain: string[] = [];
  const seen = new Set<number>();
  let current = pid;
  while (chain.length < MAX_NAMES && current > 1 && !seen.has(current)) {
    seen.add(current);
    const info = lookup(current);
    if (!info) break;
    const name = displayName(info.name);
    if (name === "" || ROOT_NAMES.has(name)) break;
    chain.push(name);
    if (TERMINAL_NAMES.has(name)) break;
    current = info.ppid;
  }
  return chain;
}

function emptyLookup(): ProcessLookup {
  return () => null;
}

/** One `ps` snapshot, parsed. Each line is `pid ppid command...`, and the command may hold spaces. */
function psLookup(): ProcessLookup {
  let table: Map<number, ProcessInfo> | null = null;
  return (pid) => {
    if (table === null) {
      table = new Map();
      try {
        const res = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,comm="], { stdout: "pipe", stderr: "ignore" });
        if (res.exitCode === 0) {
          for (const line of res.stdout.toString().split("\n")) {
            const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
            if (m) table.set(Number(m[1]), { ppid: Number(m[2]), name: m[3]! });
          }
        }
      } catch {
        // No ps: the table stays empty and every lookup misses.
      }
    }
    return table.get(pid) ?? null;
  };
}

/** `/proc/<pid>/stat`: `pid (name) state ppid ...`. The name may itself hold parentheses. */
function procLookup(): ProcessLookup {
  return (pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const open = stat.indexOf("(");
      const close = stat.lastIndexOf(")");
      if (open < 0 || close < open) return null;
      const ppid = Number(stat.slice(close + 1).trim().split(/\s+/)[1]);
      if (!Number.isInteger(ppid)) return null;
      return { ppid, name: stat.slice(open + 1, close) };
    } catch {
      return null;
    }
  };
}

/** Looks processes up in the operating system. Never throws; where it cannot look, every lookup returns null. */
export function systemProcessLookup(): ProcessLookup {
  switch (process.platform) {
    case "darwin":
      return psLookup();
    case "linux":
      return procLookup();
    default:
      return emptyLookup();
  }
}

export function formatChain(chain: string[] | null): string {
  return chain === null || chain.length === 0 ? "unknown" : chain.join(" ← ");
}
