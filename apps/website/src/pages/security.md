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

That is the level Kerstel ships today. The [roadmap](/roadmap) calls the next level access gating: the daemon already sees which process asks for which key, and the plan is an approval prompt for one it does not recognise.

## What is protected

No plaintext secret sits in a project file. Your `.env`, `.env.local`, and their variants hold references of the form `ks:<scope>` or `ks:<scope>/<KEY>`. Reading a file, grepping the repo, committing by mistake, or syncing the folder to a backup service yields references and nothing else.

The values live in one vault on your machine, at `~/.kerstel/vault.db`. Kerstel has no account, collects no telemetry, and listens on no network port.

Kerstel is offline apart from the update check, and sync if you turn it on. The update check and download go to GitHub Releases, or the mirror named by `KERSTEL_RELEASES_URL`. That request carries nothing about your vault or your secrets, and nothing about you beyond what any web request carries: your IP address, and for the download the platform in the binary's filename. Only `kerstel update`, `kerstel --version` (or `kerstel version`) on a terminal, and `kerstel doctor` make it. Sync talks only to the server you set it up with, and sends it only ciphertext; see **Sync** below. The runtime hook and the resolver daemon never touch the network.

## Encryption at rest

Every value is encrypted with AES-256-GCM under a fresh random 96-bit nonce. The authentication tag is verified on every read, so a tampered ciphertext fails loudly instead of decrypting to garbage.

The 256-bit data key is generated on first run and stored in your operating system's credential store: the Keychain on macOS, Secret Service on Linux. Windows is not supported yet.

The key is never written to the vault file, never logged, and never printed. It is never replaced by accident either: a new key is minted only on a machine with no vault sealed with one, and a credential store that fails to answer counts as holding a key, so you get an error naming the store rather than a fresh key written over the real one.

**The exception to "in your credential store" is the key file.** On a machine with no Secret Service provider, or with `KERSTEL_KEYCHAIN_BACKEND=file`, the key is a base64 file at `~/.kerstel/vault.key` with `0600` permissions. Base64 is not encryption: anything that can read that file has your vault. When Kerstel falls back to the file because no credential store answered, every command that opens the vault warns about it on stderr, naming the file; setting `KERSTEL_KEYCHAIN_BACKEND=file` yourself is the one way to say it is intended and silence the warning. `kerstel doctor` also reports which store is in use. The first command to create a key says so, and where it put it.

Kerstel reaches the credential store through the operating system's own tool, `security` or `secret-tool`. It runs that tool only from a fixed list of system directories, and only when the directory and the file are owned by root and writable by nobody else. It never looks on `PATH`: package managers put `node_modules/.bin` first there, so a dependency could otherwise ship a fake `security` and receive the data key.

## The daemon, the token, and the hook

The resolver daemon unlocks the vault once and answers over a Unix socket inside the Kerstel home. Every request carries a session token, which the daemon mints fresh each time it starts and deletes when it stops. The token lives only in a `0600` file: a wired script's environment carries that file's *path*, never the token, so nothing a child process inherits, prints in a `console.log(process.env)`, or leaves in a crash report unlocks the vault.

The daemon is started with a small allowlisted environment of its own and from `~/.kerstel` rather than your project, so neither a `BUN_OPTIONS` set in your shell nor any env file can run code in, or reconfigure, the process holding the vault key. `kerstel doctor` warns when `BUN_OPTIONS` is set, because the one-shot commands still honour it.

Kerstel's own `KERSTEL_*` settings are never taken from the project it is protecting. The binary is a Bun runtime, so it loads the working directory's `.env`, and that file is committed by design; a cloned repository could otherwise point your vault at a directory inside itself or force the weaker key file. Any `KERSTEL_*` an env file there names is dropped before a command reads it, and named on stderr.

## Sync

Sync is off until you run `kerstel sync setup <url>`, and it talks only to a `kerstel-server` you choose: an `https://` URL, or `http://` to this machine. Values are encrypted on your device with a sync key that only your devices hold. A device already in the vault seals it to each new one when you pair them, and you confirm the new device by its key fingerprint first. The daemon never syncs and never opens a network connection.

| The server sees | The server never sees |
| --- | --- |
| A random vault ID | Scope names, key names, values |
| Each device's random ID and public keys | Device names and hostnames |
| How many records a vault holds, their sizes, and when they change | Project paths, `.env` contents, backups |
| Opaque record IDs, and which of them are deletions | Which record is which key |
| The IP address of each request | The sync key or any data key |

What a hostile server, or anyone who takes it over, can do:

| Attack | Result |
| --- | --- |
| Read or change a record | Fails. Each record is AES-256-GCM with the vault ID, record ID and key epoch as associated data, so a changed or moved record fails to decrypt and is reported. |
| Add a device of its own | Fails. Adding a device takes a signature from a device already in the vault, and the sync key is sealed only to a device you confirmed. |
| List a key of its own for a device, so that removing a device seals the new sync key to the server | Fails. Each device's name is sealed with the sync key together with the public keys it was added with, and the new key is sealed only to devices whose listed keys match. `kerstel sync devices` marks a device whose keys don't match. |
| Serve an old copy of a value | Partly detected. Each device refuses a vault revision lower than the highest it has seen, but the server could resend an older record under a new revision. The value it replaces is kept in the sync backup. |
| Withhold changes from one device | Not prevented. Sync stops making progress, and `kerstel doctor` shows when each device last synced. |
| Delete the vault | Possible. Every device still has its full local vault, and `kerstel sync setup` can upload it to a new server. |

