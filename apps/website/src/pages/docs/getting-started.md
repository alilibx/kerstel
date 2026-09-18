---
title: Getting started
description: Install Kerstel, store a secret, replace the plaintext in your .env with a reference, and run your app.
section: docs
order: 1
---
# Getting started

<p class="lede">Five minutes from a plaintext <code>.env</code> to one that is safe to commit.</p>

## 1. Install

```bash
curl -fsSL https://kerstel.dev/install.sh | bash
```

The installer downloads the binary for your Mac or Linux machine, checks it against the SHA-256 checksum published with the release, and puts it at `~/.local/bin/kerstel`. It never uses `sudo` and never touches your vault. If `~/.local/bin` is not on your `PATH`, it prints the line to add.

Run the same command again to upgrade. To install a specific version, set `KERSTEL_VERSION`:

```bash
curl -fsSL https://kerstel.dev/install.sh | KERSTEL_VERSION=0.1.0 bash
```

Windows is not supported yet. Run `kerstel doctor` afterwards to confirm the vault and credential store are reachable.

Prefer to build it yourself? The [README](https://github.com/alilibx/kerstel#build-from-source) covers building from source with Bun.

## 2. Store a secret

```bash
kerstel set global/OPENAI_API_KEY --value sk-...
```

`--value` is the quickest way to try this, but it lands in your shell history. Pipe the value in instead so it never does:

```bash
pbpaste | kerstel set global/OPENAI_API_KEY
```

`global` is a scope shared by every project on this machine. Use a project name instead, such as `myapp/DATABASE_URL`, for a value that belongs to one project.

## 3. Reference it from your project

Open `.env` and replace the value with a reference:

```bash
# .env
OPENAI_API_KEY=kerstel://global/OPENAI_API_KEY
```

This file is now safe to read, grep, and commit. `kerstel ls` shows every reference the vault can serve.

## 4. Run your app

`kerstel run` resolves every `kerstel://` reference already sitting in the environment it inherits, then starts the command with the real values in place. It never reads `.env` itself, so get `.env` into the environment first:

```bash
set -a; . ./.env; set +a
kerstel run -- npm run dev
```

Projects wired with the runtime hook skip both steps: the hook resolves `kerstel://` references wherever they come from, including a `.env` loader, so your code reads `process.env.OPENAI_API_KEY` and gets the real value directly. `kerstel init` does that wiring for you, once, and [how resolution works](/docs/how-it-works) covers what it writes.

## 5. Check the setup

```bash
kerstel doctor
```

`doctor` prints your Kerstel home, the vault path and how many secrets it holds, the session token, which credential store backs the vault, the socket path, whether the hook assets are installed under `~/.kerstel`, and whether the daemon is running. Run inside a project with a `package.json` and it adds a **Project** section covering the wiring: see the [CLI reference](/docs/cli) for what that section reports.

## Set up a project

Everything above, for a whole project, in one command:

```bash
cd my-app
kerstel init
```

Run it from the project root — it needs a readable `package.json`, because it wires your scripts. It detects your runtime and package manager from your lockfile, derives the project's scope from the `package.json` name, and reads every `.env` / `.env.*` file in the root (templates like `.env.example` are skipped).

You are asked three kinds of question, and no more:

1. **One choice per key**, before any plan is drawn: store the value in this **project**'s scope, point it at a **global** key shared across all your projects, or leave it as **plaintext**. Kerstel suggests one; you decide. Key names, value sizes and value shapes are printed — never the values.
2. **One confirmation**, under the full plan and a line-for-line diff of every file it means to change, covering all of it at once: the backup, the vault entries, the `.env` rewrites, and the wiring. Values are masked in that diff too.
3. **One question about `.gitignore`**, afterwards, defaulting to **no**: if `.gitignore` currently hides your env files, Kerstel offers to remove those lines and leave a note instead, so the now reference-only files can be committed. It re-reads the rewritten files first and names any key that still holds a plaintext value rather than calling the files safe.

Before its first write it puts your original files, encrypted with your vault key, in `~/.kerstel/backups/<scope>/<timestamp>/`. Then it rewrites the values, wires every `package.json` script as `kerstel exec -- <your original command>`, and finishes by running a probe through the wiring to prove a reference resolves.

To see all of that without writing anything, add `--dry-run`: it prints every diff and stops before the first write.

```bash
kerstel init --dry-run
```

`init` is safe to run again. A second run migrates only what is new, and when there is nothing left to change it says so — naming any key that is still plaintext, whether you chose that or the line could not be parsed.

If the same key appears in more than one file with different values, the highest-precedence file wins: `.env.<x>.local`, then `.env.local`, then `.env.<x>`, then `.env`. Every occurrence is pointed at that one reference, the files it collapsed are named, and the other values survive in the encrypted backup.

Afterwards, `npm run dev` is still `npm run dev`. Run `kerstel doctor` in the project to confirm the wiring.
