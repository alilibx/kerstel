import { expect, test } from "bun:test";
import { uiCommand } from "../src/commands/ui";
import type { ProjectRefs } from "../src/project-refs";
import { initialState, rowsFor, update, type Event, type State } from "../src/tui/app";
import { sortSecrets, type AuditView, type SecretRow, type UiData } from "../src/tui/data";
import { auditRows } from "../src/tui/screens/audit";
import { ROTATE_HINT } from "../src/audit/report";
import type { AuditRow } from "../src/vault/store";
import { centre, columnWidths, fit, scrollTop } from "../src/tui/frame";
import { KeyParser, type Key } from "../src/tui/keys";
import { MIN_HEIGHT, MIN_WIDTH, render } from "../src/tui/render";
import { frameText, runUi } from "../src/tui/run";
import type { Terminal } from "../src/tui/terminal";
import { makeTheme } from "../src/ui/theme";

/** Terminal UI spec §6: keys, renderers, reducer and terminal, with no PTY. */

const plain = makeTheme({ isTTY: false, noColor: true, truecolor: false });

// --- keys -------------------------------------------------------------------

test("every key the UI uses parses, in one chunk", () => {
  const keys = new KeyParser().feed("a/\r\t\x1b[Z\x7f\x1b[A\x1b[B\x1b[C\x1b[D\x1bOA\x1b[H\x1b[F\x1b[1~\x1b[4~\x1b[5~\x1b[6~\x03\x1b");
  expect(keys).toEqual([
    { kind: "char", char: "a" },
    { kind: "char", char: "/" },
    { kind: "named", name: "enter" },
    { kind: "named", name: "tab" },
    { kind: "named", name: "backtab" },
    { kind: "named", name: "backspace" },
    { kind: "named", name: "up" },
    { kind: "named", name: "down" },
    { kind: "named", name: "right" },
    { kind: "named", name: "left" },
    { kind: "named", name: "up" },
    { kind: "named", name: "home" },
    { kind: "named", name: "end" },
    { kind: "named", name: "home" },
    { kind: "named", name: "end" },
    { kind: "named", name: "pageup" },
    { kind: "named", name: "pagedown" },
    { kind: "ctrl", char: "c" },
    { kind: "named", name: "esc" },
  ]);
});

test("a sequence split across reads is one key, and an unknown one is dropped", () => {
  const parser = new KeyParser();
  expect(parser.feed("j\x1b[")).toEqual([{ kind: "char", char: "j" }]);
  expect(parser.feed("Bk")).toEqual([{ kind: "named", name: "down" }, { kind: "char", char: "k" }]);
  expect(parser.feed("\x1b[99;5Xq\x1bxz")).toEqual([{ kind: "char", char: "q" }, { kind: "char", char: "z" }]);
  expect(parser.feed("日😀")).toEqual([{ kind: "char", char: "日" }, { kind: "char", char: "😀" }]);
});

// --- frame ------------------------------------------------------------------

test("fit pads and cuts by display width, wide characters included", () => {
  expect(fit("abc", 5)).toBe("abc  ");
  expect(fit("abcdef", 4)).toBe("abc…");
  expect(Bun.stringWidth(fit("ks:web/日本語の鍵", 10))).toBe(10);
  expect(fit("日本語", 4)).toBe("日… ");
  expect(centre("ab", 6)).toBe("  ab  ");
  expect(columnWidths([["a", "bb", "c"], ["aaa", "b", "cc"]], 20)).toEqual([3, 2, 11]);
  expect(scrollTop(10, 0, 5, 20)).toBe(6);
  expect(scrollTop(2, 6, 5, 20)).toBe(2);
});

// --- fixtures ---------------------------------------------------------------

const secrets: SecretRow[] = sortSecrets([
  { scope: "web", key: "DATABASE_URL", reference: "ks:web/DATABASE_URL", updatedAt: 0 },
  { scope: "global", key: "STRIPE_SECRET_KEY", reference: "ks:global/STRIPE_SECRET_KEY", updatedAt: 0 },
  { scope: "api", key: "TOKEN", reference: "ks:api/TOKEN", updatedAt: 0 },
  { scope: "global", key: "OPENAI_API_KEY", reference: "ks:global/OPENAI_API_KEY", updatedAt: 0 },
]);

