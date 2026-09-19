# Changelog

All notable changes to Kerstel are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.2 (unreleased)

### Security

- The daemon's session token no longer travels in any environment. `kerstel exec` now gives a wired script `KERSTEL_TOKEN_FILE`, the path of the `0600` token file, instead of `KERSTEL_TOKEN`, and the runtime hook reads the file when it needs it. Before, the token sat in every hooked process's environment and every child's, where `console.log(process.env)`, a crash reporter, or `ps -E` could show it, and it was never rotated. The daemon now mints a fresh token every time it starts and deletes it when it stops, so no valid token exists while nothing is listening. A running app keeps working across a daemon restart.
- The resolver daemon now starts with a minimal environment of its own (`PATH`, `HOME`, locale, the Linux session bus, and Kerstel's `KERSTEL_*` settings) instead of inheriting the caller's, and a `kerstel daemon serve` run by hand re-executes itself through the same list before opening the vault. Before, `BUN_OPTIONS` set in your shell could run a preload inside the process that holds the vault key, and under a nested `kerstel exec` the daemon inherited every already-resolved secret in its environment. `kerstel doctor` now warns when `BUN_OPTIONS` is set.
- `kerstel init` and `kerstel exec` refuse, and `kerstel doctor` reports a problem, when `node_modules/.bin` in the project or any parent directory holds a `kerstel` or `ks`. npm and bun put that directory first on `PATH` when they run a script, so a dependency declaring such a `bin` would run in place of Kerstel for every wired script, with access to the vault. The message names the file and how to find the dependency that installs it.
- The OS credential-store helpers (`security` on macOS, `secret-tool` on Linux) are now run only from a fixed list of system directories, and only when the directory and the file are owned by root and writable by nobody else, never from the caller's `PATH`. `npm run` and `bun run` put `node_modules/.bin` first on `PATH`, so before this a dependency could ship a fake `security` and read the vault's data key the next time a wired script opened the vault. If the tool is missing from those directories, the error says how to install it there or switch to the key file.

### Fixed

- `kerstel init` no longer mistakes key material for a variable name. An unquoted multi-line PEM block is left untouched as one value and named by its key; a base64 line, or a name too long to be a variable, is reported by line number and never printed; and every other line that is not `KEY=value` now counts as plaintext remaining. Before, the last line of a pasted private key became a key name that was printed, stored, and written back, while the wizard called the file safe to commit.
- Kerstel never creates a new vault key while a vault sealed with one exists. Before, on Linux, a Secret Service that failed to answer for a moment (a D-Bus hiccup, an agent still starting, a session with no bus) read as "no key stored", a fresh key was minted and `secret-tool store` silently replaced the real one, and every secret and backup became unreadable. Now a lookup that fails for any reason other than "not found" counts as "a key is stored", a vault with a key check or any secrets refuses to mint at all, and `init` seals its backup with the key the vault is already open with instead of fetching it a second time.
- `kerstel init` no longer treats backup copies such as `.env.bak`, `.env.orig`, `.env.swp`, or `.env.local~` as env files. Before, a stale value in `.env.bak` outranked the live one in `.env` and went into the vault, and a Vim swap file was rewritten in place. Each skipped copy is now named, with a reminder that it may still hold plaintext, and to rename it if it is a real env file.

## 0.1.1 (2026-09-19)

### Added

- `kerstel update` installs the latest release in place: it downloads the binary for your platform, verifies its checksum against the release's `SHA256SUMS`, confirms the new binary reports the expected version, and then swaps it in. `--check` only tells you whether a newer release exists.
- `kerstel --version` on a terminal says whether you're up to date, and names the newer release when there is one. Piped, it still prints only the version and never touches the network.
- `kerstel doctor` starts with a version row: up to date, a newer release with `Fix: kerstel update`, or a note that the release page could not be reached.

### Changed

- The [changelog](https://kerstel.dev/changelog) on kerstel.dev is a timeline, one entry per release, with the 0.1.0 release video at the top.
- The installer shows a progress bar while downloading, names your platform, ticks off each step, and ends with a short note on what Kerstel does and the three commands to run next. Piped output stays plain, and `NO_COLOR` is respected.
- `kerstel doctor` no longer tells you to start the daemon by hand. An idle daemon is normal, since it starts on its own the first time a script needs a secret, so `doctor` now reports it as information rather than a warning. Outside a project, or in one that isn't set up yet, `doctor` ends with a short "How it works" note.

### Fixed

- The `kerstel init` overview strips Unicode bidi and zero-width characters from the config values it shows, so a value can no longer reorder or hide the text around it in the terminal. Secret values were never shown.
- When a session's credential store is not the one holding the vault key, the error now gives advice for the store that actually holds it. A vault keyed in a file names the key file and says to run with `KERSTEL_KEYCHAIN_BACKEND=file`, instead of telling you to unlock the Keychain.
- `kerstel uninstall` removes every `kerstel` and `ks` link that points at the binary, wherever they are on `PATH` or in the folder it was run from. Before, when `kerstel` on your `PATH` was itself a link to the binary, both it and the `ks` shortcut beside it were left dangling.

## 0.1.0 (2026-09-19)

The first release: a local-first secrets manager for Node and Bun projects.

### Added

- Encrypted local vault at `~/.kerstel/vault.db`. Every value is sealed with AES-256-GCM and its own random nonce.
- Vault data key kept in the OS credential store: the Keychain on macOS and Secret Service on Linux. Linux machines without a Secret Service provider fall back to a `0600` key file, with a warning.
- `kerstel://<scope>/<KEY>` references, so `.env` files hold nothing secret and are safe to commit.
- `kerstel set`, `get`, `ls`, and `rm` to manage secrets. `get` prints plaintext only with `--reveal`.
- `kerstel run -- <command>` to run any command with every reference resolved up front.
- `kerstel resolve` to print one resolved value.
- Resolver daemon (`kerstel daemon serve|start|stop|status`) that unlocks the vault once and serves resolutions over a local socket.
- Runtime hook for Node and Bun that resolves references lazily from `process.env`, with no wrapper command.
- `kerstel doctor` to diagnose the vault, the credential store, the daemon, and the hook assets. Inside a project it also reports the scope, the runtime, how many scripts are wired, and how many references this vault can resolve.
- `kerstel init`, a setup wizard that moves a project's `.env` values into the vault. It sums up what will change in each file, shows the full masked diff on request, asks once before writing, and backs up the originals encrypted. It rewrites only the values, keeping comments, order, and quoting intact. Then it wires the runtime hook into your `package.json` scripts, so `npm run dev` stays `npm run dev`.
- `kerstel init` on a cloned project that already uses Kerstel prompts for each key your vault is missing, with the echo turned off. Nothing is stored until you apply the plan.
- `kerstel init` flags for scripts and CI: `--dry-run` (writes nothing, not even to `~/.kerstel`), `--yes`, `--scope`, `--global`, `--keep`, `--non-interactive`, and `--from-stdin`. `--keep` or `--global` naming a key no env file defines gets a warning.
- `kerstel init` suggests the vault for any key whose name marks a credential, such as `PASSWORD`, `PASS`, `PWD`, `PIN`, `PASSPHRASE`, `TOKEN`, `SECRET`, or any `*_KEY`, even when the value is a number like `PIN=4821`.
- `kerstel exec -- <command>`, which runs one command with the runtime hook wired in. `kerstel init` writes it into your scripts.
- [kerstel.dev](https://kerstel.dev) with getting-started, CLI, resolution, teams, and security docs, plus the changelog and the [roadmap](https://kerstel.dev/roadmap).
- `kerstel --version`.
- `kerstel uninstall`, which restores every project's `.env` values in their original quoting, package scripts, and `.gitignore`, then removes `~/.kerstel`, the vault key, and the binary. It refuses, naming each one, if any secret would be lost, including a value `init` kept only in its encrypted backup. Afterwards it names every restored `.env` file git still tracks.
- Release binaries for macOS and Linux (x64 and arm64), with SHA-256 checksums.
- `curl -fsSL https://kerstel.dev/install.sh | bash`, which verifies the checksum and installs to `~/.local/bin` without `sudo`.
- `ks`, a shortcut for `kerstel`, installed by `install.sh` when nothing else is called `ks`, and removed by `uninstall`.
- `kerstel doctor --verbose` shows the paths and permissions behind each check.

### Changed

- `kerstel init` shows every variable and where it would go, then lets you accept the suggestions with Enter, change a few, or go one by one, with arrow-key menus. Values appear only as their length, except configuration like `PORT=3000` that stays in plain text.
- `kerstel doctor` groups its checks, shows how to fix each warning and problem, and exits 1 when something is wrong.
- Bare `kerstel` lists the commands and exits 0.
