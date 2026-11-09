import type { ProjectRefs } from "../project-refs";
import { formatReference, type SecretRef } from "../reference";
import { keyProblem, scopeProblem, valueProblem } from "../secret-value";
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
  status: Status | null;
  quit: boolean;
  /**
   * The one decrypted value on screen, if any. Spec §4.4: it replaces the
   * dots until the next key, and lives nowhere else in the state.
   */
  revealed: { reference: string; value: string } | null;
  /**
   * The reveal asked for and not yet answered. Any key cancels it, so a key
   * that arrives in the same read as `r` (`rj`) is never followed by the value
   * appearing anyway; a result for any other request is dropped.
   */
  pendingReveal: { id: number; reference: string } | null;
  /** Numbers each reveal request. */
  nextReveal: number;
  /** An add, edit or delete in progress. While one is open, every key goes to it. */
  modal: Modal | null;
  /** A secret to put the cursor on once the next load lands: the one just stored. */
  select: string | null;
}

export interface Status {
  text: string;
  tone: "info" | "problem";
}

export const NEW_SCOPE = "New scope…";

export type Modal =
  | { kind: "pick-scope"; choices: string[]; cursor: number }
  | { kind: "input"; field: "scope" | "key"; scope: string; text: string; error: string | null }
  | {
      kind: "input";
      field: "value";
      mode: "add" | "edit";
      scope: string;
      key: string;
      /** What has been typed so far. Shown only as dots, and dropped when the modal closes. */
      text: string;
      error: string | null;
    }
  | {
      kind: "confirm";
      action: "store" | "remove";
      ref: SecretRef;
      value: string;
      /** A line of context above the question, such as how many files use the secret. */
      detail: string | null;
      question: string;
      defaultYes: boolean;
      /** A store that may replace an existing value. Without it, a secret created elsewhere meanwhile is refused. */
      replace: boolean;
    };

export type Event =
  | { type: "key"; key: Key }
  | { type: "paste"; text: string }
  | { type: "resize"; width: number; height: number }
  | ({ type: "loaded" } & Loaded)
  | { type: "error"; message: string }
  | { type: "revealed"; id: number; reference: string; value: string | null }
  | { type: "stored"; reference: string }
  | { type: "conflict"; reference: string }
  | { type: "removed"; reference: string; existed: boolean };

/** Spec §4.2: the loop runs these against `data.ts` and feeds the result back as an event. */
export type Effect =
  | { type: "reload" }
  | { type: "reveal"; id: number; ref: SecretRef }
  | { type: "store"; ref: SecretRef; value: string; replace: boolean }
  | { type: "remove"; ref: SecretRef };

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
    revealed: null,
    pendingReveal: null,
    nextReveal: 1,
    modal: null,
    select: null,
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
  if (screen === "secrets") return secretRows(state.secrets, state.revealed).filter((r) => matches(r, filter));
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
      let next: State = { ...state, secrets: event.secrets, refs: event.refs, loading: false, select: null };
      next = SCREENS.reduce<State>((s, screen) => withList(s, screen, {}), next);
      if (state.select) {
        // A filter that hides the secret just stored is cleared, so the cursor can land on it.
        if (!rowsFor(next, "secrets").some((r) => r.reference === state.select)) {
          next = withList(next, "secrets", { filter: "", cursor: 0, top: 0 });
        }
        const index = rowsFor(next, "secrets").findIndex((r) => r.reference === state.select);
        if (index !== -1) next = withList(next, "secrets", { cursor: index });
      }
      return done(next);
    }
    case "error":
      return done({ ...state, loading: false, status: { text: event.message, tone: "problem" } });
    case "revealed":
      // Cancelled by a key since, or an answer to an older request: never shown.
      if (state.pendingReveal?.id !== event.id) return done(state);
      state = { ...state, pendingReveal: null };
      if (event.value === null) {
        return done({ ...state, status: { text: `No secret at ${event.reference}. It was removed elsewhere.`, tone: "problem" } }, [
          { type: "reload" },
        ]);
      }
      return done({ ...state, revealed: { reference: event.reference, value: event.value } });
    case "stored":
      return done(
        { ...state, loading: true, select: event.reference, status: { text: `Stored ${event.reference}`, tone: "info" } },
        [{ type: "reload" }],
      );
    case "conflict":
      return done(
        {
          ...state,
          loading: true,
          status: {
            text: `${event.reference} was created elsewhere since this list loaded. Nothing was stored; add it again to replace it.`,
            tone: "problem",
          },
        },
        [{ type: "reload" }],
      );
    case "removed":
      return done(
        {
          ...state,
          loading: true,
          status: event.existed
            ? { text: `Deleted ${event.reference}`, tone: "info" }
            : { text: `No secret at ${event.reference}. It was already gone.`, tone: "problem" },
        },
        [{ type: "reload" }],
      );
    case "key":
      // Any key hides a revealed value: it shows only until you move. Spec §4.4.
      return onKey(
        { ...state, status: null, revealed: null, pendingReveal: null },
        event.key,
        state.revealed?.reference ?? state.pendingReveal?.reference ?? null,
      );
    case "paste":
      return onPaste({ ...state, status: null, revealed: null, pendingReveal: null }, event.text);
  }
}