Removing a device replaces the sync key, but the removed device already had every value. Rotate a secret at its provider if that device should no longer hold it.

## Supply chain

From their default source, GitHub Releases, the installer and `kerstel update` download over TLS and verify the release checksum before writing anything, and the update is staged beside the target and renamed into place. A mirror set with `KERSTEL_RELEASES_URL` or `KERSTEL_DOWNLOAD_BASE` must be `https://`, since a mirror serves both the binary and the checksum, and over plain HTTP anyone on the path could replace the pair. Both refuse any other address, naming the variable, and so does a download that redirects away from `https://`. Only `http://` to this machine (`127.0.0.1`, `localhost`) is allowed, for local mirrors and tests. `kerstel update` says which mirror it is using, and `install.sh` accepts a `KERSTEL_VERSION` only in the form `0.1.0`. The checksums are published alongside the binaries, which proves the download arrived intact but not who built it: whoever can alter a release can forge both. Signing them is [issue #49](https://github.com/alilibx/kerstel/issues/49).

Package managers put `node_modules/.bin` ahead of `PATH` when they run a script, and `kerstel exec` is what `init` writes into your scripts. A dependency declaring a `bin` named `kerstel` would therefore run in place of Kerstel, without a `postinstall` and without ever being imported. `kerstel init` and `kerstel exec` refuse when such a file exists in the project or a parent directory, and `kerstel doctor` reports it as a problem. `init` and `doctor` run from your shell, where that directory is not on `PATH`, so they are the authoritative checks; the one inside `exec` catches a bin that stays in place, not a shim that deletes itself before delegating.

## Where plaintext appears

Plaintext leaves the vault in six places:

1. **Inside your app's process**, when code reads `process.env.SOME_KEY` and the hook resolves the reference.
2. **In the environment of a child process**, either one started by `kerstel run -- <command>`, or one spawned by a process already running under the hook. Building a child's environment resolves *every* reference in it, not only the ones the app read, so a `git` call from a file watcher hands that child the whole set. Same-user programs can read it from `ps -E` or `/proc`.
3. **On your terminal**, when you ask with `kerstel get <scope>/<KEY> --reveal`.
4. **On your terminal**, when `kerstel resolve ks:<scope>/<KEY>` prints a value to stdout.
5. **In `kerstel ui`**, when you press `r` on a secret. The value replaces the dots on that row until your next key, and a `reveal` audit row is written first, as for `get --reveal`. The UI draws on the terminal's alternate screen, which is discarded on exit, so the value does not stay in your scrollback.
6. **Back in your `.env` files**, when `kerstel uninstall` restores them. That is the point of the command; it warns afterwards, and names any restored file git already tracks.

Plaintext never appears in log output, error messages, or audit rows. One exception exists in `kerstel init`: its overview prints values it classifies as configuration, such as `PORT=3000`. A name that says it is a credential wins over a `PUBLIC_`, `VITE_` or `NEXT_PUBLIC_` prefix, and a value with a known token prefix (`sk_`, `AIza`, `ghp_`, a JWT) is never printed, whatever its key is called. Neither is a URL with a password in it, a query parameter named like a credential (`token=`, `api_key=`, `sig=`, `auth=`), or a long path segment that mixes letters and digits, as webhook tokens do. Everything else is shown only as its length.

## Auditing a machine

`kerstel scan ~` lists every env file in your home folder and what it still holds in plain text: secrets in projects you haven't set up, backup copies left from before `init`, templates with real keys in them, and files git tracks. It reads each file to judge it but prints only counts, key names and line numbers, and it checks references against the vault by name, without the vault key. Its exit code is `1` when it finds a secret, so it can run on a schedule or in CI.

`kerstel audit` shows what Kerstel did with your secrets on this device: every reveal, every read by an app, and every change. Reveals come first. A reveal of a credential that is still the value that was shown comes with a hint to rotate it, in case you didn't make it yourself. Each row names the chain of programs that started the command or app and the project checkout it ran in. The chain is names only, so a program that wants to hide can fake it. Treat it as a clue, not proof. Rows hold key names, never values. They stay on this device and never sync, and the daemon deletes rows older than 90 days. `kerstel ui` shows the same log on its Audit screen. Its summary covers the last 7 days, and its rows go back through everything kept.

## Out of scope

Kerstel does not defend against an attacker with root, a compromised OS credential store, code running as your user account, or malicious code running after it has been granted a secret.

## Read more

The full threat model and architecture are in the [design spec on GitHub](https://github.com/alilibx/kerstel/blob/main/docs/superpowers/specs/2026-09-17-kerstel-secrets-manager-design.md). Security issues are best reported through [GitHub](https://github.com/alilibx/kerstel/issues).