const ref = (scope: string, key: string, inVault = true) => ({
  index: 0,
  key,
  ref: { scope, key },
  reference: `ks:${scope}/${key}`,
  inVault,
});

const refs: ProjectRefs = {
  checkouts: [
    {
      scope: "web",
      rootPath: "/src/web",
      files: [
        { path: "/src/web/.env", name: ".env", original: "", references: [ref("web", "DATABASE_URL"), ref("global", "STRIPE_SECRET_KEY")] },
        { path: "/src/web/.env.local", name: ".env.local", original: "", references: [ref("web", "SESSION_SECRET", false)] },
      ],
    },
  ],
  unreachable: [{ scope: "legacy", rootPath: "/src/legacy", reason: "the folder no longer exists" }],
  unreadable: [],
  unresolvable: [{ scope: "web", rootPath: "/src/web", file: "/src/web/.env.local", reference: "ks:web/SESSION_SECRET" }],
  unused: ["ks:api/TOKEN", "ks:global/OPENAI_API_KEY"],
};

const char = (c: string): Event => ({ type: "key", key: { kind: "char", char: c } });
const named = (name: Extract<Key, { kind: "named" }>["name"]): Event => ({ type: "key", key: { kind: "named", name } });

function loaded(width = 80, height = 20): State {
  return update(initialState(width, height), { type: "loaded", secrets, refs }).state;
}

function press(state: State, ...events: Event[]): State {
  return events.reduce((s, e) => update(s, e).state, state);
}

// --- reducer ----------------------------------------------------------------

test("secrets are listed global first, then by scope, and the cursor stays in range", () => {
  let s = loaded();
  expect(rowsFor(s).map((r) => r.reference)).toEqual([
    "ks:global/OPENAI_API_KEY",
    "ks:global/STRIPE_SECRET_KEY",
    "ks:api/TOKEN",
    "ks:web/DATABASE_URL",
  ]);
  s = press(s, char("j"), named("down"), char("j"), char("j"), char("j"));
  expect(s.lists.secrets.cursor).toBe(3);
  s = press(s, char("k"), char("g"));
  expect(s.lists.secrets.cursor).toBe(0);
  s = press(s, char("G"));
  expect(s.lists.secrets.cursor).toBe(3);
  s = press(s, named("pageup"));
  expect(s.lists.secrets.cursor).toBe(0);
});

test("/ filters as you type, Enter keeps it, Esc clears it", () => {
  let s = press(loaded(), char("/"), char("g"), char("l"), char("o"));
  expect(s.filtering).toBe(true);
  expect(rowsFor(s).map((r) => r.reference)).toEqual(["ks:global/OPENAI_API_KEY", "ks:global/STRIPE_SECRET_KEY"]);
  // q goes to the filter while it is open, rather than quitting.
  s = press(s, char("q"));
  expect(s.quit).toBe(false);
  s = press(s, named("backspace"), named("enter"));
  expect(s.filtering).toBe(false);
  expect(s.lists.secrets.filter).toBe("glo");
  s = press(s, named("esc"));
  expect(s.lists.secrets.filter).toBe("");
  s = press(s, char("/"), char("x"), named("esc"));
  expect(s.filtering).toBe(false);
  expect(s.lists.secrets.filter).toBe("");
});

test("Tab, Shift-Tab and 1 2 switch screens, each keeping its own cursor", () => {
  let s = press(loaded(), char("j"));
  s = press(s, named("tab"));
  expect(s.screen).toBe("references");
  s = press(s, char("j"), char("j"), named("backtab"));
  expect(s.screen).toBe("secrets");
  expect(s.lists.secrets.cursor).toBe(1);
  expect(press(s, char("2")).lists.references.cursor).toBe(2);
  expect(press(s, char("2"), char("1")).screen).toBe("secrets");
});

