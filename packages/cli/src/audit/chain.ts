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

/** /proc/<pid>/stat truncates names to 15 characters, so a full terminal name can arrive cut short. */
const PROC_NAME_LIMIT = 15;

function isTerminal(name: string): boolean {
  if (TERMINAL_NAMES.has(name)) return true;
  if (name.length !== PROC_NAME_LIMIT) return false;
  for (const t of TERMINAL_NAMES) if (t.length > PROC_NAME_LIMIT && t.startsWith(name)) return true;
  return false;
}

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
    if (isTerminal(name)) break;
    current = info.ppid;
  }
  return chain;
}

function emptyLookup(): ProcessLookup {
  return () => null;
}

/** One `ps` snapshot, from the absolute path so a shadowing `ps` on PATH (npm run puts node_modules/.bin first) never runs, parsed. Each line is `pid ppid command...`, and the command may hold spaces. */
function psSnapshot(): Map<number, ProcessInfo> {
  const table = new Map<number, ProcessInfo>();
  try {
    const res = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,comm="], { stdout: "pipe", stderr: "ignore" });
    if (res.exitCode === 0) {
      for (const line of res.stdout.toString().split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (m) table.set(Number(m[1]), { ppid: Number(m[2]), name: m[3]! });
      }
    }
  } catch {
    // No /bin/ps: the table stays empty and every lookup misses.
  }
  return table;
}

/** One `ps` snapshot per lookup function; each lookup reads it. */
function psLookup(): ProcessLookup {
  let table: Map<number, ProcessInfo> | null = null;
  return (pid) => {
    table ??= psSnapshot();
    return table.get(pid) ?? null;
  };
}

/** A snapshot is shared for this long. */
export const SNAPSHOT_TTL_MS = 2000;
/** A pid missing from the shared snapshot refreshes it only if it is at least this old. */
export const SNAPSHOT_RETRY_MS = 250;

export interface ChainSource {
  chainFor(pid: number): string[];
}

/**
 * Names the chain for many pids from one shared process snapshot. A snapshot
 * costs tens of milliseconds, so a burst of new pids reuses the current one
 * for 2 seconds. A pid that is not in it may have started since, so it takes
 * a new snapshot, at most once per request and not within 250 ms of the last.
 * Where there is no table to snapshot (Linux reads /proc per pid), lookups go
 * straight to the system.
 */
export function createChainSource(options: {
  snapshot?: (() => Map<number, ProcessInfo>) | null;
  now?: () => number;
} = {}): ChainSource {
  const take = options.snapshot !== undefined ? options.snapshot : process.platform === "darwin" ? psSnapshot : null;
  const now = options.now ?? Date.now;
  if (take === null) {
    const lookup = systemProcessLookup();
    return { chainFor: (pid) => processChain(pid, lookup) };
  }
  let table: Map<number, ProcessInfo> | null = null;
  let takenAt = 0;
  const refresh = () => {
    table = take();
    takenAt = now();
  };
  return {
    chainFor(pid) {
      if (table === null || now() - takenAt >= SNAPSHOT_TTL_MS) refresh();
      else if (!table.has(pid) && now() - takenAt >= SNAPSHOT_RETRY_MS) refresh();
      const current = table!;
      return processChain(pid, (p) => current.get(p) ?? null);
    },
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
