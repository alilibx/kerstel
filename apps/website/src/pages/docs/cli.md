---
title: CLI reference
description: Every Kerstel command, what it does, and the flags it takes.
section: docs
order: 2
---
# CLI reference

<p class="lede">Every command that names a secret takes a reference in the form <code>&lt;scope&gt;/&lt;KEY&gt;</code>, where scope is <code>global</code> or a project name.</p>

## Setting up a project

| Command | What it does |
| --- | --- |
| `kerstel init [--yes] [--dry-run]` | Migrate this project's `.env` files: store each value in the vault, rewrite the files with references, and wire the runtime hook into your scripts. Run it from the project root; it needs a readable `package.json`. |
| `kerstel exec -- <command>` | Run one command with the runtime hook wired in. It resolves nothing itself: it sets `KERSTEL_SOCKET`, `KERSTEL_TOKEN` and `KERSTEL_HOOK_DIR`, appends `--require <the hook>` to `NODE_OPTIONS`, and adds `--preload=<the hook>` for a `bun` or `bunx` command, which `NODE_OPTIONS` does not reach. This is what `init` writes into your scripts. |

### `kerstel init` flags

| Flag | What it does |
| --- | --- |
| `--dry-run` | Prints the plan and every diff, then stops before the first write. Nothing reaches your project, your vault, or `~/.kerstel`. |
| `--yes` | Takes every suggestion and every default, asking nothing. |
| `--scope <name>` | Use this scope instead of the one derived from your `package.json` name. Lowercase letters, digits, `.`, `_` and `-`. |
| `--global KEY[,KEY]` | Put those keys in the `global` scope without asking. |
| `--keep KEY[,KEY]` | Leave those keys as plaintext without asking. |
| `--non-interactive` | Never asks. Applies the suggested plan like `--yes`, and on any question no flag can answer — a value this machine is missing, for instance — exits `2` naming the flag that would have supplied it. |
| `--from-stdin` | Reads `{"KEY": "value"}` JSON from stdin for references whose values this vault does not have yet. Pair it with `--non-interactive` in a script. |

When the same key appears in several files, the highest-precedence one is stored: `.env.<x>.local`, then `.env.local`, then `.env.<x>`, then `.env`. Every occurrence points at that single reference.

## Secrets

| Command | What it does |
| --- | --- |
| `kerstel set <scope>/<KEY> [--value <value>]` | Store or overwrite a secret. Without `--value`, the value must be piped on stdin; a terminal with nothing piped in fails rather than waiting. |
| `kerstel get <scope>/<KEY> [--reveal]` | Read a secret. Prints a masked value unless `--reveal` is given. |
| `kerstel ls [--scope <scope>]` | List stored references, optionally for one scope. Values are never listed. |
| `kerstel rm <scope>/<KEY> --yes` | Remove a secret. `--yes` is required; there is no interactive confirmation. |

## Running code

| Command | What it does |
| --- | --- |
| `kerstel run -- <command>` | Resolve every reference in the current environment, then run the command with real values injected. Works for anything that cannot load the runtime hook. |
| `kerstel exec -- <command>` | Run the command with the hook wired in and the references left untouched, so each one resolves lazily on the read. See above. |
| `kerstel resolve kerstel://<scope>/<KEY>` | Print one resolved value. Useful in scripts. |

## Daemon and diagnostics

| Command | What it does |
| --- | --- |
| `kerstel daemon start` | Start the resolver daemon in the background. |
| `kerstel daemon stop` | Stop it. |
| `kerstel daemon status` | Report whether it is running and where its socket is. |
| `kerstel daemon serve` | Run the daemon in the foreground. Used by `start`; handy for debugging. |
| `kerstel doctor` | Diagnose this machine: home, vault path and secret count, token, credential store backend, socket, whether the hook assets are installed, and whether the daemon is running. Run inside a project with a `package.json`, it adds a **Project** section: the project root, its scope, the runtime and package manager, how many of the wrappable scripts are wired through `kerstel exec`, how many of the references in your `.env*` files this vault can resolve, and any env file it could not read. |
| `kerstel --version` | Print the version, such as `0.1.0`. |
| `kerstel uninstall` | Remove Kerstel from this machine. For every project `init` set up, it rewrites each `kerstel://` reference back to the value in the vault, unwraps the `package.json` scripts, and turns the `.gitignore` note back into `.env` and `.env.*` lines. It opens the vault without creating anything, so on a machine with no Kerstel data it says so and only removes the binary. Otherwise it shows every diff with values masked and asks once, defaulting to no; before writing anything it checks that every planned file is writable, and if one is not, names it and changes nothing. Once every file is written it stops the daemon and deletes `~/.kerstel`, the vault key, and the binary, in that order — the binary only when it is the compiled `kerstel`, not when running from source. It refuses if a project folder is gone, a reference cannot be resolved, or a secret is used by no project, and names each one; save those with `get --reveal`, then pass `--force`. `--dry-run` prints the plan and changes nothing; `--yes` skips the question but never implies `--force`. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `KERSTEL_HOME` | Directory for the vault, socket, and hook assets. Defaults to `~/.kerstel`. |
| `KERSTEL_KEYCHAIN_BACKEND` | Force a credential store backend. Set to `file` for a `0600` key file instead of the OS store. Kerstel warns whenever this fallback is in use. |

## Exit codes

Commands exit `0` on success and non-zero on any failure. Errors go to stderr and name the fix, usually `kerstel doctor`. Plaintext values never appear in error output.
