---
title: Security model
description: What Kerstel protects, what it does not, how values are encrypted, and where plaintext can appear.
---
# Security model

<p class="lede">Kerstel moves your secrets out of the files on your disk. It does not stop a program you run from asking for them. This page says exactly where that line falls.</p>

## The boundary, first

**Any program running as your user account can read every secret in your vault.** That is the honest statement of today's boundary, and it is worth reading before anything else on this page.

Nothing here needs a hooked process or a wired project. A program running as you can:

- run `kerstel get <scope>/<KEY> --reveal`, which prints the value and needs no prompt;
- read `~/.kerstel/session.token` and ask the resolver daemon for any key over its socket;
- on macOS, ask the Keychain for the vault's data key through the same `security` tool Kerstel uses, and get it without a prompt, because the item's access list trusts that tool.

The `0700` home directory, the `0600` socket and token file, and the OS credential store all keep *other users on the machine* out. None of them keeps *you* out, and a malicious `postinstall` script, a compromised editor extension, or a coding agent you gave shell access runs as you.

So Kerstel is worth having for a specific, common class of leak, and not for others:

| It closes | It does not close |
| --- | --- |
| A secret sitting in plaintext in `.env` on disk | A program running as you asking for the secret |
| That file reaching git history, a backup, or a sync folder | Malware that already runs code on your machine |
| A tool or agent that **reads files** finding credentials | A tool or agent you let **execute** |

That is the level Kerstel ships today. The [roadmap](/roadmap) calls the next one access gating: the daemon already sees which process asks for which key, and the plan is an approval prompt for one it does not recognise.

## What is protected

No plaintext secret sits in a project file. Your `.env`, `.env.local`, and their variants hold references of the form `kerstel://<scope>/<KEY>`. Reading a file, grepping the repo, committing by mistake, or syncing the folder to a backup service yields references and nothing else.

The values live in one vault on your machine, at `~/.kerstel/vault.db`. Kerstel has no account, collects no telemetry, and listens on no network port.

The only network traffic is the update check and download against GitHub Releases, or the mirror named by `KERSTEL_RELEASES_URL`. That request carries nothing about your vault or your secrets, and nothing about you beyond what any web request carries: your IP address, and for the download the platform in the binary's filename. Only `kerstel update`, `kerstel --version` (or `kerstel version`) on a terminal, and `kerstel doctor` make it. Every other command, the runtime hook, and the resolver daemon never touch the network.

## Encryption at rest

Every value is encrypted with AES-256-GCM under a fresh random 96-bit nonce. The authentication tag is verified on every read, so a tampered ciphertext fails loudly instead of decrypting to garbage.

The 256-bit data key is generated on first run and stored in your operating system's credential store: the Keychain on macOS, Secret Service on Linux. Windows is not supported yet.

The key is never written to the vault file, never logged, and never printed. It is never replaced by accident either: a new key is minted only on a machine with no vault sealed with one, and a credential store that fails to answer counts as holding a key, so you get an error naming the store rather than a fresh key written over the real one.

**The exception to "in your credential store" is the key file.** On a machine with no Secret Service provider, or with `KERSTEL_KEYCHAIN_BACKEND=file`, the key is a base64 file at `~/.kerstel/vault.key` with `0600` permissions. Base64 is not encryption: anything that can read that file has your vault. `kerstel doctor` reports which store is in use and warns while it is the file.

Kerstel reaches the credential store through the operating system's own tool, `security` or `secret-tool`. It runs that tool only from a fixed list of system directories, and only when the directory and the file are owned by root and writable by nobody else. It never looks on `PATH`: package managers put `node_modules/.bin` first there, so a dependency could otherwise ship a fake `security` and receive the data key.

## The daemon, the token, and the hook

The resolver daemon unlocks the vault once and answers over a Unix socket inside the Kerstel home. Every request carries a session token, which the daemon mints fresh each time it starts and deletes when it stops. The token lives only in a `0600` file: a wired script's environment carries that file's *path*, never the token, so nothing a child process inherits, prints in a `console.log(process.env)`, or leaves in a crash report unlocks the vault.

The daemon is started with a small allowlisted environment of its own and from `~/.kerstel` rather than your project, so neither a `BUN_OPTIONS` set in your shell nor any env file can run code in, or reconfigure, the process holding the vault key. `kerstel doctor` warns when `BUN_OPTIONS` is set, because the one-shot commands still honour it.

Kerstel's own `KERSTEL_*` settings are never taken from the project it is protecting. The binary is a Bun runtime, so it loads the working directory's `.env`, and that file is committed by design; a cloned repository could otherwise point your vault at a directory inside itself or force the weaker key file. Any `KERSTEL_*` an env file there names is dropped before a command reads it, and named on stderr.

## Supply chain

From their default source, GitHub Releases, the installer and `kerstel update` download over TLS and verify the release checksum before writing anything, and the update is staged beside the target and renamed into place. Point either at a mirror with `KERSTEL_RELEASES_URL` or `KERSTEL_DOWNLOAD_BASE` and that first guarantee is yours to keep: a `http://` mirror is accepted today, and it serves both the binary and the checksum, so anyone on the path can replace the pair and the verification still passes. Use `https://`. Requiring it is [issue #50](https://github.com/alilibx/kerstel/issues/50). The checksums are published alongside the binaries, which proves the download arrived intact but not who built it: whoever can alter a release can forge both. Signing them is [issue #49](https://github.com/alilibx/kerstel/issues/49).

Package managers put `node_modules/.bin` ahead of `PATH` when they run a script, and `kerstel exec` is what `init` writes into your scripts. A dependency declaring a `bin` named `kerstel` would therefore run in place of Kerstel, without a `postinstall` and without ever being imported. `kerstel init` and `kerstel exec` refuse when such a file exists in the project or a parent directory, and `kerstel doctor` reports it as a problem. `init` and `doctor` run from your shell, where that directory is not on `PATH`, so they are the authoritative checks; the one inside `exec` catches a bin that stays in place, not a shim that deletes itself before delegating.

## Where plaintext appears

Plaintext leaves the vault in five places:

1. **Inside your app's process**, when code reads `process.env.SOME_KEY` and the hook resolves the reference.
2. **In the environment of a child process**, either one started by `kerstel run -- <command>`, or one spawned by a process already running under the hook. Building a child's environment resolves *every* reference in it, not only the ones the app read, so a `git` call from a file watcher hands that child the whole set. Same-user programs can read it from `ps -E` or `/proc`.
3. **On your terminal**, when you ask with `kerstel get <scope>/<KEY> --reveal`.
4. **On your terminal**, when `kerstel resolve kerstel://<scope>/<KEY>` prints a value to stdout.
5. **Back in your `.env` files**, when `kerstel uninstall` restores them. That is the point of the command; it warns afterwards, and names any restored file git already tracks.

Plaintext never appears in log output, error messages, or audit rows. One exception exists in `kerstel init`: its overview prints values it classifies as configuration, such as `PORT=3000`. Today that classification is by name, so a value under a `PUBLIC_`, `VITE_` or `NEXT_PUBLIC_` prefix is printed in full even when it looks like a credential, which reaches terminal scrollback and CI logs. Everything else is shown only as its length.

## Out of scope

Kerstel does not defend against an attacker with root, a compromised OS credential store, code running as your user account, or malicious code running after it has been granted a secret.

## Read more

The full threat model and architecture are in the [design spec on GitHub](https://github.com/alilibx/kerstel/blob/main/docs/superpowers/specs/2026-09-17-kerstel-secrets-manager-design.md). Security issues are best reported through [GitHub](https://github.com/alilibx/kerstel/issues).
