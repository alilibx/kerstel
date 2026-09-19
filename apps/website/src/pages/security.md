---
title: Security model
description: What Kerstel protects, how values are encrypted, where the key lives, and the boundary it draws today.
---
# Security model

<p class="lede">Kerstel protects secrets at the file level today and is built to add access-level protection next. This page says exactly what that means.</p>

## What is protected

No plaintext secret ever sits in a project file. Your `.env`, `.env.local`, and their variants hold references of the form `kerstel://<scope>/<KEY>`. Reading a file, grepping the repo, committing by mistake, or syncing the folder to a backup service yields references and nothing else.

The values live in a single vault on your machine at `~/.kerstel/vault.db`. No secret or vault data is ever sent anywhere. The only network traffic Kerstel makes is the update check and download against GitHub Releases (or the mirror named by `KERSTEL_RELEASES_URL`), and that request carries nothing about your vault or your secrets, and nothing about you beyond what any web request carries: your IP address and, for the download, the platform named in the binary's filename. Only `kerstel update`, `kerstel --version` (or `kerstel version`) on a terminal, and `kerstel doctor` make it; every other command, the runtime hook, and the resolver daemon never touch the network. Kerstel has no account, collects no telemetry, and listens on no network port: the daemon answers over a Unix socket inside `~/.kerstel`.

## Encryption at rest

Every value is encrypted with AES-256-GCM using a fresh random 96-bit nonce. The authentication tag is verified on every read, so a tampered ciphertext fails loudly instead of decrypting to garbage.

The 256-bit data key is generated on first run and stored only in your operating system's credential store:

| Platform | Store |
| --- | --- |
| macOS | Keychain |
| Linux | Secret Service (libsecret) |

The key is never written to the vault file, never logged, and never printed. Windows is not supported yet. On a Linux machine without a Secret Service provider, Kerstel falls back to a key file with `0600` permissions and warns you every time it does.

## Where plaintext appears

Plaintext leaves the vault in exactly four places:

1. Inside your app's process, when code reads `process.env.SOME_KEY` and the runtime hook resolves the reference.
2. In the environment of a child process started by `kerstel run -- <command>`, or spawned by a process already running under the hook.
3. On your terminal, only when you ask with `kerstel get <scope>/<KEY> --reveal`.
4. On your terminal, when you run `kerstel resolve kerstel://<scope>/<KEY>`, which prints the resolved value to stdout.

Plaintext never appears in log output, error messages, or audit rows.

## The boundary today

A process that runs code inside your project can read resolved values from `process.env`. That includes your app, its dependencies, and anything you launch through your package scripts. Kerstel does not try to stop code you chose to run from reading a secret you chose to give it.

This is file-level protection. It closes the most common leaks: agents and tools that read files, and secrets that end up in git history.

## What comes next

The resolver daemon already sees which process asks for which key. The next protection level uses that: an unrecognized process asking for a key triggers an approval prompt, the way macOS asks before an app reads a Keychain item. Allowlists and Touch ID or polkit for sensitive operations follow. The current design keeps resolution lazy and daemon-mediated so this layer can be added without changing how you wire a project.

## Out of scope

Kerstel does not defend against an attacker with root, a compromised OS credential store, or malicious code running after it has been granted a secret.

## Read more

The full threat model, architecture, and roadmap are in the [design spec on GitHub](https://github.com/alilibx/kerstel/blob/main/docs/superpowers/specs/2026-09-17-kerstel-secrets-manager-design.md).
