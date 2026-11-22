// Kerstel Terminal UI. xterm.js draws the terminal; the Rust side runs the shell
// in a real PTY. Shell integration (OSC 133 + OSC 7) tells us where each command
// starts and ends, so we can add quiet dividers and an exit status per command.
(() => {
  "use strict";
  const { invoke, Channel } = window.__TAURI__.core;
  const isMac = /Mac/.test(navigator.userAgent);
  if (isMac) document.body.classList.add("mac");
  const $ = (id) => document.getElementById(id);

  // ---------- preferences (per machine, best effort) ----------
  const prefs = (() => {
    try { return JSON.parse(localStorage.getItem("kerstel-terminal") || "{}"); } catch { return {}; }
  })();
  const savePrefs = () => { try { localStorage.setItem("kerstel-terminal", JSON.stringify(prefs)); } catch {} };
  const FONT_DEFAULT = 13.5;

  // ---------- terminal ----------
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, "DejaVu Sans Mono", monospace',
    fontSize: prefs.fontSize || FONT_DEFAULT,
    lineHeight: 1.3,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 2,
    scrollback: 10000,
    macOptionIsMeta: true,
    allowTransparency: true,
    theme: {
      background: "#00000000", foreground: "#ececef", cursor: "#4ade80", cursorAccent: "#202124",
      selectionBackground: "rgba(74, 222, 128, 0.25)",
      black: "#2b2c30", red: "#f87171", green: "#4ade80", yellow: "#fbbf24",
      blue: "#7aa2ff", magenta: "#c084fc", cyan: "#5eead4", white: "#d4d4d8",
      brightBlack: "#6b6b70", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde68a",
      brightBlue: "#a5c0ff", brightMagenta: "#d8b4fe", brightCyan: "#99f6e4", brightWhite: "#ffffff",
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($("term"));

  // ---------- where am I ----------
  let home = "";
  let cwd = "";
  const short = (p) => (home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p);
  async function setCwd(path) {
    cwd = path;
    $("cwd").textContent = short(path);
    const name = short(path).split("/").filter(Boolean).pop() || "/";
    try { await window.__TAURI__.window.getCurrentWindow().setTitle(name); } catch {}
    let branch = null;
    try { branch = await invoke("git_branch", { cwd: path }); } catch {}
    $("branch").hidden = !branch;
    $("branch").textContent = branch || "";
  }

  // ---------- command blocks (shell integration) ----------
  const history = [];
  const commandDoneListeners = [];
  let running = null;   // { marker, cmd, start }
  let lastDivider = -1; // buffer line of the last divider, to avoid doubles

  term.parser.registerOscHandler(7, (data) => {
    // file://host/path. Not parsed with URL(): a "#" or "?" in a folder name would cut the path.
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
    if (!m) return true;
    let path = m[1];
    try { path = decodeURIComponent(path); } catch {}
    setCwd(path);
    return true;
  });

  // OSC 6973;cmd;<base64> is sent by our hooks just before a command runs.
  term.parser.registerOscHandler(6973, (data) => {
    const [kind, b64] = data.split(";");
    if (kind !== "cmd") return true;
    let cmd = "";
    try { cmd = new TextDecoder().decode(Uint8Array.from(atob(b64 || ""), (c) => c.charCodeAt(0))).trim(); } catch {}
    // The command line was just echoed, so it sits one row above the cursor.
    running = { marker: term.registerMarker(-1), cmd, start: performance.now() };
    if (cmd) { const i = history.indexOf(cmd); if (i >= 0) history.splice(i, 1); history.unshift(cmd); history.length = Math.min(history.length, 50); }
    return true;
  });

  term.parser.registerOscHandler(133, (data) => {
    const [kind, arg] = data.split(";");
    if (kind === "A") {
      // A new prompt: draw a hairline above it, but only after a command ran.
      const line = term.buffer.active.baseY + term.buffer.active.cursorY;
      if (history.length && line !== lastDivider && line > 0) {
        lastDivider = line;
        const marker = term.registerMarker(0);
        const deco = marker && term.registerDecoration({ marker, width: term.cols, layer: "bottom" });
        deco?.onRender((el) => { el.classList.add("ks-divider"); el.style.width = "100%"; });
      }
    } else if (kind === "D" && running) {
      showStatus(running, Number(arg ?? 0), performance.now() - running.start);
      const done = running.cmd;
      running = null;
      for (const fn of commandDoneListeners) fn(done);
    }
    return true;
  });

  function fmtDuration(ms) {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60000);
    return `${m}m ${Math.round((ms % 60000) / 1000)}s`;
  }
  function showStatus({ marker }, code, ms) {
    if (!marker || marker.isDisposed) return;
    // Never cover the command itself: drop the duration, then the mark, when the line is long.
    const used = term.buffer.active.getLine(marker.line)?.translateToString(true).length ?? 0;
    const room = term.cols - used - 1;
    const full = 16, short = code === 0 ? 2 : 5;
    if (room < short) return;
    const width = room >= full ? full : short;
    const deco = term.registerDecoration({ marker, anchor: "right", x: 0, width, layer: "top" });
    deco?.onRender((el) => {
      if (el.dataset.done) return;
      el.dataset.done = "1";
      el.className += " ks-status"; // pinned to the right edge in style.css
      const ok = code === 0;
      const mark = `<span class="${ok ? "ok" : "bad"}">${ok ? "✓" : "✕ " + code}</span>`;
      el.innerHTML = width === full ? `<span>${fmtDuration(ms)}</span>${mark}` : mark;
    });
  }

  // ---------- PTY session ----------
  let session = null;
  let exited = false;
  const pendingWrites = [];

  async function spawn() {
    exited = false;
    const onEvent = new Channel();
    onEvent.onmessage = (ev) => {
      if (ev.kind === "data") term.write(ev.data);
      else if (ev.kind === "exit") {
        exited = true;
        session = null;
        term.write(`\r\n\x1b[90m[Process exited${ev.code != null ? " with code " + ev.code : ""}. Press Enter to start a new shell.]\x1b[0m\r\n`);
      }
    };
    session = await invoke("pty_spawn", { cols: term.cols, rows: term.rows, cwd: cwd || null, onEvent });
    while (pendingWrites.length) send(pendingWrites.shift());
  }
  function send(data) {
    if (session == null) { pendingWrites.push(data); return; }
    invoke("pty_write", { id: session, data }).catch(() => {});
  }
  term.onData((data) => {
    if (exited) { if (data === "\r") { term.reset(); history.length = 0; spawn(); } return; }
    send(data);
  });
  term.onResize(({ cols, rows }) => {
    if (session != null) invoke("pty_resize", { id: session, cols, rows }).catch(() => {});
  });
  new ResizeObserver(() => { try { fit.fit(); } catch {} }).observe($("term"));

  // ---------- keyboard shortcuts ----------
  const modLabel = isMac ? "⌘" : "Ctrl⇧";
  document.querySelectorAll("kbd[data-mod]").forEach((k) => (k.textContent = modLabel + k.textContent));
  const hints = $("hints");
  if (prefs.hideHints) hints.classList.add("off");

  function flash(name) {
    const el = hints.querySelector(`[data-hint="${name}"]`);
    if (!el) return;
    el.classList.add("down");
    setTimeout(() => el.classList.remove("down"), 180);
  }
  function zoom(delta) {
    const size = delta === 0 ? FONT_DEFAULT : Math.min(28, Math.max(9, term.options.fontSize + delta));
    term.options.fontSize = size;
    prefs.fontSize = size; savePrefs();
    fit.fit();
    flash("zoom");
  }
  function clearScreen() {
    term.clear();
    lastDivider = -1;
    send("\x0c"); // let the shell redraw its prompt
    flash("clear");
  }
  async function copy() {
    if (!term.hasSelection()) return;
    try { await invoke("clipboard_write", { text: term.getSelection() }); } catch {}
  }
  async function paste() {
    try { const text = await invoke("clipboard_read"); if (text) term.paste(text); } catch {}
  }
  function toggleHints() {
    hints.classList.toggle("off");
    prefs.hideHints = hints.classList.contains("off"); savePrefs();
    fit.fit();
  }

  const isMod = (e) => (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey && !e.metaKey);
  // Returns true when the key belongs to the app, not the shell.
  function appShortcut(e) {
    if (!isMod(e)) return false;
    const k = e.key.toLowerCase();
    if (e.type !== "keydown") return ["k", "l", "j", "c", "v", "=", "+", "-", "_", "0", ")", "/", "?"].includes(k);
    switch (k) {
      case "k": openPalette(); break;
      case "j": flash("kerstel"); window.KT.togglePanel?.(); break;
      case "l": clearScreen(); break;
      case "c": if (isMac) return false; copy(); break;   // macOS uses the native copy event
      case "v": if (isMac) return false; paste(); break;  // macOS uses the native paste event
      case "=": case "+": zoom(1); break;
      case "-": case "_": zoom(-1); break;
      case "0": case ")": zoom(0); break;
      case "/": case "?": toggleHints(); break;
      default: return false;
    }
    e.preventDefault();
    return true;
  }
  term.attachCustomKeyEventHandler((e) => {
    if (appShortcut(e)) return false;
    if (e.type === "keydown" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "ArrowUp") flash("up");
      if (e.key === "Tab") flash("tab");
    }
    return true;
  });

  // ---------- command palette ----------
  const pal = $("pal"), palIn = $("palIn"), palList = $("palList");
  const ACTIONS = [
    { label: "Kerstel panel", key: "J", run: () => window.KT.togglePanel?.() },
    { label: "Kerstel: add a secret", key: "", run: () => window.KT.addSecret?.() },
    { label: "Clear screen", key: "L", run: clearScreen },
    { label: "Bigger text", key: "+", run: () => zoom(1) },
    { label: "Smaller text", key: "−", run: () => zoom(-1) },
    { label: "Reset text size", key: "0", run: () => zoom(0) },
    { label: "Show or hide key hints", key: "/", run: toggleHints },
  ];
  const COMMON = [
    ["List files", "ls -la"], ["Git status", "git status"], ["Git log", "git log --oneline -20"],
    ["Kerstel: list secrets", "ks ls"], ["Kerstel: check setup", "ks doctor"], ["Kerstel: open vault UI", "ks ui"],
  ];
  let items = [], sel = 0;

  function paletteItems(q) {
    q = q.trim().toLowerCase();
    const match = (s) => !q || s.toLowerCase().includes(q);
    const groups = [];
    const recent = history.filter(match).slice(0, 6).map((c) => ({ label: c, code: "", insert: c }));
    if (recent.length) groups.push(["Recent", recent]);
    const common = COMMON.filter(([l, c]) => match(l + " " + c)).map(([l, c]) => ({ label: l, code: c, insert: c }));
    if (common.length) groups.push(["Commands", common]);
    const acts = ACTIONS.filter((a) => match(a.label)).map((a) => ({ label: a.label, code: a.key ? modLabel + a.key : "", run: a.run }));
    if (acts.length) groups.push(["Window", acts]);
    return groups;
  }
  function renderPalette() {
    const groups = paletteItems(palIn.value);
    items = groups.flatMap(([, list]) => list);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    palList.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "palempty";
      empty.textContent = "Nothing matches. Press Enter to type it as a command.";
      palList.append(empty);
      return;
    }
    let i = 0;
    for (const [title, list] of groups) {
      const g = document.createElement("div");
      g.className = "palgroup"; g.textContent = title;
      palList.append(g);
      for (const it of list) {
        const row = document.createElement("div");
        const idx = i++;
        row.className = "palitem" + (idx === sel ? " on" : "");
        const label = document.createElement("span"); label.textContent = it.label;
        const code = document.createElement("code"); code.textContent = it.code;
        row.append(label, code);
        row.onmouseenter = () => { sel = idx; markSelected(); };
        row.onclick = () => choose(idx);
        palList.append(row);
      }
    }
  }
  function markSelected() {
    palList.querySelectorAll(".palitem").forEach((r, i) => r.classList.toggle("on", i === sel));
    palList.querySelectorAll(".palitem")[sel]?.scrollIntoView({ block: "nearest" });
  }
  function openPalette() {
    flash("palette");
    pal.hidden = false; palIn.value = ""; sel = 0;
    renderPalette(); palIn.focus();
  }
  function closePalette() { pal.hidden = true; term.focus(); }
  function choose(i) {
    const it = items[i];
    const typed = palIn.value.trim();
    closePalette();
    if (!it) { if (typed) term.paste(typed); return; }
    if (it.run) it.run();
    else term.paste(it.insert); // inserted at the prompt, never run: you press Enter
  }
  palIn.addEventListener("input", () => { sel = 0; renderPalette(); });
  palIn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); markSelected(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + items.length) % Math.max(1, items.length); markSelected(); }
    else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
    else if (e.key === "Escape" || (isMod(e) && e.key.toLowerCase() === "k")) { e.preventDefault(); closePalette(); }
  });
  pal.addEventListener("mousedown", (e) => { if (e.target === pal) closePalette(); });

  // ---------- shared with kerstel.js ----------
  let toastTimer = 0;
  function toast(text, kind = "") {
    const el = $("toast");
    el.textContent = text;
    el.className = "toast " + kind;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }
  /** Types a command at the prompt and runs it, so the person sees its output and answers its prompts. */
  function runInTerminal(command) {
    if (exited || session == null) { toast("Start a shell first: press Enter in the terminal."); return false; }
    if (running) { toast("Finish the running command first."); return false; }
    send("\x15" + command + "\r"); // Ctrl+U clears anything half-typed
    term.focus();
    return true;
  }
  window.KT = {
    invoke, toast, runInTerminal, prefs, savePrefs, isMod, modLabel,
    onCommandDone: (fn) => commandDoneListeners.push(fn),
    refit: () => { try { fit.fit(); } catch {} },
    focusTerminal: () => term.focus(),
  };

  // ---------- start ----------
  (async () => {
    try { home = await invoke("home_dir"); } catch {}
    await setCwd(home || "/");
    fit.fit();
    await spawn();
    term.focus();
  })();
})();