test("References: b toggles by key, R asks for a rescan, Enter jumps to the secret", () => {
  let s = press(loaded(), char("2"));
  expect(rowsFor(s)[0]!.cells[0]).toBe("web");
  s = press(s, char("j"), char("j"));
  // Row 2 is ks:global/STRIPE_SECRET_KEY in web's .env.
  expect(rowsFor(s)[2]!.reference).toBe("ks:global/STRIPE_SECRET_KEY");
  s = press(s, named("enter"));
  expect(s.screen).toBe("secrets");
  expect(rowsFor(s)[s.lists.secrets.cursor]!.reference).toBe("ks:global/STRIPE_SECRET_KEY");

  s = press(s, char("2"), char("b"));
  expect(s.byKey).toBe(true);
  expect(rowsFor(s)[0]!.cells[0]).toBe("ks:global/STRIPE_SECRET_KEY");
  const rescan = update(s, char("R"));
  expect(rescan.effects).toEqual([{ type: "reload" }]);
  expect(rescan.state.loading).toBe(true);
  // A reference the vault lacks has no row to jump to.
  const missing = press(loaded(), char("2"), char("j"), char("j"), char("j"));
  expect(rowsFor(missing)[3]!.reference).toBeUndefined();
  expect(press(missing, named("enter")).screen).toBe("references");
});

test("? shows the keys until the next key; q and Ctrl-C quit; an error shows until the next key", () => {
  let s = press(loaded(), char("?"));
  expect(s.help).toBe(true);
  s = press(s, char("j"));
  expect(s.help).toBe(false);
  expect(press(loaded(), char("q")).quit).toBe(true);
  expect(press(loaded(), { type: "key", key: { kind: "ctrl", char: "c" } }).quit).toBe(true);
  s = press(loaded(), { type: "error", message: "database is locked" });
  expect(s.status).toEqual({ text: "database is locked", tone: "problem" });
  expect(press(s, char("j")).status).toBeNull();
});

// --- renderer ---------------------------------------------------------------

test("every frame line is the terminal's width, and the mask never shows a length", () => {
  const s = loaded(64, 16);
  const frame = render(s, plain);
  expect(frame).toHaveLength(16);
  for (const line of frame) expect(Bun.stringWidth(line)).toBe(64);
  expect(frame[0]).toMatch(/^ 1 Secrets {3}2 References {3}3 Audit +kerstel ui$/);
  expect(frame[1]).toMatch(/^ {2}Reference +Value +Updated/);
  expect(frame[2]).toMatch(/^› ks:global\/OPENAI_API_KEY +•{12} /);
  expect(frame[15]).toMatch(/^r reveal {2}a add {2}e edit {2}d delete {2}\/ filter {2}\? keys {2}q quit/);
});

test("the References screen draws the tree, with unresolvable, unreachable and unused rows", () => {
  const frame = render(press(loaded(110, 20), char("2")), plain).join("\n");
  expect(frame).toMatch(/› web {2}\/src\/web/);
  expect(frame).toMatch(/\.env\.local +ks:web\/SESSION_SECRET +✗ not in the vault/);
  expect(frame).toContain("Unreachable");
  expect(frame).toMatch(/legacy +\/src\/legacy +the folder no longer exists/);
  expect(frame).toContain("Referenced by no project that could be read");
});

test("a terminal under 60x16 shows one centred line until it grows", () => {
  let s = update(loaded(), { type: "resize", width: MIN_WIDTH - 1, height: 20 }).state;
  expect(render(s, plain).filter((l) => l.trim() !== "")).toEqual([centre("Terminal too small (60×16 minimum)", 59)]);
  s = update(s, { type: "resize", width: 80, height: MIN_HEIGHT }).state;
  expect(render(s, plain)[0]).toContain("Secrets");
});

test("a filter that matches nothing, and an empty vault, say so", () => {
  expect(render(press(loaded(), char("/"), char("z"), char("z")), plain).join("\n")).toContain('Nothing matches "zz".');
  const nothing: Event = { type: "loaded", secrets: [], refs: { ...refs, checkouts: [], unreachable: [], unused: [], unresolvable: [] } };
  const empty = update(initialState(80, 20), nothing).state;
  expect(render(empty, plain).join("\n")).toContain("No secrets yet.");
  // Entering References rescans; once that lands, the empty state shows.
  expect(render(press(empty, char("2"), nothing), plain).join("\n")).toContain("No project is set up yet.");
});

// --- terminal loop ----------------------------------------------------------

