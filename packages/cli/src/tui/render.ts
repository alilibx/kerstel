import { cliName } from "../ui/cli-name";
import type { Theme } from "../ui/theme";
import { NEW_SCOPE, SCREENS, listHeight, rowsFor, type Modal, type ScreenName, type State } from "./app";
import { centre, fit, type Frame } from "./frame";
import { SECRETS_HEADER } from "./screens/secrets";
import { inverse, renderList } from "./widgets/list";

/**
 * State and size in, lines out. Terminal UI spec §4.2. Every line is exactly
 * the terminal's width, so a full redraw needs no clearing logic.
 */

export const MIN_WIDTH = 60;
export const MIN_HEIGHT = 16;

const TITLES: Record<ScreenName, string> = { secrets: "Secrets", references: "References" };

const KEYS: Record<ScreenName, [string, string][]> = {
  // Fits the 60-column minimum; Tab is listed under ?.
  secrets: [
    ["r", "reveal"],
    ["a", "add"],
    ["e", "edit"],
    ["d", "delete"],
    ["/", "filter"],
    ["?", "keys"],
    ["q", "quit"],
  ],
  // Fits the 60-column minimum; Tab is listed under ?.
  references: [
    ["Enter", "go to secret"],
    ["b", "by key"],
    ["R", "rescan"],
    ["/", "filter"],
    ["?", "keys"],
    ["q", "quit"],
  ],
};

const HELP: Record<ScreenName, [string, string][]> = {
  secrets: [
    ["r", "Reveal the value on this row until the next key (recorded in the audit log)"],
    ["a", "Add a secret: pick a scope, type the key, then the value"],
    ["e", "Edit the value on this row"],
    ["d", "Delete this row, after saying how many project files use it"],
  ],
  references: [
    ["Enter", "Go to the secret on this row, on the Secrets screen"],
    ["b", "Group by key instead of by project"],
    ["R", "Scan the project files again"],
  ],
};

const EVERYWHERE: [string, string][] = [
  ["Tab, Shift-Tab, 1 2", "Switch screen"],
  ["j k, ↑ ↓", "Move"],
  ["PageUp PageDown, g G", "Move a page, or to the start or end"],
  ["/", "Filter the list; Esc clears"],
  ["?", "Show these keys"],
  ["q, Ctrl-C", "Quit"],
];

function tabs(state: State, theme: Theme): string {
  const parts = SCREENS.map((screen, i) => {
    const label = ` ${i + 1} ${TITLES[screen]} `;
    return screen === state.screen ? inverse(theme, theme.bold(label)) : theme.dim(label);
  });
  const left = parts.join(" ");
  const right = `${cliName()} ui`;
  const used = SCREENS.reduce((n, s, i) => n + Bun.stringWidth(` ${i + 1} ${TITLES[s]} `), 0) + SCREENS.length - 1;
  const gap = Math.max(1, state.width - used - right.length);
  return left + " ".repeat(gap) + theme.dim(right);
}

function statusBar(state: State, theme: Theme): string {
  const error = state.modal?.kind === "input" ? state.modal.error : null;
  if (error) return theme.red(fit(error, state.width));
  if (state.modal) {
    const keys =
      state.modal.kind === "confirm"
        ? state.modal.defaultYes
          ? "y yes (Enter)  n no  Esc cancel"
          : "y yes  n no (Enter)  Esc cancel"
        : state.modal.kind === "pick-scope"
          ? "Enter choose  Esc cancel"
          : "Enter next  Esc cancel";
    return theme.dim(fit(keys, state.width));
  }
  if (state.status) {
    const text = fit(state.status.text, state.width);
    return state.status.tone === "problem" ? theme.red(text) : theme.green(text);
  }
  if (state.loading) return theme.dim(fit(state.screen === "references" ? "Scanning project files…" : "Loading…", state.width));
  const keys = state.help ? [["any key", "close"] as [string, string]] : KEYS[state.screen];
  return theme.dim(fit(keys.map(([k, what]) => `${k} ${what}`).join("  "), state.width));
}

