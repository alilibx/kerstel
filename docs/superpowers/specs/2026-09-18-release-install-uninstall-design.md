# Release pipeline, installer, and uninstall: design (plan 5)

**Status:** approved in brainstorming, awaiting implementation plan (plan 5 of 5)
**Date:** 2026-09-18
**Parent spec:** [2026-09-17-kerstel-secrets-manager-design.md](2026-09-17-kerstel-secrets-manager-design.md) §8 (`uninstall`) and §11 (CI, `install.sh`)
**Ships:** Kerstel 0.1.0

## 1. Goal

Anyone on macOS or Linux can install Kerstel with one command, and remove it with one command without losing a secret. The maintainer cuts a release by pushing a tag. This is the last work before 0.1.0.

## 2. Decisions

| Question | Decision |
| --- | --- |
| Release trigger | Push a `v*` tag. A workflow builds, smoke-tests, and publishes. |
| Platforms in 0.1.0 | macOS arm64 and x64, Linux x64 and arm64 (glibc). Windows moves to a later release. |
| Install location | `~/.local/bin/kerstel`. No `sudo`, no profile edits. |
| `uninstall` scope | The whole machine: every registered project, then all Kerstel data, then the binary. |
| Restore source | Current vault values, not the encrypted backups. |

Out of scope: Windows binaries and `install.ps1`, musl (Alpine) builds, macOS notarization, Homebrew, and auto-update.

## 3. `kerstel --version`

A new top-level flag (and `kerstel version`) prints the version from `packages/cli/package.json`, imported at build time so the compiled binary carries it. Output is the bare version, `0.1.0`, so scripts can compare it.

## 4. Release pipeline

New workflow `.github/workflows/release.yml`, triggered by a pushed tag matching `v*`.

### 4.1 Verify

Fails the run before any build when:

- the tag without its `v` differs from `version` in any workspace `package.json`;
- `CHANGELOG.md` has no `## <version> (<YYYY-MM-DD>)` heading for it (an `(unreleased)` heading does not count).

A pre-release tag such as `v0.1.0-rc.1` is checked against its base version (`0.1.0`), also accepts an `(unreleased)` heading, and publishes as a GitHub pre-release. It lets the whole pipeline be exercised before the real tag.

### 4.2 Build

One Ubuntu job builds the hook, then cross-compiles four binaries with `bun build --compile --target=<target>`:

| Asset | Bun target |
| --- | --- |
| `kerstel-darwin-arm64` | `bun-darwin-arm64` |
| `kerstel-darwin-x64` | `bun-darwin-x64` |
| `kerstel-linux-x64` | `bun-linux-x64` |
| `kerstel-linux-arm64` | `bun-linux-arm64` |

It writes `SHA256SUMS` in the `sha256sum` format (`<hash>  <asset>`) and uploads the five files as a workflow artifact.

### 4.3 Smoke test

A matrix job runs each binary on its native runner (`macos-14` arm64, `macos-15-intel` x64, `ubuntu-latest` x64, `ubuntu-24.04-arm` arm64; if GitHub has retired an image by implementation time, use its current replacement for the same architecture). The job does not check out the repository, so no source path can make a broken binary pass. With `KERSTEL_HOME` in a temp directory and `KERSTEL_KEYCHAIN_BACKEND=file`, each binary must:

1. print the tag's version from `kerstel --version`;
2. round-trip a value with `kerstel set` and `kerstel get --reveal`;
3. start a Node script through `kerstel exec --` whose environment holds a `kerstel://` reference, and have the script print the stored value.

Step 3 proves the bundled hook works on a machine that did not build it.

### 4.4 Publish

Runs only when all four smoke tests pass. It creates the GitHub Release for the tag, attaches the four binaries and `SHA256SUMS`, and uses that version's `CHANGELOG.md` section as the release notes.

### 4.5 Post-release check

A final matrix job runs the real one-liner, `curl -fsSL https://kerstel.dev/install.sh | bash`, on the same four runners and checks `kerstel --version`. It fails loudly if the published installer and release disagree, but it does not unpublish anything.

