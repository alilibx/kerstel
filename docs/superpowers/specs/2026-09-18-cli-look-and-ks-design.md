# The `ks` shortcut and a friendlier CLI: design

**Status:** approved in brainstorming, awaiting implementation plan
**Date:** 2026-09-18
**Parent spec:** [2026-09-17-kerstel-secrets-manager-design.md](2026-09-17-kerstel-secrets-manager-design.md) §8 (CLI and wizard UX)
**Ships:** Kerstel 0.1.0. The release waits for this work.

## 1. Goal

Testing `v0.1.0-rc.2` on a real project showed that Kerstel works, but using it feels long-winded and plain. `kerstel` takes a while to type. `init` asks one bare question per variable (`API_KEY (20 chars, from .env) (project / global / plaintext) [project]`) without explaining that the bracketed word is a suggestion you can accept with Enter. `doctor` prints a list of paths.

This work makes Kerstel quick to type and pleasant to use, without changing what any command does to your files, vault, or keys.

## 2. Decisions

| Question | Decision |
| --- | --- |
| Short command | `ks`, a symlink next to `kerstel`. `kerstel` stays the real name. |
| Interactive UI | [`@clack/prompts`](https://github.com/bombshell-dev/clack), behind the existing `Prompter` interface. |
| Logo | The bird from the site icon, drawn in braille characters, beside the name and version. |
| `init` flow | Show every variable grouped by destination, then **Yes** / **Let me change some** / **One by one**. |
| Timing | In 0.1.0. The release waits. |

Out of scope: changing `set`'s `scope/KEY` syntax, colour themes, localisation, and anything the portal (0.2.0) will cover.

## 3. The `ks` shortcut

- `install.sh` installs `kerstel` as it does now, then creates `ks` in the same directory as a symlink to `kerstel`. One binary means an upgrade updates both names at once.
- **Never replace someone else's `ks`.** Before linking, the installer checks `command -v ks`. If it finds a `ks` that is not a symlink to the installed `kerstel`, it skips the link and prints `ks is already taken by <path>, so use kerstel`. If `<install dir>/ks` is already a symlink to `kerstel`, a re-run refreshes it.
- **Hints use the name you typed.** Every message that suggests a command (`Run ks doctor`) uses the invoked name: the basename of `process.argv[1]` when the process is the compiled binary and that name is `ks`, otherwise `kerstel`. One helper, `cliName()`, provides it.
- **Scripts keep the full name.** `init` still writes `kerstel exec -- ` into `package.json`. Teammates and CI may not have the shortcut.
- **`uninstall`** removes `<binary dir>/ks` when it is a symlink whose target is the binary being removed, and leaves anything else alone.
- **Docs.** The README and Getting started use `ks` as the everyday command. The CLI reference keeps `kerstel` and says `ks` works everywhere it does.
- **Release check.** The post-release `installer` job also runs `ks --version`.

## 4. The terminal look

A new module, `packages/cli/src/ui/`, owns every visual decision. Commands call it; none style their own output.

### 4.1 Theme

- Accent: the site's green, `#4ade80`, as 24-bit colour when the terminal advertises it (`COLORTERM=truecolor` or `24bit`), otherwise ANSI green. Plus dim, bold, red, and yellow.
- `NO_COLOR` (any non-empty value) turns every colour off. A stream that is not a TTY gets no colour either.
- Status symbols: `✓` (green) passed, `!` (yellow) warning, `✗` (red) problem, `·` (dim) information.

### 4.2 Banner

The bird from the site icon, rendered once from `icon-dark.png` into braille characters (2×4 dots per cell), touched up by hand, and stored as a string constant in `ui/banner.ts`. The name, version, and tagline sit to its right:

```
         ⣴⣾⣟⣳⣄
       ⢀⣾⠿⢿⣿⡏⠉
     ⢠⣴⣶⣶⡗⢸⣿⡇
    ⢠⣿⣿⣿⣿⡇⣿⣿⠇     kerstel 0.1.0
   ⣠⡾⣿⣿⣿⢟⣴⡿⠋      Local-first secrets
  ⢀⣵⣾⢟⡋⣴⣿⠋⠁       for Node and Bun
 ⡴⢟⣩⢠⡟⠸⣿⣿⣧⡀
 ⢠⡾⢣⡿⠁ ⠘⢿⣿⣿⣆
⣰⠿⠁⠋     ⠉⠉⠉⠁
```

- It is shown only by `init`, `doctor`, `uninstall`, and bare `ks`/`kerstel` with no arguments.
- It is shown in full only when stdout is a TTY and the terminal is at least 44 columns wide. Otherwise it collapses to one line, `◆ kerstel 0.1.0`, and when stdout is not a TTY it is left out entirely.
- The bird is drawn in the accent colour, the name in bold, and the tagline dim.

### 4.3 Building blocks

Thin wrappers over `@clack/prompts`, so a later library change touches one module:

- `intro`/`outro`, and steps drawn with clack's `◆ │ └` rail.
- `select`: an arrow-key menu, one option pre-selected, and a one-line hint per option.
- `multiselect`: a checklist, toggled with Space and confirmed with Enter.
- `password`: masked input for secret values.
- `spinner` for slow steps: starting the daemon, the self-check, and backups.
- `note`: a boxed block for next steps.
- `table`: aligned columns, measured by display width, not string length.
- A footer hint on every prompt: `↑/↓ to move · Enter to confirm`, or `Space to toggle · Enter to confirm`.

### 4.4 Prompter

`Prompter` gains two methods:

```ts
interface Choice<T extends string> { value: T; label: string; hint?: string }

select<T extends string>(question: string, choices: Choice<T>[], defaultValue: T): Promise<T>;
multiselect<T extends string>(question: string, choices: Choice<T>[], initial: T[]): Promise<T[]>;
```

- `ClackPrompter` implements all of `Prompter` with clack, and becomes the interactive default.
- `ScriptedPrompter` (tests) implements the new methods from its answer queue, as it does the existing ones.
- The non-interactive prompter (`--yes`) returns each default, as now.
- The current readline `TtyPrompter` is removed once nothing uses it.

### 4.5 Cancelling

Ctrl-C or Esc at any prompt prints `Cancelled. Nothing was changed.`, restores the cursor and terminal mode, and exits with code 130. Every prompt comes before the first write, as it does today, so the message is always true.

### 4.6 When stdout is not a terminal

No banner, spinners, redrawn lines, or colour. Each step prints as one plain, stable line, so logs, CI, and tests read the same text every time. Interactive prompts still need a TTY; without one, the existing rules apply (`--yes` or exit 2).

### 4.7 Everyday commands

`get`, `set`, `ls`, `rm`, `run`, and `resolve` use the theme's colours and symbols but keep their short output and get no banner. `exec` prints nothing of its own, because its output is the wrapped command's.

## 5. `init`

### 5.1 Flow

1. **Banner**, then one line: `Setting up whasal · Next.js on bun · .env, .env.local`. The framework is named only when `package.json` depends on one Kerstel recognises (`next`, `vite`, `astro`, `@remix-run/*`, `nuxt`, `@sveltejs/kit`); otherwise the line says `node` or `bun`.
2. **Overview.** Every variable, grouped by suggested destination, in this order:
   - `Vault, for <scope> only (n)`
   - `Vault, shared by all your projects (n)`
   - `Stays in <files> as plain text (n)`

   Each row shows the key, a value column, and its source file. A value headed for the vault is never printed, only its length (`•••• 64 chars`). A value staying in plain text is printed in full, because it stays readable in the file anyway. After the groups, one line per key with different values in several files names the files and says which one wins and that the others are kept in the encrypted backup.
3. **"Look right?"** A `select`:
   - **Yes, use these** (default): accept every suggestion.
   - **Let me change some**: a `multiselect` of every variable, then a `select` for each ticked one, with its suggestion pre-selected.
   - **Go through them one by one**: a `select` per variable, titled `KEY · 3 of 12`, with its value column and source under the title, a one-line reason for the suggestion, and the suggestion pre-selected and labelled `(suggested)`.

   After changing some or going one by one, the overview is shown again with the new destinations, and the same question is asked. **Yes** ends the loop.
4. **What will change.** One line per file (`.env.local: 7 values become references`, `package.json: 3 scripts go through Kerstel`), then a `select`: **Apply** (default), **Show the full diff first** (prints the existing masked diff, then asks again without that option), or **Cancel**.
5. **`.gitignore`.** The existing question, as a `select` with a hint per option.
6. **Apply.** A spinner per step, each finishing as `✓`: backup, vault, env files, `package.json`, `.gitignore`, then the self-check.
7. **Outro.** A `note`: `whasal is ready. Run bun run dev as usual.`, then `ks doctor` to check the setup, and a reminder that the `.env` files now hold only references and are safe to commit.

### 5.2 The three destinations

The menus use these words everywhere, with these hints:

| Value | Label | Hint |
| --- | --- | --- |
| `project` | Vault, for this project only | Only `<scope>` can read it |
| `global` | Vault, shared by all your projects | For accounts you use everywhere, like an OpenAI key |
| `plaintext` | Keep as plain text | Stays in the file. For settings, not secrets |

### 5.3 Why a suggestion was made

`classify.ts` returns a reason with each suggestion, shown in one-by-one mode:

| Rule | Reason |
| --- | --- |
| Known shared-service key (`GLOBAL_KEYS`) | You probably use this account in every project |
| Name announces a credential (`SECRET_KEYS`) | The name says it's a secret |
| Known config key (`PLAINTEXT_KEYS`) | A setting, not a credential |
| Boolean, number, or URL without credentials | Looks like a setting, not a credential |
| Anything else | Might be a secret, so it's safer in the vault |

The rules themselves do not change.

### 5.4 A teammate's first `init`

When a project's files already hold references and this machine lacks some values, `init` asks for each missing value in a `password` prompt titled `DATABASE_URL · 1 of 3`, noting which env file references it. `--from-stdin` is unchanged.

### 5.5 Non-interactive runs

`--yes`, `--keep`, `--global`, `--dry-run`, and `--from-stdin` behave exactly as now. Their output follows §4.6.

## 6. `doctor`

```
◇  This machine
│  ✓ Vault          12 secrets, unlocked with your macOS Keychain
│  ✓ Daemon         running
│  ✓ Runtime hook   installed
│  ! Shortcut       `ks` isn't on your PATH. Fix: re-run the installer
│
◇  This project · whasal
│  ✓ Scripts        3 of 3 go through Kerstel
│  ✗ References     1 of 9 can't be found: DATABASE_URL
│                   Fix: ks init
│
└  1 problem, 1 warning. Everything else looks good.
```

- It runs the same checks as today, plus one new check: whether a `ks` that resolves to this binary is on `PATH` (a warning, never a problem).
- **This machine:** vault (secret count and credential store: "macOS Keychain", "Secret Service", or "a key file"), daemon, runtime hook, file permissions, and the shortcut.
- **This project**, only inside a project: scripts wired, references that resolve, and values this machine is missing.
- Every warning and problem carries a `Fix:` line naming the command, using `cliName()`.
- `--verbose` adds the paths and permission modes shown today: home, vault, token, socket, and hook.
- **Exit code:** 1 when any check is `✗`, otherwise 0. Warnings exit 0. Today `doctor` always exits 0.
- `release.yml`'s Keychain smoke step greps for `Keychain:.*macos`. It changes to the new wording (`macOS Keychain`).

**What counts as a problem (`✗`):** the vault can't be opened, the key doesn't match, a reference can't be resolved, or a required file has the wrong permissions. **Warnings (`!`):** the daemon isn't running, the hook isn't installed, scripts aren't wired, the shortcut is missing, or the file backend is in use.

## 7. `uninstall` and bare `ks`

- `uninstall` uses the banner and the rail. Restores are grouped per project, and anything that would be lost is listed in a warning block. The final question is a `select` defaulting to **No, keep Kerstel**. The plan, the loss gate, `--force`, `--dry-run`, and `--yes` are unchanged.
- Bare `ks` or `kerstel` prints the banner and a short list of commands, each with a one-line description, and exits 0. `--help` prints the same list without the banner.

## 8. Testing

- **`ui/`:** the banner's full, one-line, and absent forms, by TTY, width, and `NO_COLOR`; truecolor detection; table alignment with wide characters; plain output when not a TTY.
- **`init`** through `ScriptedPrompter`: accept all, change some, one by one, apply after viewing the full diff, and cancel at each prompt (nothing written). Existing tests are updated for the new wording. No test may print a secret, and the overview test asserts that no vault-bound value appears in the output.
- **`classify`:** every rule returns its reason.
- **`doctor`:** grouping, `Fix:` lines, `--verbose`, and the exit code (0 with warnings only, 1 with a problem).
- **Pseudo-terminal end to end.** The compiled binary runs `init` on a sample project under `script` (`script -q /dev/null …` on macOS, `script -qec … /dev/null` on Linux), answered only with Enter key presses. The resulting `.env` and `package.json` must match the non-interactive result, and the output must contain no secret value.
- **`install.sh`:** `ks` is created, refreshed on a re-run, and skipped with the message when another `ks` is on `PATH`.
- **`uninstall`:** removes a `ks` link to the binary it removes, and leaves any other `ks` alone.

## 9. Docs and tracking

- README, Getting started, and the CLI reference, with every command, flag, and message checked against the source. Output examples on the site use the new look.
- `CHANGELOG.md`, under 0.1.0: `ks`, the new `init` flow, the new `doctor` (including its exit code), and `doctor --verbose`.
- `ROADMAP.md`: the PR that ships this adds `ks` and the redesigned `init` and `doctor` under 0.1.0, already ticked.
