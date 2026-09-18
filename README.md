<div align="center">

<img src="docs/logo-dark.png" alt="Kerstel" width="200">

**Local-first secrets for Node and Bun projects**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Your `.env` files hold only references (`kerstel://<scope>/<KEY>`) — safe to read, grep, and commit. The real values live in an encrypted vault on your machine. No account, no cloud, no telemetry.

[Problem](#the-problem) · [How it works](#how-it-works) · [Usage](#usage) · [Security](#security-model) · [Build from source](#build-from-source)

</div>

---

## The problem

`.env` and `.env.local` files hold secrets in plaintext. Anything that can read files — AI coding agents, editor plugins, accidental commits, backup tools — can read those secrets too. Existing solutions solve this with cloud accounts and explicit wrapper commands. Kerstel doesn't ask for either.

## How it works

Secrets are stored once, encrypted, in a local vault:

```bash
kerstel set global/OPENAI_API_KEY --value sk-...
```

Your `.env` file then holds a reference instead of the value:

```bash
# .env — safe to commit
OPENAI_API_KEY=kerstel://global/OPENAI_API_KEY
```

A reference names exactly one scope — `global`, or a project name — with no fallback chain. A resolver daemon unlocks the vault once via your OS credential store (Keychain on macOS, Secret Service on Linux, Credential Manager on Windows) and serves resolutions to your app's process over a local socket. Your code sees the real value in `process.env`; the file on disk never does.

## Usage

```bash
kerstel set <scope>/<KEY> [--value <value>]   # Store a secret (or pipe it on stdin)
kerstel get <scope>/<KEY> [--reveal]          # Read a secret
kerstel ls [--scope <scope>]                  # List stored references
kerstel rm <scope>/<KEY> --yes                # Remove a secret
kerstel run -- <command>                      # Run a command with references resolved
kerstel resolve kerstel://<scope>/<KEY>       # Print one resolved value
kerstel daemon <serve|start|stop|status>      # Manage the resolver daemon
kerstel doctor                                # Diagnose this machine's setup
```

`kerstel run -- <command>` is the universal fallback: it resolves every reference in the current environment up front and execs the command with plaintext values injected. It works for anything that can't load the runtime hook, such as IDE run configurations. Projects wired up with the runtime hook resolve references lazily instead, straight out of `process.env`, with no wrapper command needed.

## Security model

- No plaintext secret ever sits in a project file. Reading, committing, or grepping `.env` yields only references.
- Secrets are encrypted at rest with AES-256-GCM, one random nonce per value. The data key lives only in your OS credential store, never on disk in the clear.
- A process that runs code in the project can still read resolved values from `process.env` — that's the boundary Kerstel draws today. See the [design spec](docs/superpowers/specs/2026-09-17-kerstel-secrets-manager-design.md) for the full threat model and the access-level protection planned on top of it.

## Build from source

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/alilibx/kerstel.git
cd kerstel
bun install
bun run --cwd packages/cli build
```

This produces a single compiled binary at `dist/kerstel` — no Node or Bun runtime required to run it.

### Run tests

```bash
bun run typecheck
bun test
```

## Contributing

Contributions are welcome! Here's how:

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run the tests (`bun test`)
5. Commit (`git commit -m 'Add my feature'`)
6. Push (`git push origin feature/my-feature`)
7. Open a Pull Request

Please keep PRs focused — one feature or fix per PR.

## License

[MIT](LICENSE) — free to use, modify, and distribute.

---

<div align="center">

**[kerstel.dev](https://kerstel.dev)**

</div>