/** The prompt line of an input or a confirm, where the filter line usually is. */
function modalLine(modal: Modal, width: number, theme: Theme): string | null {
  // The question alone, so the name it asks about fits; the context goes on
  // the row above and the choices, with the default, on the status bar.
  if (modal.kind === "confirm") return theme.bold(fit(modal.question, width));
  if (modal.kind !== "input") return null;
  if (modal.field === "scope") return fit(`New scope: ${modal.text}▏`, width);
  if (modal.field === "key") return fit(`Key in ${modal.scope}: ${modal.text}▏`, width);
  if (modal.field !== "value") return null;
  // Masked: one dot per character typed, never the characters.
  return fit(`Value for ks:${modal.scope}/${modal.key}: ${"•".repeat([...modal.text].length)}▏`, width);
}

function filterLine(state: State, theme: Theme): string {
  const prompt = state.modal ? modalLine(state.modal, state.width, theme) : null;
  if (prompt) return prompt;
  const { filter } = state.lists[state.screen];
  if (state.filtering) return fit(`/${filter}▏`, state.width);
  if (filter) return theme.dim(fit(`Filter: ${filter}   Esc clears`, state.width));
  return " ".repeat(state.width);
}

function helpLines(state: State, theme: Theme): string[] {
  const entries = [...HELP[state.screen], ...EVERYWHERE];
  const width = Math.max(...entries.map(([k]) => Bun.stringWidth(k)));
  const lines = [theme.bold(fit(`  Keys on ${TITLES[state.screen]}`, state.width)), " ".repeat(state.width)];
  for (const [k, what] of entries) lines.push(fit(`  ${k}${" ".repeat(width - Bun.stringWidth(k))}   ${what}`, state.width));
  return lines;
}

export function render(state: State, theme: Theme): Frame {
  const { width, height } = state;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    const lines = Array.from({ length: Math.max(1, height) }, () => " ".repeat(Math.max(0, width)));
    lines[Math.floor(Math.max(1, height) / 2)] = centre(`Terminal too small (${MIN_WIDTH}×${MIN_HEIGHT} minimum)`, width);
    return lines;
  }

  const body = listHeight(state) + 1; // the header row and the list
  let middle: string[];
  if (state.modal?.kind === "pick-scope") {
    const modal = state.modal;
    middle = [
      theme.bold(fit("  Store a secret in which scope?", width)),
      ...renderList(
        modal.choices.map((choice) => ({ cells: [choice], tone: choice === NEW_SCOPE ? "dim" : "normal" })),
        null,
        { width, height: body - 1, cursor: modal.cursor, top: Math.max(0, modal.cursor - (body - 2)), empty: "" },
        theme,
      ),
    ];
  } else if (state.help) {
    middle = helpLines(state, theme);
    while (middle.length < body) middle.push(" ".repeat(width));
    middle = middle.slice(0, body);
  } else {
    const list = state.lists[state.screen];
    const rows = rowsFor(state);
    const empty =
      state.loading
        ? "Loading…"
        : list.filter
          ? `Nothing matches "${list.filter}".`
          : state.screen === "secrets"
            ? `No secrets yet. Store one with ${cliName()} set, or run ${cliName()} init in a project.`
            : `No project is set up yet. Run ${cliName()} init in one.`;
    // The References screen has no column header; a blank line keeps its rows where the list area starts.
    const header = state.screen === "secrets" ? SECRETS_HEADER : null;
    middle = renderList(
      rows,
      header,
      { width, height: header ? body : body - 1, cursor: list.cursor, top: list.top, empty },
      theme,
    );
    if (!header) middle = [" ".repeat(width), ...middle];
  }
  if (state.modal?.kind === "confirm" && state.modal.detail) {
    middle = [...middle.slice(0, -1), theme.yellow(fit(state.modal.detail, width))];
  }
  return [tabs(state, theme), ...middle, filterLine(state, theme), statusBar(state, theme)];
}
