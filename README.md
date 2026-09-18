<div align="center">

<img src="docs/logo-dark.png" alt="Kerstel" width="200">

**Local-first secrets for Node and Bun projects**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Your `.env` files hold only references (`kerstel://<scope>/<KEY>`) — safe to read, grep, and commit. The real values live in an encrypted vault on your machine. No account, no cloud, no telemetry.

[Problem](#the-problem) · [How it works](#how-it-works) · [Usage](#usage) · [Security](#security-model) · [Build from source](#build-from-source)

</div>

---

## The problem

`.env` and `.env.local` files hold secrets in plaintext. Anything that can read files — AI coding agents, editor plugins, accidental commits, backup tools — can read those secrets too. Existing solutions solve this with cloud accounts and a wrapper command you have to remember to type. Kerstel has no account, and writes its wrapper into your `package.json` scripts once so you never type it: `npm run dev` stays `npm run dev`.

## How it works

Secrets are stored once, encrypted, in a local vault:

```bash
ks set global/OPENAI_API_KEY --value sk-...
```

Your `.env` file then holds a reference instead of the value:

```bash
# .env — safe to commit
OPENAI_API_KEY=kerstel://global/OPENAI_API_KEY
```

A reference names exactly one scope — `global`, or a project name — with no fallback chain. A resolver daemon unlocks the vault once via your OS credential store (Keychain on macOS, Secret Service on Linux) and serves resolutions to your app's process over a local socket. Your code sees the real value in `process.env`; the file on disk never does.

## Usage

```bash
ks init [--yes] [--dry-run]                 # Migrate this project's .env files
ks set <scope>/<KEY> [--value <value>]      # Store a secret (or pipe it on stdin)
ks get <scope>/<KEY> [--reveal]             # Read a secret
ks ls [--scope <scope>]                     # List stored references
ks rm <scope>/<KEY> --yes                   # Remove a secret
ks run -- <command>                         # Run a command with references resolved
ks exec -- <command>                        # Run a command with the hook wired in
ks resolve kerstel://<scope>/<KEY>          # Print one resolved value
ks daemon <serve|start|stop|status>         # Manage the resolver daemon
ks doctor [--verbose]                       # Diagnose this machine's setup
ks uninstall [--dry-run] [--yes] [--force]  # Restore every project, then remove Kerstel
ks --version                                # Print the version
```

`ks run -- <command>` is the universal fallback: it resolves every reference in the current environment up front and execs the command with plaintext values injected. It works for anything that can't load the runtime hook, such as IDE run configurations. Projects wired up with the runtime hook resolve references lazily instead, straight out of `process.env`. Those projects still go through a wrapper — `kerstel exec` — but `kerstel init` writes it into your `package.json` scripts once, so you never type it: `npm run dev` is still `npm run dev`.

## Install

```bash
curl -fsSL https://kerstel.dev/install.sh | bash
```

macOS and Linux, x64 and arm64. The installer verifies the release checksum and puts the binary at `~/.local/bin/kerstel`, without `sudo`. Re-run it to upgrade, or set `KERSTEL_VERSION=0.1.0` to pin a version.

The installer also adds `ks`, a shortcut for `kerstel`. If something else on your `PATH` is already called `ks`, it leaves that alone and tells you to use `kerstel` instead. Everything below works the same either way — `ks` and `kerstel` are the same binary.

To remove Kerstel, run `ks uninstall`. It rewrites every project's references back to their values, unwraps your scripts, and then deletes `~/.kerstel`, the vault key, the binary, and the `ks` shortcut, in that order. Values go back in the quoting you wrote them in. It refuses if a secret would be lost, and names it: that includes a value `init` kept only in its encrypted backup, when a key had different values in several `.env` files. `--force` goes ahead anyway. If git tracks a restored `.env` file, it tells you to run `git rm --cached` on it. On a machine with no Kerstel data, it just removes the binary.

## Set up a project

```bash
cd my-app
ks init
```

The wizard shows every variable it found, grouped by where it suggests putting it — the vault for this project, the vault shared across all your projects, or left as plain text — and then asks **"Look right?"**: press Enter to accept every suggestion, or choose **Let me change some** to pick individual keys from a checklist, or **Go through them one by one** to answer for each in turn. Whichever you pick, it shows the plan and a full diff of every file, then asks **once more**, before its first write, whether to apply all of it: the backup, the vault entries, the `.env` rewrites and the wiring. One more question sits outside that: whether to touch `.gitignore`, asked afterwards.

1. **Detect** your runtime and package manager from your lockfile.
2. **Parse** every `.env` / `.env.*` file in the project root (templates like `.env.example` are skipped) and show what it found — key names, value sizes and shapes, never the values themselves. For each key you choose: store it in this **project**'s scope, point it at a **global** key shared across all your projects, or leave it as **plaintext** (right for `NODE_ENV`, ports and public URLs).
3. **Back up** the originals, encrypted with your vault key, to `~/.kerstel/backups/<project>/<timestamp>/`.
4. **Rewrite** the files, changing only the bytes of the values it stored. Comments, blank lines, key order, quoting style and inline comments all survive byte for byte.
5. **Wire** the hook: every `package.json` script becomes `kerstel exec -- <your original command>` (npm lifecycle hooks are never wrapped). You see the diff first. Bun projects are wired the same way — `kerstel exec` passes `--preload` to `bun` itself, because Bun ignores `NODE_OPTIONS`.
6. **Offer to update `.gitignore`**, as a separate confirmation that defaults to **no**: if it currently hides your env files, the wizard asks whether it should remove those lines and add a one-line note instead, so the now reference-only files can be committed. It re-reads the rewritten files first: if any key still holds a plaintext value — `--keep`, a **plaintext** answer, or a line it could not parse — it names those keys rather than telling you the files are safe to commit. Decline and it leaves `.gitignore` untouched.
7. **Self-check** by running a probe through the wiring and confirming a reference resolves.

Afterwards `npm run dev` is still `npm run dev`.

Useful flags:

| Flag | What it does |
|---|---|
| `--dry-run` | Prints every diff and writes nothing: not to your project, your vault, or `~/.kerstel`. Run this first. |
| `--yes` | Accepts every suggestion, asks nothing. |
| `--scope <name>` | Overrides the project scope (default: your `package.json` name). |
| `--global KEY[,KEY]` | Forces those keys into the `global` scope. |
| `--keep KEY[,KEY]` | Forces those keys to stay plaintext. |
| `--non-interactive` | Never asks a question. Applies the suggested plan like `--yes`, but fails with exit 2 naming the flag on any question no flag can answer — a missing secret value, for instance. Pair it with `--from-stdin` in scripts. |
| `--from-stdin` | Reads `{"KEY": "value"}` JSON for keys this machine is missing. |

`ks init` is idempotent: run it again after adding a key and it migrates only what is new.

### One key, several files

If the same key appears in more than one file with different values, Kerstel stores the highest-precedence one — `.env.<x>.local` beats `.env.local` beats `.env.<x>` beats `.env` — points **every** occurrence at that one reference, and tells you which files it collapsed. The other values remain in the encrypted backup. Kerstel has no environments yet (they are on the [roadmap](ROADMAP.md)), so one key resolves to one value.

### Joining a project that already uses Kerstel

```bash
git clone git@github.com:acme/my-app.git && cd my-app
ks init
```

The committed `.env` holds references, so `init` lists the keys your vault does not have yet and prompts for each one with the echo turned off. It stores them when you apply the plan, or straight away if nothing else in the project needs changing. The references double as a living `.env.example`. To supply them from a script instead:

```bash
echo '{"DATABASE_URL":"postgres://...","STRIPE_SECRET_KEY":"sk_live_..."}' | kerstel init --from-stdin --non-interactive
```

Secrets are never accepted as command-line arguments — anything on argv is in your shell history and in `ps` output.

### `kerstel exec` vs `kerstel run`

| | `kerstel exec -- <cmd>` | `kerstel run -- <cmd>` |
|---|---|---|
| What the child's environment holds | references, untouched | resolved plaintext |
| When values are resolved | lazily, on each `process.env` read, through the daemon | all at once, before the command starts |
| What it needs | the runtime hook (Node or Bun) | nothing |
| Audit log | one row per key the app actually reads | one row per reference in the environment |
| Used by | your wired `package.json` scripts | IDE run configurations, other languages, anything the hook cannot reach |

`exec` is what the wizard writes into your scripts; `run` is the universal fallback that always works.

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

The runtime hook must be built before anything runs from source — the CLI embeds `packages/hook/dist/preload.cjs` and `worker.cjs` at import time, so `bun run packages/cli/src/index.ts` fails on a fresh clone until `bun run --cwd packages/hook build` has run once; the `build` command above and `bun run test` below both do it for you.

### Run tests

```bash
bun run typecheck
bun run test
```

## Contributing

Contributions are welcome! Here's how:

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Add a line to `CHANGELOG.md`, and tick `ROADMAP.md` if you finished an item on it
5. Run the tests (`bun run test`)
6. Commit with a [Conventional Commits](https://www.conventionalcommits.org) message (`git commit -m 'feat: add my feature'`)
7. Push (`git push origin feat/my-feature`)
8. Open a Pull Request

The macOS Keychain tests in `packages/cli/test/keychain.test.ts` write to and delete from the real login Keychain, so they are skipped unless you set `KERSTEL_ALLOW_REAL_KEYCHAIN_TESTS=1`.

Please keep PRs focused — one feature or fix per PR. [AGENTS.md](AGENTS.md) has the full contributor rules, including how to update [ROADMAP.md](ROADMAP.md) and [CHANGELOG.md](CHANGELOG.md). Coding agents read it too.

## License

[MIT](LICENSE) — free to use, modify, and distribute.

---

<div align="center">

**[kerstel.dev](https://kerstel.dev)** · [Docs](https://kerstel.dev/docs) · [Security model](https://kerstel.dev/security) · [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md)

</div>
