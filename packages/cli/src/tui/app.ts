import type { ProjectRefs } from "../project-refs";
import type { Loaded, SecretRow } from "./data";
import { scrollTop } from "./frame";
import { isChar, isNamed, type Key } from "./keys";
import { referenceRows } from "./screens/references";
import { secretRows } from "./screens/secrets";
import type { Row } from "./widgets/list";

/**
 * The UI's state and its pure reducer. Terminal UI spec §4.2: `update` takes
 * the state and one event and returns the next state and the effects to run.
 * It never touches the terminal or the vault, so every key sequence is
 * testable without either.
 */

export type ScreenName = "secrets" | "references";
export const SCREENS: ScreenName[] = ["secrets", "references"];

export interface ListState {
  cursor: number;
  top: number;
  filter: string;
}

export interface State {
  screen: ScreenName;
  width: number;
  height: number;
  secrets: SecretRow[];
  refs: ProjectRefs | null;
  lists: Record<ScreenName, ListState>;
  /** The filter line while it is open for typing. */
  filtering: boolean;
  help: boolean;
  byKey: boolean;
  loading: boolean;
  status: string | null;
  quit: boolean;
}

export type Event =
  | { type: "key"; key: Key }
  | { type: "resize"; width: number; height: number }
  | ({ type: "loaded" } & Loaded)
  | { type: "error"; message: string };

export type Effect = { type: "reload" };

export function initialState(width: number, height: number): State {
  const list = (): ListState => ({ cursor: 0, top: 0, filter: "" });
  return {
    screen: "secrets",
    width,
    height,
    secrets: [],
    refs: null,
    lists: { secrets: list(), references: list() },
    filtering: false,
    help: false,
    byKey: false,
    loading: true,
    status: null,
    quit: false,
  };
}

/** Rows of the list area: the tab bar, a header, the filter line and the status bar take four. */
export function listHeight(state: State): number {
  return Math.max(1, state.height - 4);
}

function matches(row: Row, filter: string): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return row.cells.some((cell) => cell.toLowerCase().includes(needle));
}

/** The rows a screen shows: its data, filtered. */
export function rowsFor(state: State, screen: ScreenName = state.screen): Row[] {
  const filter = state.lists[screen].filter;
  if (screen === "secrets") return secretRows(state.secrets).filter((r) => matches(r, filter));
  if (!state.refs) return [];
  const stored = new Set(state.secrets.map((s) => s.reference));
  const rows = referenceRows(state.refs, state.byKey, stored);
  // A filtered tree keeps only matching rows; headings show when they match too.
  return rows.filter((r) => matches(r, filter));
}

function withList(state: State, screen: ScreenName, change: Partial<ListState>): State {
  const list = { ...state.lists[screen], ...change };
  const total = rowsFor({ ...state, lists: { ...state.lists, [screen]: list } }, screen).length;
  list.cursor = Math.max(0, Math.min(list.cursor, total - 1));
  list.top = scrollTop(list.cursor, list.top, listHeight(state), total);
  return { ...state, lists: { ...state.lists, [screen]: list } };
}

function move(state: State, delta: number | "start" | "end"): State {
  const list = state.lists[state.screen];
  const total = rowsFor(state).length;
  const cursor = delta === "start" ? 0 : delta === "end" ? total - 1 : list.cursor + delta;
  return withList(state, state.screen, { cursor });
}

function switchTo(state: State, screen: ScreenName): State {
  return { ...state, screen, filtering: false };
}

type Result = { state: State; effects: Effect[] };
const done = (state: State, effects: Effect[] = []): Result => ({ state, effects });

/** Spec §4.5: the References scan runs on entering the screen, so files changed meanwhile show. */
function enter(state: State, screen: ScreenName): Result {
  if (screen === state.screen) return done(state);
  const next = switchTo(state, screen);
  return screen === "references" ? done({ ...next, loading: true }, [{ type: "reload" }]) : done(next);
}

export function update(state: State, event: Event): Result {
  switch (event.type) {
    case "resize": {
      const next: State = { ...state, width: event.width, height: event.height };
      return done(SCREENS.reduce<State>((s, screen) => withList(s, screen, {}), next));
    }
    case "loaded": {
      const next: State = { ...state, secrets: event.secrets, refs: event.refs, loading: false };
      return done(SCREENS.reduce<State>((s, screen) => withList(s, screen, {}), next));
    }
    case "error":
      return done({ ...state, loading: false, status: event.message });
    case "key":
      return onKey({ ...state, status: null }, event.key);
  }
}

function onKey(state: State, key: Key): Result {
  if (key.kind === "ctrl" && key.char === "c") return done({ ...state, quit: true });

  if (state.help) return done({ ...state, help: isChar(key, "q") ? state.help : false, quit: isChar(key, "q") });

  // While the filter line is open, every key goes to it. Spec §4.3.
  if (state.filtering) {
    const list = state.lists[state.screen];
    if (isNamed(key, "esc")) return done(withList({ ...state, filtering: false }, state.screen, { filter: "", cursor: 0, top: 0 }));
    if (isNamed(key, "enter")) return done({ ...state, filtering: false });
    if (isNamed(key, "backspace")) {
      return done(withList(state, state.screen, { filter: [...list.filter].slice(0, -1).join(""), cursor: 0, top: 0 }));
    }
    if (key.kind === "char") return done(withList(state, state.screen, { filter: list.filter + key.char, cursor: 0, top: 0 }));
    return done(state);
  }

  if (isChar(key, "q")) return done({ ...state, quit: true });
  if (isChar(key, "?")) return done({ ...state, help: true });
  if (isNamed(key, "tab")) return enter(state, SCREENS[(SCREENS.indexOf(state.screen) + 1) % SCREENS.length]!);
  if (isNamed(key, "backtab")) {
    return enter(state, SCREENS[(SCREENS.indexOf(state.screen) + SCREENS.length - 1) % SCREENS.length]!);
  }
  if (key.kind === "char" && /^[1-9]$/.test(key.char)) {
    const screen = SCREENS[Number(key.char) - 1];
    return screen ? enter(state, screen) : done(state);
  }
  if (isChar(key, "j") || isNamed(key, "down")) return done(move(state, 1));
  if (isChar(key, "k") || isNamed(key, "up")) return done(move(state, -1));
  if (isNamed(key, "pagedown")) return done(move(state, listHeight(state)));
  if (isNamed(key, "pageup")) return done(move(state, -listHeight(state)));
  if (isChar(key, "g") || isNamed(key, "home")) return done(move(state, "start"));
  if (isChar(key, "G") || isNamed(key, "end")) return done(move(state, "end"));
  if (isChar(key, "/")) return done({ ...state, filtering: true });
  if (isNamed(key, "esc")) return done(withList(state, state.screen, { filter: "" }));

  if (state.screen === "references") {
    if (isChar(key, "b")) return done(withList({ ...state, byKey: !state.byKey }, "references", { cursor: 0, top: 0 }));
    if (isChar(key, "R")) return done({ ...state, loading: true }, [{ type: "reload" }]);
    if (isNamed(key, "enter")) {
      const row = rowsFor(state)[state.lists.references.cursor];
      if (!row?.reference) return done(state);
      // Jump to that secret on the Secrets screen, with any filter there cleared.
      const index = secretRows(state.secrets).findIndex((r) => r.reference === row.reference);
      if (index === -1) return done(state);
      return done(withList(switchTo(state, "secrets"), "secrets", { filter: "", cursor: index }));
    }
  }
  return done(state);
}
