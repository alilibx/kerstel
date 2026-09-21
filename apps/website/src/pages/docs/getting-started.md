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

The installer downloads the binary for your Mac or Linux machine with a progress bar, checks it against the SHA-256 checksum published with the release, and puts it at `~/.local/bin/kerstel`. It ends with a short note on what Kerstel does and the three commands to run next. Piped into a log, or with `NO_COLOR` set, it prints plain lines instead. It never uses `sudo` and never touches your vault. If `~/.local/bin` is not on your `PATH`, it prints the line to add.

The installer also adds `ks`, a shortcut for `kerstel` in the same directory. The rest of this guide uses `ks` — it's the same binary, so anywhere you see `ks` you can type `kerstel` instead. If something else on your machine is already called `ks`, the installer leaves it alone and tells you to use `kerstel`.

To upgrade later, run `ks update`. It fetches the latest release, verifies its checksum, and swaps it into place. `ks --version` and `ks doctor` both tell you when a newer release exists. To install a specific version, set `KERSTEL_VERSION`:

```bash
curl -fsSL https://kerstel.dev/install.sh | KERSTEL_VERSION=0.1.0 bash
```

Windows is not supported yet. Run `ks doctor` afterwards to confirm the vault and credential store are reachable.

Prefer to build it yourself? The [README](https://github.com/alilibx/kerstel#build-from-source) covers building from source with Bun.

## 2. Store a secret

```bash
ks set global/OPENAI_API_KEY --value sk-...
```

`--value` is the quickest way to try this, but it lands in your shell history. Pipe the value in instead so it never does:

```bash
pbpaste | ks set global/OPENAI_API_KEY
```

`global` is a scope shared by every project on this machine. Use a project name instead, such as `myapp/DATABASE_URL`, for a value that belongs to one project.

## 3. Reference it from your project

Open `.env` and replace the value with a reference:

```bash
# .env
OPENAI_API_KEY=kerstel://global/OPENAI_API_KEY
```

This file is now safe to read, grep, and commit. `ks ls` shows every reference the vault can serve.

## 4. Run your app

`ks run` resolves every `kerstel://` reference already sitting in the environment it inherits, then starts the command with the real values in place. It never reads `.env` itself, so get `.env` into the environment first:

```bash
set -a; . ./.env; set +a
ks run -- npm run dev
```

Projects wired with the runtime hook skip both steps: the hook resolves `kerstel://` references wherever they come from, including a `.env` loader, so your code reads `process.env.OPENAI_API_KEY` and gets the real value directly. `ks init` does that wiring for you, once, and [how resolution works](/docs/how-it-works) covers what it writes.

## 5. Check the setup

```bash
ks doctor
```

`doctor` groups its checks under **This machine** (vault, daemon, runtime hook, file permissions, and whether `ks` is on your `PATH`) and, inside a project, **This project** (scripts wired, references that resolve, and any env file it could not read). Each warning or problem prints a `Fix:` line naming the command that resolves it. An idle daemon is not a warning: it starts on its own the first time a script needs a secret, so `doctor` reports it as `·  Daemon  idle`. Outside a project, or in one you haven't run `ks init` in yet, `doctor` ends with a short **How it works** note. Add `--verbose` for the paths and permission modes behind each check. `doctor` exits `1` if any check reports a problem, `0` otherwise — a warning alone still exits `0`. See the [CLI reference](/docs/cli) for what each check reports.

## Set up a project

Everything above, for a whole project, in one command:

```bash
cd my-app
ks init
```

Run it from the project root — it needs a readable `package.json`, because it wires your scripts. It detects your runtime and package manager from your lockfile, derives the project's scope from the `package.json` name, and reads every `.env` / `.env.*` file in the root. Templates like `.env.example` are skipped, and so are backup copies like `.env.bak` or `.env.swp`, which it names so you can delete them, or rename one that is a real env file.

It shows every variable it found up front, grouped by where it suggests putting it — the vault for this project, the vault shared across all your projects, or left as plain text — with each value shown only as its length. The exception is a configuration value that stays in plain text, like `PORT=3000` or `NODE_ENV=development`, which is shown as it is; anything that could be a credential, even a number under a name like `DB_PASSWORD`, is shown as a length. Then it asks:

1. **"Look right?"** Press Enter to accept every suggestion (the default), choose **Let me change some** to pick individual keys from a checklist and change just those, or **Go through them one by one** to answer for each in turn, with the reason behind each suggestion shown alongside it. Changing anything re-shows the overview and asks again, until you accept it.
2. **A `.gitignore` question**, if it currently hides your env files: whether to remove those lines and leave a note instead, so the now reference-only files can be committed. Kerstel re-reads the files it is about to write first and names any key that would still hold a plaintext value rather than calling the files safe. Defaults to **no**.
3. **"Apply these changes?"**, under a one-line summary per file of what will change (`.env: 3 values become references`, `package.json: 2 scripts go through Kerstel`, and `.gitignore` if you said yes). The answer covers all of it: the backup, the vault entries, the `.env` rewrites, the wiring, and the `.gitignore` edit. **Apply** is the default; **Show the full diff first** prints a line-for-line diff of every file, values masked, and asks again; **Cancel** writes nothing.

Before its first write it puts your original files, encrypted with your vault key, in `~/.kerstel/backups/<scope>/<timestamp>/`. Then it rewrites the values, wires every `package.json` script as `kerstel exec -- <your original command>`, and finishes by running a probe through the wiring to prove a reference resolves.

To see all of that without writing anything, add `--dry-run`: it prints every diff and stops before the first write.

```bash
ks init --dry-run
```

`init` is safe to run again. A second run migrates only what is new, and when there is nothing left to change it says so — naming any key that is still plaintext, whether you chose that or the line could not be parsed. A line with no readable key is named by file and line instead, never by its text. That includes a private key pasted unquoted across several lines (`-----BEGIN … -----END`), which `init` leaves as it is: store it with `ks set` and reference it, or put it on one line in double quotes with `\n`.

If the same key appears in more than one file with different values, the highest-precedence file wins: `.env.<x>.local`, then `.env.local`, then `.env.<x>`, then `.env`. Every occurrence is pointed at that one reference, the files it collapsed are named, and the other values survive in the encrypted backup.

Afterwards, `npm run dev` is still `npm run dev`. Run `ks doctor` in the project to confirm the wiring. Commit `.kerstel/exec.cjs` along with `package.json`: it is what lets the same scripts run on a deploy host that has no Kerstel. See [Deploying](/docs/deploying).
