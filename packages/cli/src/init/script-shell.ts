/**
 * Just enough shell to wire a package.json script one command at a time.
 *
 * Spec 2026-09-21 §5: a script is split into simple commands at `&&`, `||`,
 * `;`, and `|` with POSIX quoting rules, and the prefix goes in front of each
 * command word, after its leading `NAME=value` words. The prefix is inserted
 * at a character offset and nothing else is touched, so quoting, spacing, and
 * everything the tokeniser does not understand survive byte for byte. What it
 * cannot wire safely, it refuses with a reason, never with a guess.
 */

export type ScriptSkipReason =
  | "changes-directory"
  | "shell-control"
  | "redirection"
  | "unbalanced-quote"
  | "no-command"
  | "nothing-to-wire";

/** The reason as `init` and `doctor` print it. */
export const SKIP_REASON_TEXT: Record<ScriptSkipReason, string> = {
  "changes-directory": "changes directory",
  "shell-control": "shell control",
  redirection: "redirection",
  "unbalanced-quote": "unbalanced quote",
  "no-command": "no command",
  "nothing-to-wire": "nothing to wire",
};

export interface SimpleCommand {
  /** Offset of the command word, after any leading assignments. */
  commandStart: number;
  /** The command word with its quotes and escapes removed. */
  commandWord: string;
}

export type ScriptAnalysis =
  | { kind: "ok"; commands: SimpleCommand[] }
  | { kind: "skipped"; reason: ScriptSkipReason };

/**
 * Command words that never load a JavaScript runtime, so wrapping them would
 * start the daemon for nothing. Everything else is wrapped, including `sh`,
 * `env`, `make`, and the package managers, because the hook reaches every
 * Node and Bun descendant through NODE_OPTIONS.
 */
const LEFT_UNWRAPPED = new Set([
  "echo", "printf", "true", "false", "exit", "test", "[", "sleep",
  "rm", "rmdir", "mkdir", "cp", "mv", "touch", "ls", "cat", "chmod", "ln", "find", "tar", "gzip",
  "git", "docker", "curl", "wget",
]);

/** A `cd` breaks a launcher path relative to the package root. */
const CHANGES_DIRECTORY = new Set(["cd", "pushd", "popd"]);

/** Shell keywords and builtins that make the script more than a list of commands. */
const SHELL_CONTROL = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in",
  "export", "set", "unset", "source", ".", "eval", "exec", "{", "}",
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

type Token =
  | { kind: "word"; start: number; end: number; raw: string; text: string }
  | { kind: "operator"; start: number; end: number; text: "&&" | "||" | ";" | "|" }
  | { kind: "skip"; reason: ScriptSkipReason };

/**
 * POSIX word splitting: whitespace separates, single quotes take everything
 * literally, double quotes honour backslash escapes, a backslash outside
 * quotes escapes the next character. Anything that means more than a word
 * or one of the four operators ends the scan with the reason.
 */
function tokenise(script: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = script.length;

  while (i < n) {
    const c = script[i]!;

    if (c === " " || c === "\t") {
      i += 1;
      continue;
    }
    if (c === "\n" || c === "\r") return [...tokens, { kind: "skip", reason: "shell-control" }];

    if (c === "&" && script[i + 1] === "&") {
      tokens.push({ kind: "operator", start: i, end: i + 2, text: "&&" });
      i += 2;
      continue;
    }
    if (c === "|" && script[i + 1] === "|") {
      tokens.push({ kind: "operator", start: i, end: i + 2, text: "||" });
      i += 2;
      continue;
    }
    if (c === "|" || c === ";") {
      tokens.push({ kind: "operator", start: i, end: i + 1, text: c });
      i += 1;
      continue;
    }
    if (c === "&" || c === "<" || c === ">") return [...tokens, { kind: "skip", reason: "redirection" }];
    if (c === "(" || c === ")" || c === "`") return [...tokens, { kind: "skip", reason: "shell-control" }];

    // A word.
    const start = i;
    let text = "";
    while (i < n) {
      const ch = script[i]!;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "&" || ch === "|" || ch === ";") break;
      if (ch === "<" || ch === ">" || ch === "(" || ch === ")" || ch === "`") break;
      if (ch === "$" && script[i + 1] === "(") return [...tokens, { kind: "skip", reason: "shell-control" }];

      if (ch === "\\") {
        if (i + 1 >= n) return [...tokens, { kind: "skip", reason: "unbalanced-quote" }];
        text += script[i + 1];
        i += 2;
        continue;
      }
      if (ch === "'") {
        const close = script.indexOf("'", i + 1);
        if (close === -1) return [...tokens, { kind: "skip", reason: "unbalanced-quote" }];
        text += script.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      if (ch === '"') {
        i += 1;
        let closed = false;
        while (i < n) {
          const q = script[i]!;
          if (q === '"') {
            closed = true;
            i += 1;
            break;
          }
          if (q === "\\" && i + 1 < n && '"\\$`'.includes(script[i + 1]!)) {
            text += script[i + 1];
            i += 2;
            continue;
          }
          if (q === "$" && script[i + 1] === "(") return [...tokens, { kind: "skip", reason: "shell-control" }];
          if (q === "`") return [...tokens, { kind: "skip", reason: "shell-control" }];
          text += q;
          i += 1;
        }
        if (!closed) return [...tokens, { kind: "skip", reason: "unbalanced-quote" }];
        continue;
      }
      text += ch;
      i += 1;
    }
    tokens.push({ kind: "word", start, end: i, raw: script.slice(start, i), text });
  }
  return tokens;
}