/** Distinct project files that reference `reference`, and whether some could not be read. */
export function referencedBy(state: State, reference: string): { files: number; partial: boolean } {
  const files = new Set<string>();
  for (const checkout of state.refs?.checkouts ?? []) {
    for (const file of checkout.files) {
      if (file.references.some((r) => r.reference === reference)) files.add(file.path);
    }
  }
  const partial = (state.refs?.unreachable.length ?? 0) + (state.refs?.unreadable.length ?? 0) > 0;
  return { files: files.size, partial };
}

function scopesForAdd(state: State): string[] {
  const scopes = new Set<string>();
  for (const s of state.secrets) if (s.scope !== "global") scopes.add(s.scope);
  for (const c of state.refs?.checkouts ?? []) if (c.scope !== "global") scopes.add(c.scope);
  return ["global", ...[...scopes].sort(), NEW_SCOPE];
}

/** The secret on the Secrets cursor, if the list has one. */
function currentSecret(state: State): SecretRow | null {
  const row = rowsFor(state, "secrets")[state.lists.secrets.cursor];
  return state.secrets.find((s) => s.reference === row?.reference) ?? null;
}

function onModal(state: State, modal: Modal, key: Key): Result {
  const close = (): Result => done({ ...state, modal: null });
  if (isNamed(key, "esc")) return close();

  if (modal.kind === "pick-scope") {
    if (isChar(key, "j") || isNamed(key, "down")) {
      return done({ ...state, modal: { ...modal, cursor: Math.min(modal.choices.length - 1, modal.cursor + 1) } });
    }
    if (isChar(key, "k") || isNamed(key, "up")) return done({ ...state, modal: { ...modal, cursor: Math.max(0, modal.cursor - 1) } });
    if (isNamed(key, "enter")) {
      const choice = modal.choices[modal.cursor]!;
      return done({
        ...state,
        modal:
          choice === NEW_SCOPE
            ? { kind: "input", field: "scope", scope: "", text: "", error: null }
            : { kind: "input", field: "key", scope: choice, text: "", error: null },
      });
    }
    return done(state);
  }

  if (modal.kind === "confirm") {
    const yes = isChar(key, "y") || isChar(key, "Y") || (isNamed(key, "enter") && modal.defaultYes);
    const no = isChar(key, "n") || isChar(key, "N") || (isNamed(key, "enter") && !modal.defaultYes);
    if (no) return close();
    if (!yes) return done(state);
    const effect: Effect =
      modal.action === "store"
        ? { type: "store", ref: modal.ref, value: modal.value, replace: modal.replace }
        : { type: "remove", ref: modal.ref };
    return done({ ...state, modal: null }, [effect]);
  }

  // A text input: scope, key, or the value in masked mode.
  if (isNamed(key, "backspace")) {
    return done({ ...state, modal: { ...modal, text: [...modal.text].slice(0, -1).join(""), error: null } });
  }
  if (key.kind === "char") return done({ ...state, modal: { ...modal, text: modal.text + key.char, error: null } });
  if (!isNamed(key, "enter")) return done(state);

  if (modal.field === "scope") {
    const error = scopeProblem(modal.text);
    if (error) return done({ ...state, modal: { ...modal, error } });
    return done({ ...state, modal: { kind: "input", field: "key", scope: modal.text, text: "", error: null } });
  }
  if (modal.field === "key") {
    const error = keyProblem(modal.text);
    if (error) return done({ ...state, modal: { ...modal, error } });
    return done({
      ...state,
      modal: { kind: "input", field: "value", mode: "add", scope: modal.scope, key: modal.text, text: "", error: null },
    });
  }
  if (modal.field !== "value") return done(state);
  const error = valueProblem(modal.text);
  if (error) return done({ ...state, modal: { ...modal, error } });
  const reference = formatReference(modal.scope, modal.key);
  const exists = state.secrets.some((s) => s.reference === reference);
  // An add that lands on an existing secret replaces it: say so, and default to No.
  const replacing = modal.mode === "edit" || exists;
  return done({
    ...state,
    modal: {
      kind: "confirm",
      action: "store",
      ref: { scope: modal.scope, key: modal.key },
      value: modal.text,
      detail: modal.mode === "add" && exists ? `${reference} already exists.` : null,
      question: replacing ? `Replace the value of ${reference}?` : `Store ${reference}?`,
      // An add that lands on an existing secret replaces it: say so, and default to No.
      defaultYes: modal.mode === "edit" || !exists,
      replace: replacing,
    },
  });
}