class FakeTerminal implements Terminal {
  width = 80;
  height = 20;
  written: string[] = [];
  started = 0;
  restored = 0;
  private data: ((chunk: string) => void)[] = [];
  private resize: (() => void)[] = [];
  start() {
    this.started += 1;
  }
  write(text: string) {
    this.written.push(text);
  }
  onData(listener: (chunk: string) => void) {
    this.data.push(listener);
  }
  onResize(listener: () => void) {
    this.resize.push(listener);
  }
  restore() {
    this.restored += 1;
  }
  send(chunk: string) {
    for (const l of this.data) l(chunk);
  }
  resized(width: number, height: number) {
    this.width = width;
    this.height = height;
    for (const l of this.resize) l();
  }
}

const unused = {
  reveal: () => null,
  store: () => true,
  remove: () => false,
  audit: () => ({ counts: { reveals: 0, appReads: 0, processes: 0, projects: 0, changes: 0 }, entries: [], more: false }),
};
const data: UiData = { load: () => ({ secrets, refs }), ...unused };
const tick = () => new Promise((r) => setTimeout(r, 5));

test("the loop draws after loading, redraws on keys and resizes, and restores on quit", async () => {
  const term = new FakeTerminal();
  const done = runUi(term, data, plain);
  expect(term.written[0]).toContain("Loading…");
  await tick();
  expect(term.written.at(-1)).toContain("ks:global/OPENAI_API_KEY");
  term.send("j");
  term.resized(70, 18);
  expect(term.written.at(-1)).toBe(frameText(render({ ...loaded(70, 18), lists: { ...loaded(70, 18).lists, secrets: { cursor: 1, top: 0, filter: "" } } }, plain)));
  term.send("q");
  await done;
  expect(term.started).toBe(1);
  expect(term.restored).toBe(1);
});

test("Ctrl-C quits and restores the terminal", async () => {
  const term = new FakeTerminal();
  const done = runUi(term, data, plain);
  await tick();
  term.send("\x03");
  await done;
  expect(term.restored).toBe(1);
});

test("a thrown error restores the terminal, then rethrows", async () => {
  const term = new FakeTerminal();
  const broken: UiData = {
    load: () => ({ secrets, refs: { ...refs, checkouts: null as unknown as ProjectRefs["checkouts"] } }),
    ...unused,
  };
  // Loading builds every screen's rows, which reads refs.checkouts and throws.
  const outcome = runUi(term, broken, plain).then(
    () => null,
    (error: unknown) => error,
  );
  await tick();
  expect(await outcome).toBeInstanceOf(TypeError);
  expect(term.restored).toBe(1);
});

test("a failed load shows the store's message in the status bar and keeps running", async () => {
  const term = new FakeTerminal();
  const done = runUi(term, { load: () => { throw new Error("database is locked"); }, ...unused }, plain);
  await tick();
  expect(term.written.at(-1)).toContain("database is locked");
  term.send("q");
  await done;
  expect(term.restored).toBe(1);
});

test("kerstel ui refuses without an interactive terminal, and takes no arguments", async () => {
  const log = console.log;
  const printed: string[] = [];
  console.log = (...args: unknown[]) => printed.push(args.join(" "));
  try {
    expect(await uiCommand([], { interactive: false })).toBe(2);
    expect(await uiCommand(["--x"], { interactive: true })).toBe(2);
  } finally {
    console.log = log;
  }
  expect(printed.join("\n")).toContain("ui needs an interactive terminal. Use kerstel ls and kerstel refs in a pipe.");
});

