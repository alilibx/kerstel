---
title: CLI reference
description: Every Kerstel command, what it does, and the flags it takes.
section: docs
order: 2
---
# CLI reference

<p class="lede">Every command that names a secret takes a reference in the form <code>&lt;scope&gt;/&lt;KEY&gt;</code>, where scope is <code>global</code> or a project name.</p>

`ks` works everywhere `kerstel` does — it's a shortcut for the same binary, installed by `install.sh` alongside `kerstel`. Every command below works under either name.

## Setting up a project

| Command | What it does |
| --- | --- |
| `kerstel init [--yes] [--dry-run]` | Show every `.env` variable grouped by where it suggests putting it, then walk through **"Look right?"** (accept every suggestion, change some from a checklist, or go through them one by one), an optional `.gitignore` question, and **"Apply these changes?"** (apply, show the full diff first, or cancel). Once applied: store each value in the vault, rewrite the files with references, and wire the runtime hook into your scripts through a launcher it writes at `.kerstel/exec.cjs`: every command becomes `node .kerstel/exec.cjs -- <command>`. Commit the launcher with `package.json`. On your machine it runs `kerstel exec`; on a deploy host with no Kerstel it prints one line and runs the command unchanged, so `npm run build` works everywhere (see [Deploying](https://kerstel.dev/docs/deploying)). A re-run rewrites a launcher that is out of date or edited, converts scripts wired by an older Kerstel (`kerstel exec -- ...`), and warns when `.gitignore` hides `.kerstel/`. A script made of several commands (`node copy.mjs && next dev`) is wired one command at a time, with the wrapper placed after any leading `NAME=value` words, so `NODE_ENV=production next start` becomes `NODE_ENV=production node .kerstel/exec.cjs -- next start`; a re-run finishes a script wired only in part. Commands that never run JavaScript (`rm`, `echo`, `mkdir`, and the like) are left alone. A script is skipped, with the reason named, when it changes directory (`cd`), uses shell control (subshells, backticks, `if`, `export`), redirects (`>`, `<`, `&`), has an unbalanced quote, or has no command to wire. Run it from the project root; it needs a readable `package.json`. |
| `kerstel move [KEY...] [--to global\|project\|plaintext] [--yes] [--replace] [--allow-tracked]` | Change where a key lives after `init`: this project's vault, the vault shared by all your projects, or plain text in the env file. With no arguments it lists every key and where it lives now, asks which to move and where, previews the change with values shown only as their length, and asks **Apply?** (default No). With key names and `--to` it asks nothing but Apply?, and `--yes` answers that. Every env file that defines the key is rewritten, after an encrypted backup; if one changed since it was read, it refuses and changes nothing. A project copy left unused is removed from the vault and saved in the backup; a shared (`global`) copy is never removed. If the destination already holds a different value it asks which one stays; the direct form refuses unless `--replace`. Writing a value into a file git tracks or does not ignore warns, and the direct form refuses unless `--allow-tracked`. A key whose reference the vault does not hold is named and skipped, not offered (`kerstel init` stores it first). Moving to plain text, a value with no plain-text spelling that fits a covered line's own quoting is left in the vault and named, rather than written in a form that would change it. Without a terminal it needs key names, `--to` and `--yes`. |
| `kerstel exec -- <command>` | Run one command with the runtime hook wired in. It resolves nothing itself: it sets `KERSTEL_SOCKET`, `KERSTEL_TOKEN_FILE` (the path of the session token file, never the token) and `KERSTEL_HOOK_DIR`, appends `--require <the hook>` to `NODE_OPTIONS`, and adds `--preload=<the hook>` for a `bun` or `bunx` command, which `NODE_OPTIONS` does not reach. The launcher `init` writes into your scripts calls it when Kerstel is on `PATH`, never from `node_modules/.bin`. If the command is not on `PATH` (or, given as a path, does not exist), it says so before opening the vault or starting the daemon and, in a project, names the install command for your package manager (`bun install`, `npm install`, `pnpm install`, or `yarn install`), then exits `127` as a shell would. |

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
| `kerstel run -- <command>` | Resolve every reference in the current environment, then run the command with real values injected. Works for anything that cannot load the runtime hook. A command that is not on `PATH` gets the same message and exit `127` as with `exec`. |
| `kerstel exec -- <command>` | Run the command with the hook wired in and the references left untouched, so each one resolves lazily on the read (under Bun, also once at startup, so `Bun.env` sees the value). See above. |
| `kerstel resolve kerstel://<scope>/<KEY>` | Print one resolved value. Useful in scripts. |

## Daemon and diagnostics

| Command | What it does |
| --- | --- |
| `kerstel daemon start` | Start the resolver daemon in the background. |
| `kerstel daemon stop` | Stop it. |
| `kerstel daemon status` | Report whether it is running and where its socket is. |
| `kerstel daemon serve` | Run the daemon in the foreground. Used by `start`; handy for debugging. |
| `kerstel doctor [--verbose]` | Diagnose this machine, grouped under **This machine** (version, vault, daemon, runtime hook, file permissions, a warning when `BUN_OPTIONS` is set since Kerstel's own process honours it, and whether `ks` resolves to this binary; an idle daemon is shown as information, since it starts on its own when a script needs a secret; the version row is a warning with `Fix: kerstel update` when a newer release exists, and information when the release page could not be reached) and, inside a project with a `package.json`, **This project** (how many of the wrappable scripts are wired through `kerstel exec`, naming any that are only partly wired, any still in the old `kerstel exec` form, and any `init` skips with the reason; whether `.kerstel/exec.cjs` is current, with a problem when it is missing and a warning when it is out of date, edited, or not Kerstel's; a problem when `node_modules/.bin` here or in a parent directory holds a `kerstel` or `ks` that would run in place of Kerstel, how many references in your `.env*` files this vault can resolve, and any env file it could not read). Every warning or problem prints a `Fix:` line naming the command that resolves it. `--verbose` adds the paths and permission modes behind each check: home, vault, token, socket, and hook. Exits `1` if any check reports a problem, `0` otherwise — warnings alone still exit `0`. |
| `kerstel update [--check]` | Install the latest release over this binary. It reads the newest version from GitHub Releases, downloads the binary for this platform and the release's `SHA256SUMS`, verifies the checksum, runs the new binary once to confirm it reports that version, and only then swaps it into place. `ks` keeps working, since it links to the same file. If a resolver daemon is running it is stopped, so the next resolution starts the new version. On a terminal it draws a progress bar while the binary downloads and names each step; piped, it prints plain lines. It says so and exits `0` when you already have the latest release, and exits `1` when GitHub cannot be reached; a failed checksum or download installs nothing. `--check` only reports whether a newer release exists. Run from source there is no binary to replace, so `update` refuses; `--check` still works. |
| `kerstel --version` | Print the version, such as `0.1.0`. On a terminal it also checks GitHub and adds a second line on stderr: `Up to date.`, `0.1.1 is available. Run kerstel update.`, or `Could not check for updates.` Piped or redirected, it prints only the version and never touches the network. |
| `kerstel uninstall` | Remove Kerstel from this machine. For every project `init` set up, it rewrites each `kerstel://` reference back to the value in the vault, in the quoting the line had before `init` (falling back to a quoting that can hold the value only when that one cannot), unwraps the `package.json` scripts (both the launcher form and the older `kerstel exec` form), deletes `.kerstel/exec.cjs` when it is Kerstel's (a file without Kerstel's marker line is left alone and named), and turns the `.gitignore` note back into `.env` and `.env.*` lines. It opens the vault without creating anything, so on a machine with no vault it says so and removes only the binary and any vault key left orphaned in the credential store. Otherwise it shows every diff with values masked and asks once, defaulting to **No, keep Kerstel**; before writing anything it checks that every planned file is writable, and if one is not, names it and changes nothing. Once every file is written it stops the daemon and deletes `~/.kerstel`, the vault key, the binary, and every `kerstel` or `ks` link that points at that binary, in the binary's folder, the folder it was run from, and each folder on `PATH` — the binary and links only when running the compiled `kerstel`, not from source. A `ks` that is a real file or points elsewhere is left alone. It refuses, naming each one, if a project cannot be reached (its folder is gone, it has no `package.json`, or its `package.json` is not valid JSON), a reference cannot be resolved, a secret is used by no project, or a value exists only in an encrypted backup: a key that had different values in several `.env` files, or twice in one, which `init` stored once, found in any of its backups; or a value `move` saved in its backup (one it removed or replaced in the vault, or a plain value that lost to the vault's) that is now neither in the vault nor in a restored file. A backup it cannot decrypt counts too, since it may hold such a value. Save the secrets with `get --reveal`, recover any backup-only value from where it came from, then pass `--force`. Afterwards it warns that the `.env` files hold plaintext again, and names each one git already tracks, with the `git rm --cached` command to untrack it. With a custom `KERSTEL_HOME` on the macOS Keychain or Secret Service, it leaves the vault key in place, since every home on the machine shares that one key. If the credential store keeps the vault key (for example, you deny the Keychain prompt), it says so, leaves the binary, and exits 1; run it again to delete the key. `--dry-run` prints the plan and changes nothing; `--yes` skips the question but never implies `--force`. |
| `kerstel` (no command) or `kerstel --help` | List every command with a one-line description. Bare `kerstel` (or `ks`) also shows the banner; `--help` prints the same list without it. Both exit `0`. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `KERSTEL_HOME` | Directory for the vault, socket, and hook assets. Defaults to `~/.kerstel`. |
| `KERSTEL_KEYCHAIN_BACKEND` | Force a credential store backend. Set to `file` for a `0600` key file instead of the OS store. Kerstel warns whenever this fallback is in use. |
| `KERSTEL_RELEASES_URL` | Where `update`, `doctor`, and `--version` look for releases, instead of `https://github.com/alilibx/kerstel`. For mirrors and tests; it must serve the same `/releases/latest` redirect and `/releases/download/v<version>/` files as GitHub. It must be `https://` (or `http://` to `127.0.0.1` or `localhost`); anything else is refused, and `doctor` names it. `update` prints the mirror it uses. |

Set these in your shell or your shell profile, never in a project's env file. Kerstel is a Bun binary, so it loads the `.env` of the directory you run it in — and in Kerstel's model that file is committed, which would let a repository you cloned choose your vault's location or your credential store. So if an env file here **names** a `KERSTEL_*` variable, Kerstel ignores that variable and says so on stderr.

The test is the name, not the value, and that matters in one case: a variable you set yourself is ignored too when the project's env file happens to name it, and Kerstel falls back to its default. Take the line out of that file, or run from elsewhere. Matching on the value instead would look kinder but cannot be done safely — it would mean reproducing exactly what Bun's loader puts in the environment, including `$VAR` expansion and escape decoding, and every difference between the two would be a way to slip a setting past the check. The resolver daemon is started in `~/.kerstel` rather than your project or your home directory, so no env file reaches it at all.

## Exit codes

Commands exit `0` on success and non-zero on any failure. Errors go to stderr and name the fix, usually `kerstel doctor`. Plaintext values never appear in error output.