function onSecretsAction(state: State, key: Key, shown: string | null): Result | null {
  if (isChar(key, "a")) return done({ ...state, modal: { kind: "pick-scope", choices: scopesForAdd(state), cursor: 0 } });
  const secret = currentSecret(state);
  if (!secret) return null;
  const ref = { scope: secret.scope, key: secret.key };
  if (isChar(key, "r")) {
    // r again on the row it revealed, or is revealing, hides it, as any key does.
    if (shown === secret.reference) return done(state);
    const id = state.nextReveal;
    return done({ ...state, pendingReveal: { id, reference: secret.reference }, nextReveal: id + 1 }, [
      { type: "reveal", id, ref },
    ]);
  }
  if (isChar(key, "e")) {
    return done({
      ...state,
      modal: { kind: "input", field: "value", mode: "edit", scope: secret.scope, key: secret.key, text: "", error: null },
    });
  }
  if (isChar(key, "d")) {
    const { files, partial } = referencedBy(state, secret.reference);
    const used =
      files === 0 ? "Referenced by no project file" : `Referenced by ${files} project file${files === 1 ? "" : "s"}`;
    return done({
      ...state,
      modal: {
        kind: "confirm",
        action: "remove",
        ref,
        value: "",
        detail: `${used}${partial ? " that could be read" : ""}.`,
        question: `Delete ${secret.reference}?`,
        defaultYes: false,
        replace: false,
      },
    });
  }
  return null;
}

/**
 * Pasted text, from the terminal's bracketed paste. It goes into an open input
 * as text, newlines and tabs included, so a pasted multi-line secret is stored
 * whole and its newlines can never press Enter. Anywhere else it is ignored.
 */
function onPaste(state: State, text: string): Result {
  if (state.modal?.kind === "input") {
    return done({ ...state, modal: { ...state.modal, text: state.modal.text + text, error: null } });
  }
  if (state.filtering) {
    const list = state.lists[state.screen];
    return done(withList(state, state.screen, { filter: list.filter + text.replace(/[\r\n\t]+/g, " "), cursor: 0, top: 0 }));
  }
  return done(state);
}

function onKey(state: State, key: Key, shown: string | null = null): Result {
  if (key.kind === "ctrl" && key.char === "c") return done({ ...state, quit: true });
  if (state.modal) return onModal(state, state.modal, key);

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

  if (state.screen === "secrets") {
    const action = onSecretsAction(state, key, shown);
    if (action) return action;
  }

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