test("control characters in a file name never reach the terminal", () => {
  expect(fit("a\x1b[2Jb\u202e", 8)).toBe("a[2Jb   ");
  const hostile: ProjectRefs = {
    ...refs,
    checkouts: [
      {
        scope: "web",
        rootPath: "/src/\x1b]0;owned\x07web",
        files: [{ path: "/src/web/.env.\x1b[2J", name: ".env.\x1b[?1049l", original: "", references: [ref("web", "DATABASE_URL")] }],
      },
    ],
  };
  const s = press(update(initialState(100, 20), { type: "loaded", secrets, refs: hostile }).state, char("2"));
  const text = frameText(render(update(s, { type: "loaded", secrets, refs: hostile }).state, plain));
  // The only escapes are the frame's own: cursor home, clear to end of line, clear below.
  expect(text.replace(/\x1b\[(H|K|J)/g, "")).not.toContain("\x1b");
  expect(text).not.toContain("\x07");
});

test("a long reference shrinks to leave the mask and the time on the row", () => {
  const long = "ks:a-very-long-project-scope-name/" + "A_VERY_LONG_KEY_NAME_".repeat(3);
  const s = update(initialState(60, 16), {
    type: "loaded",
    secrets: [{ scope: "x", key: "K", reference: long, updatedAt: Date.UTC(2026, 10, 9, 12) }],
    refs,
  }).state;
  const row = render(s, plain)[2]!;
  expect(Bun.stringWidth(row)).toBe(60);
  expect(row).toContain("•".repeat(12));
  expect(row).toMatch(/20\d\d-\d\d-\d\d \d\d:\d\d/);
  expect(row).toContain("…");
  const widths = columnWidths([[long, "x".repeat(12), "y".repeat(16)]], 58);
  expect(widths[0]! + widths[1]! + widths[2]! + 4).toBe(58);
});

test("entering References scans again; leaving it does not", () => {
  const into = update(loaded(), char("2"));
  expect(into.effects).toEqual([{ type: "reload" }]);
  expect(into.state.loading).toBe(true);
  expect(update(loaded(), named("tab")).effects).toEqual([{ type: "reload" }]);
  const back = update(press(loaded(), char("2"), { type: "loaded", secrets, refs }), char("1"));
  expect(back.effects).toEqual([]);
  // Pressing the key for the screen you are on is not a new entry.
  expect(update(press(loaded(), char("2"), { type: "loaded", secrets, refs }), char("2")).effects).toEqual([]);
});

test("a reveal cancelled in the same read never decrypts, so it writes no audit row", async () => {
  const term = new FakeTerminal();
  let reveals = 0;
  const done = runUi(term, { ...data, reveal: () => ((reveals += 1), "sk-never-shown") }, plain);
  await tick();
  term.send("rj");
  await tick();
  expect(reveals).toBe(0);
  term.send("r");
  await tick();
  expect(reveals).toBe(1);
  term.send("q");
  await done;
});

// --- Audit screen -------------------------------------------------------------

const auditRow = (over: Partial<AuditRow> & Pick<AuditRow, "id" | "event">): AuditRow => ({
  ts: new Date(2026, 10, 12, 9, 30).getTime(),
  scope: "web",
  key: "DATABASE_URL",
  pid: 10,
  processName: "node",
  chain: ["node", "zsh"],
  project: null,
  ...over,
});

const counts = { reveals: 3, appReads: 412, processes: 37, projects: 4, changes: 5 };

function auditView(over: Partial<AuditView> = {}): AuditView {
  return {
    counts,
    entries: [
      { row: auditRow({ id: 4, event: "reveal", scope: "global", key: "STRIPE_SECRET_KEY" }), rotate: true },
      { row: auditRow({ id: 3, event: "resolve" }), rotate: false },
      { row: auditRow({ id: 2, event: "reveal", scope: "web", key: "GONE_KEY", chain: null }), rotate: false },
      { row: auditRow({ id: 1, event: "device", scope: "", key: "", chain: [] }), rotate: false },
    ],
    more: false,
    ...over,
  };
}

const withAudit = (view: AuditView = auditView()): State => update(press(loaded(), char("3")), { type: "auditLoaded", view }).state;

test("entering Audit loads it, with Tab or 3", () => {
  const entered = update(loaded(), char("3"));
  expect(entered.state.screen).toBe("audit");
  expect(entered.state.loading).toBe(true);
  expect(entered.effects).toEqual([{ type: "audit", action: null, limit: 200 }]);
  expect(update(press(loaded(), named("tab")), named("tab")).effects).toEqual([{ type: "audit", action: null, limit: 200 }]);
  const s = update(entered.state, { type: "auditLoaded", view: auditView() }).state;
  expect(s.loading).toBe(false);
  expect(rowsFor(s)).toHaveLength(auditRows(auditView(), null).length);
});

test("a cycles the action and reloads with 200", () => {
  let s = withAudit(auditView({ more: true }));
  s = press(s, char("n")); // limit 400
  const seen: (string | null)[] = [];
  for (let i = 0; i < 8; i += 1) {
    const r = update(s, char("a"));
    s = r.state;
    seen.push(s.auditAction);
    expect(r.effects).toEqual([{ type: "audit", action: s.auditAction, limit: 200 }]);
    expect(s.auditLimit).toBe(200);
  }
  expect(seen).toEqual(["resolve", "run", "reveal", "set", "remove", "sync", "device", null]);
});

test("n loads 200 more only while there are more", () => {
  const none = update(withAudit(), char("n"));
  expect(none.effects).toEqual([]);
  const more = update(withAudit(auditView({ more: true })), char("n"));
  expect(more.effects).toEqual([{ type: "audit", action: null, limit: 400 }]);
  expect(more.state.auditLimit).toBe(400);
});

test("Enter on an audit row jumps to its secret; a removed secret's row does nothing", () => {
  let s = withAudit();
  // Rows: heading, reveal STRIPE, hint, resolve web/DATABASE_URL, reveal GONE_KEY, device.
  s = press(s, char("j"));
  s = press(s, named("enter"));
  expect(s.screen).toBe("secrets");
  expect(rowsFor(s)[s.lists.secrets.cursor]!.reference).toBe("ks:global/STRIPE_SECRET_KEY");
  const gone = press(withAudit(), char("j"), char("j"), char("j"), char("j"));
  expect(rowsFor(gone)[gone.lists.audit.cursor]!.reference).toBe("ks:web/GONE_KEY");
  expect(press(gone, named("enter")).screen).toBe("audit");
  const keyless = press(gone, char("j"));
  expect(press(keyless, named("enter")).screen).toBe("audit");
});

test("auditRows: the summary, reveal tone, the rotate hint, unknown chains and keyless rows", () => {
  const rows = auditRows(auditView({ more: true }), null);
  expect(rows[0]).toEqual({
    cells: ["Last 7 days: 3 reveals · 412 app reads by 37 processes in 4 projects · 5 changes"],
    tone: "heading",
  });
  expect(rows[1]!.tone).toBe("problem");
  expect(rows[1]!.cells.slice(1)).toEqual(["reveal", "ks:global/STRIPE_SECRET_KEY", "node ← zsh"]);
  expect(rows[2]).toEqual({ cells: ["", "", ROTATE_HINT, ""], tone: "dim", reference: "ks:global/STRIPE_SECRET_KEY" });
  expect(rows[3]!.tone).toBe("normal");
  expect(rows[4]!.cells[3]).toBe("unknown");
  expect(rows[5]!.cells.slice(1)).toEqual(["device", "—", "unknown"]);
  expect(rows[5]!.reference).toBeUndefined();
  expect(rows[6]).toEqual({ cells: ["n for 200 more"], tone: "dim" });
  expect(auditRows(auditView(), "reveal")[0]!.cells[0]).toEndWith("5 changes (showing reveal)");
});

test("auditRows: the filter keeps a rotate hint with its reveal and never matches it alone", () => {
  const has = (needle: string) => (row: { cells: string[] }) => row.cells.some((c) => c.toLowerCase().includes(needle));
  const stripe = auditRows(auditView(), null, has("stripe"));
  expect(stripe.map((r) => r.cells[2])).toEqual(["ks:global/STRIPE_SECRET_KEY", ROTATE_HINT]);
  expect(auditRows(auditView(), null, has("rotat"))).toEqual([]);
});

test("the Audit screen shows its tab and a keys bar that fits 60 columns", () => {
  const s = update(initialState(60, 16), { type: "loaded", secrets, refs }).state;
  const audit = update(update(s, char("3")).state, { type: "auditLoaded", view: auditView() }).state;
  const frame = render(audit, plain);
  expect(frame[0]).toContain("3 Audit");
  expect(frame.every((l) => Bun.stringWidth(l) === 60)).toBe(true);
  expect(frame[frame.length - 1]).toContain("Enter to secret  a action  n more  / filter  ? keys  q quit");
  expect(frame[2]).toContain("Last 7 days");
});