export function analyseScript(script: string): ScriptAnalysis {
  const tokens = tokenise(script);
  const commands: SimpleCommand[] = [];
  let current: Token[] = [];

  const flush = (): ScriptSkipReason | null => {
    const words = current;
    current = [];
    let index = 0;
    while (index < words.length) {
      const word = words[index]!;
      if (word.kind !== "word" || !ASSIGNMENT.test(word.raw)) break;
      index += 1;
    }
    const command = words[index];
    if (!command || command.kind !== "word") return "no-command";
    if (CHANGES_DIRECTORY.has(command.text)) return "changes-directory";
    if (SHELL_CONTROL.has(command.text)) return "shell-control";
    commands.push({ commandStart: command.start, commandWord: command.text });
    return null;
  };

  for (const token of tokens) {
    if (token.kind === "skip") return { kind: "skipped", reason: token.reason };
    if (token.kind === "operator") {
      const reason = flush();
      if (reason) return { kind: "skipped", reason };
      continue;
    }
    current.push(token);
  }
  const reason = flush();
  if (reason) return { kind: "skipped", reason };
  return { kind: "ok", commands };
}

/** True when the script text at this command already carries a wiring prefix, or calls Kerstel by hand. */
function isWiredAt(script: string, command: SimpleCommand, prefixes: readonly string[]): boolean {
  return command.commandWord === "kerstel" || prefixes.some((prefix) => script.startsWith(prefix, command.commandStart));
}

export type ScriptWiring =
  | { kind: "wired"; text: string; changed: boolean }
  | { kind: "skipped"; reason: ScriptSkipReason };

/**
 * The script with `prefix` in front of every command that should carry it and
 * does not yet. A command that carries it already, or calls `kerstel` itself,
 * is left as it is, so a half-wired script is finished and a wired one is
 * returned unchanged.
 */
export function wireScript(script: string, prefix: string): ScriptWiring {
  const analysed = analyseScript(script);
  if (analysed.kind === "skipped") return analysed;

  const wrappable = analysed.commands.filter((command) => !LEFT_UNWRAPPED.has(command.commandWord));
  if (wrappable.length === 0) return { kind: "skipped", reason: "nothing-to-wire" };

  const insertAt = wrappable.filter((command) => !isWiredAt(script, command, [prefix])).map((c) => c.commandStart);
  if (insertAt.length === 0) return { kind: "wired", text: script, changed: false };

  let text = script;
  for (const offset of insertAt.reverse()) text = text.slice(0, offset) + prefix + text.slice(offset);
  return { kind: "wired", text, changed: true };
}

export type ScriptState =
  | { state: "wired" | "partly-wired" | "not-wired" }
  | { state: "skipped"; reason: ScriptSkipReason };

/** What `doctor` says about one script. Spec §6, first matching row wins. */
export function scriptState(script: string, prefix: string): ScriptState {
  const analysed = analyseScript(script);
  if (analysed.kind === "skipped") return { state: "skipped", reason: analysed.reason };
  const wrappable = analysed.commands.filter((command) => !LEFT_UNWRAPPED.has(command.commandWord));
  if (wrappable.length === 0) return { state: "skipped", reason: "nothing-to-wire" };
  const wired = wrappable.filter((command) => isWiredAt(script, command, [prefix])).length;
  if (wired === 0) return { state: "not-wired" };
  if (wired < wrappable.length) return { state: "partly-wired" };
  return { state: "wired" };
}

/**
 * The script with every occurrence of any of `prefixes` removed from in front
 * of a command word. A script the tokeniser refuses is returned unchanged,
 * since nothing can be said about where its commands start.
 */
export function unwireScript(script: string, prefixes: readonly string[]): string {
  const analysed = analyseScript(script);
  if (analysed.kind === "skipped") return script;

  const removals: Array<{ start: number; length: number }> = [];
  for (const command of analysed.commands) {
    const prefix = prefixes.find((candidate) => script.startsWith(candidate, command.commandStart));
    if (prefix) removals.push({ start: command.commandStart, length: prefix.length });
  }
  let text = script;
  for (const { start, length } of removals.reverse()) text = text.slice(0, start) + text.slice(start + length);
  return text;
}