## 5. `install.sh`

The source is `apps/website/src/static/install.sh`, published to `https://kerstel.dev/install.sh` with the site. The one-liner stays `curl -fsSL https://kerstel.dev/install.sh | bash`.

### 5.1 Steps

1. **Platform.** `uname -s` and `uname -m` map to one of the four assets. On macOS, when `sysctl -n sysctl.proc_translated` returns `1` (a shell running under Rosetta), the arm64 binary is chosen. Any other platform, including Windows, musl, and 32-bit, exits 1 with "not supported yet" and a link to build from source.
2. **Version.** Latest release by default, through `https://github.com/alilibx/kerstel/releases/latest/download/`. `KERSTEL_VERSION=0.1.0` pins one, through `.../releases/download/v0.1.0/`.
3. **Download** the binary and `SHA256SUMS` into a `mktemp -d` directory, removed on exit by a `trap`.
4. **Verify** the binary's line in `SHA256SUMS` with `shasum -a 256` (macOS) or `sha256sum` (Linux). A missing tool, a missing line, or a mismatch aborts before anything is installed.
5. **Install** into `${KERSTEL_INSTALL_DIR:-$HOME/.local/bin}`: `chmod 755`, then `mv` over any existing copy, so an upgrade is one atomic step.
6. **Check** by running the installed `kerstel --version`.
7. **Next steps.** When the install directory is not on `PATH`, print the one line to add for the detected shell (`~/.zshrc`, `~/.bashrc`, or fish's `fish_add_path`), without editing anything. Then suggest `kerstel doctor` and `kerstel init`.

### 5.2 Rules

- The body is one function, called on the last line, so a truncated download cannot run a partial script.
- `set -euo pipefail`. No `sudo`. It never reads or writes `~/.kerstel`.
- Re-running upgrades in place.
- `KERSTEL_DOWNLOAD_BASE` overrides the download URL. It exists for tests and mirrors, and the script prints it when set.

### 5.3 Site changes

The landing page's "Binaries are not published yet" note is removed. Getting started documents install, upgrade (re-run the one-liner), pinning a version, and the `PATH` hint.

## 6. `kerstel uninstall`

`kerstel uninstall [--dry-run] [--yes] [--force]`

### 6.1 Plan (read only)

Open the vault without creating anything: no home, hook, token, or key is written, so `--dry-run` and every refusal leave the machine as they found it. With no vault on disk, there is nothing to restore; if the credential store still holds a key (`exists()`, read-only), a real run deletes that orphaned key. For each project in the `projects` table:

- **Reachable** when its `root_path` exists and holds a `package.json`. Otherwise it is **unreachable**.
- **`.env` files.** Discover them as `init` does. Every value that parses as a `kerstel://` reference is replaced with the secret's current vault value, written in the line's original quote style verbatim whenever the parser reads that back to the same value, and through `init`'s `setValue` rendering only when it cannot. A reference the vault cannot resolve is left as it is and recorded as **unresolvable**. Files are rewritten in place: comments, order, quoting style, and line endings stay intact.
- **`package.json`.** A script that starts with exactly `kerstel exec -- ` loses that prefix. Anything else, including a script the user wrote that calls `kerstel`, is left alone. Line endings and the final newline are preserved, as in `wirePackageJson`.
- **`.gitignore`.** When it contains the note `init` writes (`# Kerstel: .env files hold references, safe to commit`), that line is replaced with two lines, `.env` and `.env.*`, because the files are about to hold plaintext again.

Then compute **unused secrets**: every `scope/KEY` in the vault that no reachable project's `.env` files refer to. These include `global` keys used by repositories that never ran `init`, and keys added with `kerstel set` alone.

Finally compute **backup-only values**. `init` collapses a key defined in several env files, or assigned twice with different values in one file, into one vault entry; the other values survive only in its encrypted backup, which uninstall deletes with the key that opens it. For each reachable project, decrypt its latest backup in memory (never to disk) with the vault data key, and record every key with cross-file conflicts (`collectKeys(...).conflicts`) or with differing values inside one backed-up file, by key, file names, and backup directory. A project with no backup contributes nothing.

### 6.2 Show and confirm

- Print every file diff with values masked, using the display masking `init` uses. No value is printed.
- List by name every unreachable project (with its recorded path), unresolvable reference, unused secret, and backup-only value (key, files, and backup directory, never the value).
- `--dry-run` exits 0 here, having written nothing, whether or not anything would be lost.
- **Loss gate.** If any of those four lists is non-empty, stop with exit 1 unless `--force` is passed. The message names each item and says to save values first with `kerstel get <scope>/<KEY> --reveal`.
- Ask once, defaulting to **no**: "Restore these files and delete Kerstel from this machine?" `--yes` answers yes. `--yes` never implies `--force`. Without a terminal and without `--yes`, exit 2.

### 6.3 Apply

1. Write every planned file. On the first failure, stop, exit 1, name the file, and list which files were already written. Nothing below runs.
2. Stop the daemon if it is running.
3. Delete `~/.kerstel` (`KERSTEL_HOME`): the vault, backups, hook, token, and socket.
4. Delete the data key with the credential-store backend the vault was opened with. It goes after the home so a failure here leaves a harmless orphaned key rather than a vault no key can open.
5. Delete the binary, only when running as the compiled executable (`process.execPath`'s file name is `kerstel` and the process is not the `bun` runtime). Otherwise print where the binary is.
6. Print each restored project, and a warning that its `.env` files now hold plaintext and must stay out of git. For each restored `.env` file that `git -C <root> ls-files` reports as tracked, name it and say to run `git rm --cached <file>` before the next commit, since a `.gitignore` entry does not untrack it. Without git, or outside a repository, only the generic warning is printed.

Between steps 2 and 3, wait (up to 5 seconds) for the daemon to stop answering before deleting the home.

## 7. Testing

- **`--version`:** unit test against `package.json`.
- **Release workflow:** the verify step is a script (`scripts/release-verify.ts`) with unit tests for a matching tag, a mismatched tag, an `(unreleased)` heading, and a missing heading. The workflow is otherwise proven by running it on a pre-release tag (`v0.1.0-rc.1`) before `v0.1.0`.
- **`install.sh`:** `shellcheck` in CI. A Bun test runs the real script against a local fake release (a directory of stub binaries and `SHA256SUMS`, served through `KERSTEL_DOWNLOAD_BASE=file://...`), with `uname` and `sysctl` shimmed on `PATH`. Cases: clean install, upgrade over an existing copy, checksum mismatch installs nothing, unsupported platform, Rosetta picks arm64, and the `PATH` hint.
- **`uninstall`:** in a temp home with the file backend. Cases: multi-project byte-exact restore (CRLF, quoted values, comments), script unwrapping that leaves user-written `kerstel` scripts alone, the `.gitignore` swap, refusal on an unreachable project, on an unresolvable reference, on unused secrets, and on a backup-only value (cross-file and same-file), `--force` past each, `--dry-run` writes nothing, `--yes` without `--force` still refuses on loss, a failed file write deletes nothing, original quoting survives a round trip, a git-tracked `.env` gets the `git rm --cached` warning, and the real `init` followed by `uninstall --yes --force` on a gnarly fixture restores every file without a conflicting duplicate byte for byte.
- **Compiled binary (e2e):** `init` then `uninstall` on a scratch project outside the repo restores the original `.env` values and removes `KERSTEL_HOME`.

## 8. Docs and tracking

- CLI page and README: `--version`, `uninstall`, and install instructions.
- `CHANGELOG.md`: lines under 0.1.0 for `--version`, `uninstall`, the installer, and the binaries.
- `ROADMAP.md`: tick the release binaries, `install.sh`, and `uninstall`. (Windows already moved to "Later" in the PR that added this spec.)
