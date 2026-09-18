---
title: CLI reference
description: Every Kerstel command, what it does, and the flags it takes.
section: docs
order: 2
---
# CLI reference

<p class="lede">All commands take a reference in the form <code>&lt;scope&gt;/&lt;KEY&gt;</code>, where scope is <code>global</code> or a project name.</p>

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
| `kerstel resolve kerstel://<scope>/<KEY>` | Print one resolved value. Useful in scripts. |

## Daemon and diagnostics

| Command | What it does |
| --- | --- |
| `kerstel daemon start` | Start the resolver daemon in the background. |
| `kerstel daemon stop` | Stop it. |
| `kerstel daemon status` | Report whether it is running and where its socket is. |
| `kerstel daemon serve` | Run the daemon in the foreground. Used by `start`; handy for debugging. |
| `kerstel doctor` | Diagnose this machine: home, vault path and secret count, token, credential store backend, socket, whether the hook assets are installed, and whether the daemon is running. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `KERSTEL_HOME` | Directory for the vault, socket, and hook assets. Defaults to `~/.kerstel`. |
| `KERSTEL_KEYCHAIN_BACKEND` | Force a credential store backend. Set to `file` for a `0600` key file instead of the OS store. Kerstel warns whenever this fallback is in use. |

## Exit codes

Commands exit `0` on success and non-zero on any failure. Errors go to stderr and name the fix, usually `kerstel doctor`. Plaintext values never appear in error output.
