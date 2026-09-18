# Changelog

All notable changes to Kerstel are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 (unreleased)

The first release: a local-first secrets manager for Node and Bun projects.

### Added

- Encrypted local vault at `~/.kerstel/vault.db`. Every value is sealed with AES-256-GCM and its own random nonce.
- Vault data key kept in the OS credential store: Keychain on macOS, Secret Service on Linux, and Credential Manager on Windows.
- `kerstel://<scope>/<KEY>` references, so `.env` files hold nothing secret and are safe to commit.
- `kerstel set`, `get`, `ls`, and `rm` to manage secrets. `get` prints plaintext only with `--reveal`.
- `kerstel run -- <command>` to run any command with every reference resolved up front.
- `kerstel resolve` to print one resolved value.
- Resolver daemon (`kerstel daemon serve|start|stop|status`) that unlocks the vault once and serves resolutions over a local socket.
- Runtime hook for Node and Bun that resolves references lazily from `process.env`, with no wrapper command.
- `kerstel doctor` to diagnose the vault, the credential store, the daemon, and the hook assets.
- [kerstel.dev](https://kerstel.dev) with getting-started, CLI, resolution, teams, and security docs.
