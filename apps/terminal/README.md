# Kerstel Terminal

A calm, minimal terminal for macOS and Linux. It is a real terminal: your own shell runs in a
pseudo-terminal, so `vim`, `htop`, `ssh`, prompts and colors all work as usual. On top of that it
adds a few quiet helpers:

- **Where you are**: the current folder and git branch sit at the top of the window.
- **Command blocks**: a hairline separates each command, and every command shows its duration
  and a ✓ or ✕ with the exit code at the right.
- **Key hints**: a row of shortcuts at the bottom that lights up as you use them.
  Hide it with ⌘/ (Ctrl+Shift+/ on Linux).
- **Command palette** (⌘K, or Ctrl+Shift+K on Linux): your recent commands, common commands
  and window actions. Choosing a command types it at the prompt; it runs only when you press Enter.
- **Kerstel built in** (⌘J, or Ctrl+Shift+J on Linux, or the ◆ Kerstel button): the app ships the
  `kerstel` CLI. On first launch it offers to install `kerstel` and `ks` to `~/.local/bin` (or
  `KERSTEL_INSTALL_DIR`), the same place `install.sh` uses, so they work in every terminal. The
  panel lists, adds and deletes secrets, shows or copies a value (recorded in `ks audit`), shows
  sync status and devices, and starts `sync setup`, `sync join`, `sync add-device` and
  `sync remove-device` in the terminal, where Kerstel asks its usual questions.

| Action          | macOS | Linux            |
| --------------- | ----- | ---------------- |
| Command palette | ⌘K    | Ctrl+Shift+K     |
| Clear           | ⌘L    | Ctrl+Shift+L     |
| Kerstel panel   | ⌘J    | Ctrl+Shift+J     |
| Copy / Paste    | ⌘C / ⌘V | Ctrl+Shift+C / V |
| Text size       | ⌘+ ⌘− ⌘0 | Ctrl+Shift+ + − 0 |
| Hide key hints  | ⌘/    | Ctrl+Shift+/     |

Dividers and exit status need shell integration, which Kerstel Terminal loads automatically for
**zsh** and **bash** without changing your dotfiles. Other shells work as a plain terminal.

## How it works

- `src-tauri/` is the Rust app ([Tauri 2](https://tauri.app)). `src/pty.rs` runs your login shell
  in a PTY with `portable-pty` and streams its output to the window.
- `src-tauri/shell/` holds the zsh and bash hooks. They emit standard OSC 133 prompt and command
  marks, OSC 7 for the current folder, and OSC 6973 with the command text.
- `src-tauri/src/kerstel.rs` finds, installs and runs Kerstel. The panel runs the *installed*
  `kerstel` with `--json`, and only an allowlisted set of commands; secrets reach `kerstel set`
  on stdin, never in arguments.
- `ui/` is the window: [xterm.js](https://xtermjs.org) for the terminal, `app.js` for the top
  bar, blocks, hints and palette, and `kerstel.js` for the panel. `bun run vendor` copies xterm.js
  into `ui/vendor/`, and `bun run sidecar` compiles the CLI into `src-tauri/binaries/`. Both run
  on their own before `cargo tauri dev` and `cargo tauri build`.

## Build and run

```bash
# Once: Rust and the Tauri CLI
curl https://sh.rustup.rs -sSf | sh
cargo install tauri-cli --version "^2" --locked
# Linux only: the system webview and build tools
sudo apt install libwebkit2gtk-4.1-dev build-essential libssl-dev libxdo-dev \
  libayatana-appindicator3-dev librsvg2-dev

bun install                          # from the repo root
cd apps/terminal
bun run dev                          # run it
bun run build                        # .app and .dmg on macOS, .deb and .AppImage on Linux
```

`cd src-tauri && cargo test` runs the Rust tests. A plain `cargo build` needs `bun run prepare-app`
once first, so the bundled CLI exists.
