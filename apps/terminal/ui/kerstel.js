// The Kerstel panel: install Kerstel, see and manage secrets, and connect sync.
// Reads come from the installed `kerstel` CLI (`--json`). Anything interactive,
// such as setting up a server or pairing a device, is typed into the terminal,
// where the CLI asks its own questions.
(() => {
  "use strict";
  const KT = window.KT;
  const panel = document.getElementById("kpanel");
  const TOO_OLD = "too-old";
  const state = { info: null, secrets: null, sync: null, devices: null, error: null, filter: "", adding: false, confirm: null, shown: new Map() };

  // ---------- tiny DOM helper: text is always set as text, never as HTML ----------
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  }
  const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  function ago(ms) {
    if (!ms) return "never";
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  async function kerstel(args, stdin) {
    return KT.invoke("kerstel_run", { args, stdin: stdin ?? null });
  }
  async function json(args) {
    const out = await kerstel(args);
    if (out.code !== 0) throw new Error((out.stderr || out.stdout).trim() || `kerstel ${args.join(" ")} failed`);
    // A Kerstel from before --json ignores the flag and prints text.
    try { return JSON.parse(out.stdout); } catch { throw new Error(TOO_OLD); }
  }

  // ---------- data ----------
  let loading = null;
  function refresh() {
    if (loading) return loading;
    loading = (async () => {
      try {
        state.info = await KT.invoke("kerstel_info");
        state.error = null;
        if (state.info.path) {
          // One at a time: on a new machine the first command creates the vault key,
          // and two at once would race to create it.
          state.secrets = await json(["ls", "--json"]);
          try { state.sync = await json(["sync", "status", "--json"]); } catch { state.sync = null; }
          state.devices = null;
          if (state.sync?.on) {
            try { state.devices = await json(["sync", "devices", "--json"]); } catch { state.devices = "offline"; }
          }
        }
      } catch (e) {
        state.error = String(e.message || e);
      } finally {
        loading = null;
        render();
      }
    })();
    return loading;
  }

  // ---------- actions ----------
  async function install() {
    try {
      state.info = await KT.invoke("kerstel_install");
      KT.toast(`Installed Kerstel ${state.info.version}. ks works in this terminal now.`, "ok");
    } catch (e) {
      KT.toast(String(e), "bad");
    }
    refresh();
    KT.focusTerminal();
  }
  async function reveal(ref) {
    const out = await kerstel(["get", ref, "--reveal"]);
    if (out.code !== 0) { KT.toast(out.stderr.trim() || "Could not read that secret.", "bad"); return null; }
    return out.stdout.replace(/\n$/, "");
  }
  async function show(ref) {
    const value = await reveal(ref);
    if (value == null) return;
    state.shown.set(ref, value);
    render();
    setTimeout(() => { state.shown.delete(ref); render(); }, 15000);
  }
  async function copy(ref) {
    const value = await reveal(ref);
    if (value == null) return;
    await KT.invoke("clipboard_write", { text: value });
    KT.toast("Copied. The clipboard clears in 30 seconds.", "ok");
    setTimeout(async () => {
      try { if ((await KT.invoke("clipboard_read")) === value) await KT.invoke("clipboard_write", { text: "" }); } catch {}
    }, 30000);
  }
  async function remove(ref) {
    const out = await kerstel(["rm", ref, "--yes"]);
    state.confirm = null;
    KT.toast(out.code === 0 ? `Deleted ${ref}.` : out.stderr.trim() || "Could not delete it.", out.code === 0 ? "ok" : "bad");
    refresh();
  }
  async function save(form) {
    const scope = form.scope.value.trim() || "global";
    const key = form.key.value.trim();
    const value = form.value.value;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) { KT.toast("Use an ENV_STYLE name: capital letters, digits and _.", "bad"); return; }
    if (!value) { KT.toast("Enter a value.", "bad"); return; }
    const out = await kerstel(["set", `${scope}/${key}`], value);
    if (out.code !== 0) { KT.toast((out.stderr || out.stdout).trim(), "bad"); return; }
    KT.toast(`Stored ks:${scope}/${key}.`, "ok");
    state.adding = false;
    refresh();
  }
  const term = (cmd) => KT.runInTerminal(cmd);

  // ---------- views ----------
  function section(title, ...body) {
    return h("section", { class: "ksec" }, h("h3", {}, title), ...body);
  }
  function installView() {
    const i = state.info;
    const tooOld = i.path && i.canInstall;
    return section(
      tooOld ? "Update Kerstel" : "Get started",
      h("p", {}, tooOld
        ? `The installed Kerstel (${i.version}) is older than the one this app includes (${i.bundledVersion}).`
        : "Kerstel keeps your .env secrets in an encrypted vault on this computer. Your .env files hold only references, so they're safe to commit."),
      i.bundledVersion
        ? h("button", { class: "kprimary", onclick: install }, tooOld ? `Update to ${i.bundledVersion}` : "Install Kerstel")
        : h("p", { class: "kmute" }, "This build doesn't include Kerstel. Install it from kerstel.dev."),
      h("p", { class: "kmute" }, `Installs kerstel and ks to ${i.installDir.replace(/^\/(Users|home)\/[^/]+/, "~")}.`),
    );
  }

  function secretsView() {
    const list = state.secrets || [];
    const q = state.filter.toLowerCase();
    const shown = list.filter((s) => !q || s.reference.toLowerCase().includes(q));
    const scopes = [...new Set(list.map((s) => s.scope))];
    const groups = new Map();
    for (const s of shown) groups.set(s.scope, [...(groups.get(s.scope) || []), s]);

    const add = state.adding && h("form", { class: "kadd", onsubmit: (e) => { e.preventDefault(); save(e.target); } },
      h("div", { class: "krow2" },
        h("input", { name: "scope", list: "kscopes", placeholder: "global", value: scopes.includes("global") || !scopes.length ? "global" : scopes[0], "aria-label": "Scope", spellcheck: "false" }),
        h("input", { name: "key", placeholder: "API_KEY", "aria-label": "Name", spellcheck: "false", autocapitalize: "characters",
          oninput: (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"); } }),
      ),
      h("datalist", { id: "kscopes" }, scopes.map((s) => h("option", { value: s }))),
      h("input", { name: "value", type: "password", placeholder: "Value", "aria-label": "Value", autocomplete: "off" }),
      h("div", { class: "kactions" },
        h("button", { class: "kprimary", type: "submit" }, "Save"),
        h("button", { type: "button", onclick: () => { state.adding = false; render(); } }, "Cancel")),
    );

    const rows = [];
    for (const [scope, items] of groups) {
      rows.push(h("div", { class: "kscope" }, scope));
      for (const s of items) {
        const ref = `${s.scope}/${s.key}`;
        if (state.confirm === ref) {
          rows.push(h("div", { class: "kconfirm" },
            h("span", {}, `Delete ${s.reference}? This can't be undone.`),
            h("div", { class: "kactions" },
              h("button", { class: "kdanger", onclick: () => remove(ref) }, "Delete"),
              h("button", { onclick: () => { state.confirm = null; render(); } }, "Cancel"))));
          continue;
        }
        const value = state.shown.get(ref);
        rows.push(h("div", { class: "ksecret" },
          h("div", { class: "kname" },
            h("code", {}, s.key),
            h("span", { class: value != null ? "kvalue" : "kmask" }, value != null ? value : "••••••••")),
          h("div", { class: "kicons" },
            value != null
              ? h("button", { title: "Hide", onclick: () => { state.shown.delete(ref); render(); } }, "Hide")
              : h("button", { title: "Show the value (recorded in ks audit)", onclick: () => show(ref) }, "Show"),
            h("button", { title: "Copy the value (recorded in ks audit)", onclick: () => copy(ref) }, "Copy"),
            h("button", { title: "Delete", class: "kdel", onclick: () => { state.confirm = ref; render(); } }, "✕"))));
      }
    }
    return section(
      `Secrets${list.length ? ` · ${list.length}` : ""}`,
      h("div", { class: "ksearch" },
        h("input", { id: "kfilter", placeholder: "Filter secrets…", value: state.filter, spellcheck: "false",
          oninput: (e) => { state.filter = e.target.value; render(true); } }),
        h("button", { class: "kprimary", onclick: () => { state.adding = !state.adding; render(); if (state.adding) panel.querySelector('[name="key"]')?.focus(); } }, "Add")),
      add,
      list.length === 0 && !state.adding
        ? h("p", { class: "kmute" }, "No secrets yet. Add one here, or run ks init in a project to move its .env values in.")
        : rows,
      list.length > 0 && h("p", { class: "kmute" }, "Showing or copying a value is recorded in ks audit."),
    );
  }

  function syncView() {
    const s = state.sync;
    if (!s) return section("Sync", h("p", { class: "kmute" }, "Couldn't read sync status."));
    if (!s.on) {
      return section("Sync",
        h("p", {}, "Keep this vault the same on your other devices. Values are end-to-end encrypted; the server only ever sees ciphertext."),
        h("div", { class: "kstack" },
          h("button", { class: "kprimary", onclick: () => term("kerstel sync setup") }, "Set up a sync server"),
          h("button", { onclick: () => term("kerstel sync join") }, "Join from another device")),
        h("p", { class: "kmute" }, "Both run in the terminal, where Kerstel asks what it needs. To join, paste the ks1-… line from ks sync add-device on a device that already syncs."));
    }
    const facts = [
      ["Server", h("span", {}, s.pinned ? "🔒 " : "", s.server)],
      ["Last sync", ago(s.lastSync)],
      ["Pending", `${s.pending} change${s.pending === 1 ? "" : "s"}`],
    ];
    if (s.conflicts) facts.push(["Conflicts", h("span", { class: "kwarn" }, `${s.conflicts} open`)]);
    if (s.lastError) facts.push(["Last error", h("span", { class: "kwarn" }, s.lastError)]);
    const devices = Array.isArray(state.devices)
      ? state.devices.map((d) => h("div", { class: "kdevice" },
          h("div", {}, h("div", {}, d.name ?? "Unknown device", d.platform ? h("span", { class: "kmute" }, ` · ${d.platform}`) : null),
            h("div", { class: "kmute" }, d.thisDevice ? "This device" : `Last seen ${ago(d.lastSeen)}`, d.verified ? "" : " · unverified")),
          !d.thisDevice && d.name && h("button", { class: "kdel", title: "Remove this device", onclick: () => term(`kerstel sync remove-device ${quote(d.name)}`) }, "Remove")))
      : [h("p", { class: "kmute" }, "Couldn't reach the server to list devices.")];
    return section("Sync · on",
      h("dl", { class: "kfacts" }, facts.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
      h("div", { class: "kactions" },
        h("button", { onclick: () => term("kerstel sync") }, s.conflicts ? "Settle conflicts" : "Sync now"),
        h("button", { onclick: () => term("kerstel sync add-device") }, "Add a device")),
      h("div", { class: "kscope" }, "Devices"),
      devices);
  }

  function render(keepFocus = false) {
    if (panel.hidden) return;
    const focused = keepFocus && document.activeElement?.id === "kfilter";
    const i = state.info;
    const head = h("div", { class: "khead" },
      h("div", {}, h("strong", {}, "Kerstel"), i?.version ? h("span", { class: "kmute" }, ` ${i.version}`) : null),
      h("div", { class: "kactions" },
        i?.path && h("button", { title: "Check this machine's setup", onclick: () => term("kerstel doctor") }, "Doctor"),
        h("button", { title: "Close", onclick: () => togglePanel(false) }, "✕")));
    const body = [];
    if (!i) body.push(h("p", { class: "kmute kpad" }, "Loading…"));
    else if (state.error === TOO_OLD) body.push(section("Update Kerstel",
      h("p", {}, `The Kerstel installed at ${i.path} (${i.version}) is older than this panel needs.`),
      h("div", { class: "kstack" },
        i.bundledVersion && h("button", { class: "kprimary", onclick: install }, `Use the included Kerstel ${i.bundledVersion}`),
        h("button", { onclick: () => term("kerstel update") }, "Run kerstel update"))));
    else if (state.error) body.push(section("Something went wrong", h("p", { class: "kwarn" }, state.error),
      i.bundledVersion ? h("button", { class: "kprimary", onclick: install }, `Use the included Kerstel ${i.bundledVersion}`) : null));
    else if (!i.path || i.canInstall) body.push(installView());
    if (i?.path && !state.error && state.secrets) body.push(secretsView(), syncView());
    panel.replaceChildren(head, h("div", { class: "kbody" }, body));
    if (focused) { const f = panel.querySelector("#kfilter"); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  }

  function togglePanel(force) {
    const open = force ?? panel.hidden;
    panel.hidden = !open;
    document.getElementById("kbtn").classList.toggle("on", open);
    KT.prefs.panelOpen = open; KT.savePrefs();
    KT.refit();
    if (open) { render(); refresh(); } else KT.focusTerminal();
  }

  KT.togglePanel = togglePanel;
  KT.addSecret = () => { togglePanel(true); state.adding = true; render(); };
  KT.onCommandDone((cmd) => { if (!panel.hidden && /\b(ks|kerstel)\b/.test(cmd)) refresh(); });
  document.getElementById("kbtn").addEventListener("click", () => togglePanel());
  new ResizeObserver(() => KT.refit()).observe(panel);

  // First launch without Kerstel: open the panel on the install card, once.
  (async () => {
    state.info = await KT.invoke("kerstel_info").catch(() => null);
    const firstRun = !KT.prefs.seenKerstel && state.info && !state.info.path;
    KT.prefs.seenKerstel = true; KT.savePrefs();
    if (firstRun || KT.prefs.panelOpen) togglePanel(true);
  })();
})();
