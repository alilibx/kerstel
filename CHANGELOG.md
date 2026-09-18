# Changelog

All notable changes to Kerstel are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 (unreleased)

The first release: a local-first secrets manager for Node and Bun projects.

### Added

- Encrypted local vault at `~/.kerstel/vault.db`. Every value is sealed with AES-256-GCM and its own random nonce.
- Vault data key kept in the OS credential store: Keychain on macOS, Secret Service on Linux, and Credential Manager on Windows. Linux machines without a Secret Service provider fall back to a `0600` key file, with a warning.
- `kerstel://<scope>/<KEY>` references, so `.env` files hold nothing secret and are safe to commit.
- `kerstel set`, `get`, `ls`, and `rm` to manage secrets. `get` prints plaintext only with `--reveal`.
- `kerstel run -- <command>` to run any command with every reference resolved up front.
- `kerstel resolve` to print one resolved value.
- Resolver daemon (`kerstel daemon serve|start|stop|status`) that unlocks the vault once and serves resolutions over a local socket.
- Runtime hook for Node and Bun that resolves references lazily from `process.env`, with no wrapper command.
- `kerstel doctor` to diagnose the vault, the credential store, the daemon, and the hook assets. Inside a project it also reports the scope, the runtime, how many scripts are wired, and how many references this vault can resolve.
- `kerstel init`, a setup wizard that moves a project's `.env` values into the vault. It shows the full plan and every diff, asks once before writing, and backs up the originals encrypted. It rewrites only the values, keeping comments, order, and quoting intact. Then it wires the runtime hook into your `package.json` scripts, so `npm run dev` stays `npm run dev`.
- `kerstel init` on a cloned project that already uses Kerstel prompts for each key your vault is missing, with the echo turned off. Nothing is stored until you apply the plan.
- `kerstel init` flags for scripts and CI: `--dry-run` (writes nothing, not even to `~/.kerstel`), `--yes`, `--scope`, `--global`, `--keep`, `--non-interactive`, and `--from-stdin`. `--keep` or `--global` naming a key no env file defines gets a warning.
- `kerstel exec -- <command>`, which runs one command with the runtime hook wired in. `kerstel init` writes it into your scripts.
- [kerstel.dev](https://kerstel.dev) with getting-started, CLI, resolution, teams, and security docs, plus the changelog and the [roadmap](https://kerstel.dev/roadmap).
- `kerstel --version`.
- `kerstel uninstall`, which restores every project's `.env` values in their original quoting, package scripts, and `.gitignore`, then removes `~/.kerstel`, the vault key, and the binary. It refuses, naming each one, if any secret would be lost, including a value `init` kept only in its encrypted backup. Afterwards it names every restored `.env` file git still tracks.
- Release binaries for macOS and Linux (x64 and arm64), with SHA-256 checksums.
- `curl -fsSL https://kerstel.dev/install.sh | bash`, which verifies the checksum and installs to `~/.local/bin` without `sudo`.
- `ks`, a shortcut for `kerstel`, installed by `install.sh` when nothing else is called `ks`, and removed by `uninstall`.
- `kerstel doctor --verbose` shows the paths and permissions behind each check.

### Changed

- `kerstel init` shows every variable and where it would go, then lets you accept the suggestions with Enter, change a few, or go one by one, with arrow-key menus.
- `kerstel doctor` groups its checks, shows how to fix each problem, and exits 1 when something is wrong.
- Bare `kerstel` lists the commands and exits 0.
