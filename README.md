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
ks update [--check]                         # Install the latest release
ks uninstall [--dry-run] [--yes] [--force]  # Restore every project, then remove Kerstel
ks --version                                # Print the version, and whether it's current
```

`ks run -- <command>` is the universal fallback: it resolves every reference in the current environment up front and execs the command with plaintext values injected. It works for anything that can't load the runtime hook, such as IDE run configurations. Projects wired up with the runtime hook resolve references lazily instead, straight out of `process.env`. Those projects still go through a wrapper — `kerstel exec` — but `kerstel init` writes it into your `package.json` scripts once, so you never type it: `npm run dev` is still `npm run dev`.

## Install

```bash
curl -fsSL https://kerstel.dev/install.sh | bash
```

macOS and Linux, x64 and arm64. The installer verifies the release checksum and puts the binary at `~/.local/bin/kerstel`, without `sudo`. Run `ks update` to upgrade in place: it shows the download's progress, verifies the checksum, and only then swaps the binary. Set `KERSTEL_VERSION=0.1.0` when installing to pin a version. `ks --version` and `ks doctor` tell you when a newer release exists.

The installer also adds `ks`, a shortcut for `kerstel`. If something else on your `PATH` is already called `ks`, it leaves that alone and tells you to use `kerstel` instead. Everything below works the same either way — `ks` and `kerstel` are the same binary.

To remove Kerstel, run `ks uninstall`. It rewrites every project's references back to their values, unwraps your scripts, and then deletes `~/.kerstel`, the vault key, the binary, and every `kerstel` or `ks` link that points at it, in that order. Values go back in the quoting you wrote them in. It refuses if a secret would be lost, and names it: that includes a value `init` kept only in its encrypted backup, when a key had different values in several `.env` files. `--force` goes ahead anyway. If git tracks a restored `.env` file, it tells you to run `git rm --cached` on it. On a machine with no Kerstel data, it just removes the binary.

## Set up a project

```bash
cd my-app
ks init
```

The wizard shows every variable it found, grouped by where it suggests putting it — the vault for this project, the vault shared across all your projects, or left as plain text — and then asks **"Look right?"**: press Enter to accept every suggestion, or choose **Let me change some** to pick individual keys from a checklist, or **Go through them one by one** to answer for each in turn. Once you accept, it asks whether to touch `.gitignore`, if that file hides your env files. Then it shows a one-line summary per file of what will change and asks **"Apply these changes?"** once, before its first write, covering all of it: the backup, the vault entries, the `.env` rewrites, the wiring and any `.gitignore` edit. Press Enter to apply, choose **Show the full diff first** to see every file's masked diff before answering, or **Cancel** to write nothing.

1. **Detect** your runtime and package manager from your lockfile.
2. **Parse** every `.env` / `.env.*` file in the project root (templates like `.env.example` are skipped, and so are backup copies like `.env.bak` or `.env.swp`, which it names so you can delete them, or rename one that is a real env file) and show what it found: key names and sources, with each value shown only as its length. The exception is a configuration value that stays in plain text, like `PORT=3000` or `NODE_ENV=development`, which is shown as it is. A name that says it is a credential wins over a public prefix, so `VITE_SUPABASE_KEY` is shown as a length, and so is a value that looks like a token or a URL with a credential in it. For each key you choose: store it in this **project**'s scope, point it at a **global** key shared across all your projects, or leave it as **plaintext** (right for `NODE_ENV`, ports and public URLs). A line the wizard cannot read as `KEY=value` is left as it is and reported: by its key when it has one, otherwise by file and line, never by its text. A private key pasted unquoted across several lines (`-----BEGIN … -----END`) counts as one such value; store it with `ks set` and reference it, or put it on one line in double quotes with `\n`.
3. **Back up** the originals, encrypted with your vault key, to `~/.kerstel/backups/<project>/<timestamp>/`.
4. **Rewrite** the files, changing only the bytes of the values it stored. Comments, blank lines, key order, quoting style and inline comments all survive byte for byte.
5. **Wire** the hook: init writes a launcher at `.kerstel/exec.cjs` (commit it), and every command in every `package.json` script gets `node .kerstel/exec.cjs -- ` in front of it, after any leading `NAME=value` words, so `node copy.mjs && next dev` becomes `node .kerstel/exec.cjs -- node copy.mjs && node .kerstel/exec.cjs -- next dev`. The launcher runs `kerstel exec` where Kerstel is installed and the command unchanged where it is not, so a deploy host needs nothing (npm lifecycle hooks are never wrapped, nor are commands that never run JavaScript, such as `rm` or `echo`; a script with `cd`, a redirection, or shell control is skipped and named). **Show the full diff first** lets you see it before anything is written. Bun projects are wired the same way — `kerstel exec` passes `--preload` to `bun` itself, because Bun ignores `NODE_OPTIONS`.
6. **Update `.gitignore`** if you said yes when asked. The question comes before **"Apply these changes?"** and defaults to **no**: if `.gitignore` currently hides your env files, the wizard asks whether it should remove those lines and add a one-line note instead, so the reference-only files can be committed. It checks the files as they will be written first: if any key still holds a plaintext value — `--keep`, a **plaintext** answer, or a line it could not parse — it names those keys (or the file and line, for a line with no readable key) rather than telling you the files are safe to commit. Decline and it leaves `.gitignore` untouched.
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

`init` never accepts a secret as a command-line argument. The one command that will is `ks set --value`, and it warns you: anything on argv is in your shell history and in `ps` output, so pipe the value on stdin instead.

### `kerstel exec` vs `kerstel run`

| | `kerstel exec -- <cmd>` | `kerstel run -- <cmd>` |
|---|---|---|
| What the child's environment holds | references, untouched | resolved plaintext |
| When values are resolved | lazily, on each `process.env` read, through the daemon; under Bun also once at startup, so `Bun.env` sees the value | all at once, before the command starts |
| What it needs | the runtime hook (Node or Bun) | nothing |
| Audit log | one row per key the app actually reads (under Bun, one per reference) | one row per reference in the environment |
| Used by | your wired `package.json` scripts, through the committed launcher | IDE run configurations, other languages, anything the hook cannot reach |
| Where Kerstel is absent | the launcher runs the command unchanged, with one stderr line | fails |

`exec` is what the wizard writes into your scripts, behind the launcher; `run` is the universal fallback that always works. Deploy hosts need neither: the launcher runs the command unchanged where Kerstel is absent, and the values come from the host's own settings. See [Deploying](https://kerstel.dev/docs/deploying). Both tell you when the command itself is not on `PATH`, and in a project name the install command for your package manager, since in a fresh clone the missing binary is usually a dependency you haven't installed yet. They exit `127` in that case, as a shell does.

## Security model

- No plaintext secret ever sits in a project file. Reading, committing, or grepping `.env` yields only references.
- Secrets are encrypted at rest with AES-256-GCM, one random nonce per value. The data key lives in your OS credential store — or, on a machine with none and with `KERSTEL_KEYCHAIN_BACKEND=file`, as base64 in `~/.kerstel/vault.key` (`0600`), which is then the file to protect. It is never replaced by accident: a new key is minted only on a machine with no vault sealed with one, and a store that fails to answer is treated as holding a key, so you get an error naming the store rather than a fresh key over the real one. Kerstel talks to that store through the OS's own tool (`security`, `secret-tool`), run only from a root-owned system directory such as `/usr/bin`, never from `PATH`, so a dependency's `node_modules/.bin` cannot stand in for it. For the same reason `init` and `exec` refuse, and `doctor` reports a problem, when `node_modules/.bin` holds a `kerstel` of its own.
- Kerstel's own `KERSTEL_*` settings are never read from a project's env files. Kerstel is a Bun binary, so it loads the `.env` of the directory you run it in, and that file is committed by design; a cloned repository could otherwise choose your vault's location or your credential store. A `KERSTEL_*` that an env file there names is dropped and named on stderr, whatever its value, so a setting you made yourself is ignored too while that line is in the file. The daemon runs from `~/.kerstel`, so no env file reaches it.
- The daemon's session token never enters a process environment. `ks exec` gives a wired script `KERSTEL_TOKEN_FILE`, the path of the `0600` token file, and the runtime hook reads the file when it needs it, so nothing a child process inherits, prints, or leaves in a crash report unlocks the vault. The daemon mints a fresh token each time it starts and removes it when it stops.
- The resolver daemon runs with a minimal environment of its own (`PATH`, `HOME`, locale, the Linux session bus, and Kerstel's `KERSTEL_*` settings), never the caller's, whether it is started on demand or you run `ks daemon serve` yourself. A `BUN_OPTIONS` or `NODE_OPTIONS` in your shell, and any plaintext an outer script had already resolved, never reach the process that holds the vault key. `ks doctor` warns when `BUN_OPTIONS` is set, because the one-shot commands still honour it.
- No secret or vault data is ever sent anywhere. The only network traffic is the update check and download against GitHub Releases (or a mirror set with `KERSTEL_RELEASES_URL`), made by `ks update`, `ks --version` (or `ks version`) on a terminal, and `ks doctor`; it carries nothing about your vault, and nothing about you beyond what any web request carries. Nothing else in Kerstel touches the network. Kerstel has no account, collects no telemetry, and listens on no network port. The [security model page](https://kerstel.dev/security) has the details.
- **Any program running as your user account can read every secret in your vault**, with no prompt: `ks get --reveal`, the daemon's token file, or the credential store directly. The `0700` home and `0600` files keep other users out, not you. Kerstel closes the leak where a secret sits in plaintext on disk and reaches git, a backup, or a tool that reads files; it does not stop code you ran from asking for it. See the [design spec](docs/superpowers/specs/2026-09-17-kerstel-secrets-manager-design.md) for the full threat model and the access-level protection planned on top of it.

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
