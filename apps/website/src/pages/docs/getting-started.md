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

Binaries are not published yet: the installer prints a message saying so and exits without installing anything. Until they ship, build from source instead, as covered below.

Once binaries ship, the installer will place the `kerstel` binary in `~/.kerstel/bin`, add it to your PATH, create the vault, and store the data key in your OS credential store. Run `kerstel doctor` afterwards to confirm the vault and credential store are reachable.

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

Projects wired with the runtime hook skip both steps: the hook resolves `kerstel://` references wherever they come from, including a `.env` loader, so your code reads `process.env.OPENAI_API_KEY` and gets the real value directly. [How resolution works](/docs/how-it-works) covers how to wire a project for the hook.

## 5. Check the setup

```bash
kerstel doctor
```

`doctor` prints your Kerstel home, the vault path and how many secrets it holds, the session token, which credential store backs the vault, the socket path, whether the hook assets are installed under `~/.kerstel`, and whether the daemon is running.

## What about a whole project at once?

`kerstel init` will do all of this for a whole project at once, moving every `.env` value into the vault and rewriting the files with references; it is in progress, so until it lands the steps above are the manual path.
