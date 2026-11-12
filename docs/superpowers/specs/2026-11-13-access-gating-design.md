# Access gating: audit, presence, approvals, and lock

Status: draft, 2026-11-13. Covers roadmap items #11 (audit log), #16 (proof of presence), #14 (approval prompt), #15 (allowlists), and #12 (lock and unlock). #54 (binding the data key to the Secure Enclave or TPM) gets its own spec later.

This spec supersedes §3.2, §3.3, and §4.6 of the [terminal UI spec](2026-09-19-terminal-ui-design.md) and fills in level 2 of the threat model in the [main spec](2026-09-17-kerstel-secrets-manager-design.md#3-threat-model).

## 1. Why

Today any program running as you can read every secret in the vault. It can run `ks get --reveal KEY`, start an app in a project and print its `process.env`, or talk to the daemon with the session token in `~/.kerstel/session.token`. The program most likely to do this is not malware. It is a coding agent working in your terminal: debugging an app, it runs `ks get --reveal DATABASE_URL` and the value lands in its context.

Kerstel cannot tell an agent from a person. An agent runs as you, in your shell, and whatever it starts looks exactly like what you start. This design does not try to detect agents. It does three things instead:

1. **Records** everything Kerstel does with a secret on this device, so you can see what happened (the audit log).
2. **Asks the person, not the process.** Before a value is printed, or before an app gets its secrets, Kerstel shows a dialog drawn by the OS (Touch ID, a password, polkit). An agent can't answer it. A person at the keyboard can.
3. **Says plainly what it does not protect,** in the docs and in `doctor`.

## 2. Goals, non-goals, and anti-goals

### Goals

- A local audit log of every read and write of a secret, with `kerstel audit` and an Audit screen in `kerstel ui`, that puts reveals first.
- Every reveal of a value needs proof of presence through a dialog the OS draws.
- With gating on, an app gets its secrets only after a person approves its project, and the approval lasts a few hours, like `sudo`.
- Keys you mark sensitive need approval for every process that asks.
- `kerstel lock` and `kerstel unlock`, with unlock needing proof of presence.

### Non-goals

- Telling an agent from a person. Nothing here depends on it.
- Stopping an approved app from leaking its secrets. Once an app has a value, Kerstel no longer controls it (main spec §3: "malicious code running after it has been granted a secret" is out of scope).
- Rotating keys. Only the provider can issue a new key. Kerstel only hints that you might want to.
- Syncing the audit log or approvals between devices. Both stay on the device where they happen (sync spec §5.3).
- Closing the paths around the daemon: reading `~/.kerstel/vault.db` with the data key taken from the OS credential store. That is #54.

### Anti-goals: it fails even if it works when...

- **It nags.** A prompt for every key on every process start, or a warning list you have to clear, makes people turn gating off. One dialog per project per working session is the budget.
- **It looks stronger than it is.** If the docs or the CLI imply that an agent can't reach your secrets, while #54 is still open and the credential store hands out the data key, the design has failed. Every surface that mentions gating says what it does not cover.
- **The CLI draws its own password prompt** where an OS dialog is possible. An agent controls the terminal and can print a fake one (#16).
- **A row in the log carries a value,** or any part of one.

## 3. Order of work

Each part ships as its own PR, in this order. Each later part writes rows into the audit log, so the log comes first.

| Part | Issue | Depends on |
| --- | --- | --- |
| A. Audit log | #11 | none |
| B. Proof of presence, applied to reveals | #16 | A |
| C. Approvals and allowlists | #14, #15 | A, B |
| D. Lock and unlock | #12 | B |

## 4. Part A: the audit log (#11)

### 4.1 What gets a row

One row each time Kerstel touches a secret or the vault on this device.

| Action | Written by |
| --- | --- |
| `resolve` | The daemon, when an app reads a key through the hook. The hook remembers each value for the life of its process, so this is one row per key per process, not one per `process.env` read. |
| `run` | `kerstel run`, one row per key it injects (as today). |
| `reveal` | Anything that prints a value or writes it out in plain text: `get --reveal`, `resolve`, `sync --reveal`, the UI's reveal, `move --to plaintext`, and `uninstall` (one row per value). `resolve` writes `resolve` today and changes to `reveal`. |
| `set` | `kerstel set`, `kerstel init` (one row per value it stores), `kerstel move` into the vault, and the UI's add and edit. |
| `remove` | `kerstel rm`, `kerstel move` out of the vault, and the UI's delete. |
| `sync` | A value that arrived from another device, or a conflict you settled. One row per key. |
| `device` | A device paired or removed. No key. |
| `approve`, `deny` | Part C: a dialog answered, or one that timed out (`deny`). |
| `allow`, `revoke` | Part C: a saved approval added or removed. |
| `lock`, `unlock` | Part D. No key. |

`ls`, `refs`, `scan`, `doctor`, and `update` read key names, never values, and write nothing. `uninstall` deletes the vault and the log with it.

### 4.2 What a row holds

- Time, action, scope, and key. Scope and key are empty for `device`, `lock`, and `unlock`.
- The process: name and pid, as today.
- **The chain of programs that started it,** for example `kerstel ← zsh ← claude`. The daemon or CLI walks parent processes up to six levels, stopping at the first terminal, `launchd`, `systemd`, or `init`, and stores the names only, never arguments (arguments can hold values). A program that wants to hide can fake this. A normal agent doing its job doesn't, and that's the case this is for.
- **The checkout,** when the process runs inside one Kerstel knows. This fills the `project_id` column that exists today and nothing writes.
- For `resolve` and `run` with gating on: whether the read was allowed, and by what (an approval window, a saved approval, or gating being off).

A row never holds a value, a hash of one, its length, or any part of it.

### 4.3 Retention

Rows older than 90 days are deleted. The daemon prunes at start and once a day while running. The CLI does not prune, so reading the log never changes it. *(My call. Without a limit, a dev server whose file watcher restarts often writes thousands of `resolve` rows a day.)*

### 4.4 `kerstel audit`

```
kerstel audit [--scope <s>] [--key <KEY>] [--action <a>] [--since <7d|24h|date>] [--limit <n>]
```

It opens with a summary of the period, 7 days by default, then the rows newest first:

```
Last 7 days
  Reveals     3   listed below
  App reads   412 by 37 processes in 4 projects

Reveals
  2026-11-12 14:02  ks:global/OPENAI_API_KEY   kerstel ← zsh ← claude
                    If you didn't reveal this yourself, consider rotating it.
  2026-11-11 09:15  ks:web/STRIPE_SECRET_KEY   kerstel ← zsh ← Terminal
                    If you didn't reveal this yourself, consider rotating it.
  2026-11-10 18:40  ks:web/LOG_LEVEL           kerstel ← zsh ← Terminal

App reads
  web     node  (bun dev)   DATABASE_URL, OPENAI_API_KEY        212 processes
  api     bun               DATABASE_URL, REDIS_URL             188 processes
  ...

Changes
  2026-11-12 13:58  set     ks:global/OPENAI_API_KEY   kerstel ← zsh ← Terminal
  ...
```

- Reveals are listed one per line, in the warning colour, always above everything else. They are the reads that matter most: a reveal puts the value where anyone reading the terminal, an agent included, can see it.
- App reads are grouped by project and process, because 412 lines would bury the reveals. `--action resolve` lists them one per line.
- **The rotation hint** is a dimmed line under a reveal, shown only when the revealed value is a credential and has not changed since the reveal. Kerstel decides "credential" with `judge()` from `init/classify.ts`, the same classifier `scan` and `init` use, so a plain URL or a setting like `LOG_LEVEL` never gets the hint, and a URL with a password in it does. Whether the value changed is worked out from the secret's `updated_at` against the reveal's time, so nothing extra is stored and there is nothing to dismiss. The hint never appears in `doctor`, and never as a warning or an exit code. *(Kerstel can't know whether the reveal was yours, so the hint is a nudge, not an alarm.)*
- Classifying needs the value, so the audit command opens the vault the way `get` does. The value is classified in memory and never printed.
- Filters combine. `--action` accepts any action in §4.1 and rejects anything else with exit `2`. Filtering happens in SQL, so the log is never loaded whole.
- With any filter, the summary covers only the matching rows.
- Exit `0` whatever the log holds.

### 4.5 The Audit screen in `kerstel ui`

The same summary at the top, then the rows, 200 at a time. Keys as in the terminal UI spec §4.6: `/` filters by key, `a` cycles the action filter, `n` loads the next 200, and `Enter` on a row jumps to its secret on the Secrets screen if it still exists.

### 4.6 Schema

A migration adds the chain, the outcome, and an index on `(event, ts)` for the summary. `scope` and `key` become nullable or take `''` for keyless rows; the builder picks. `listAudit` grows a filter object applied in SQL.

## 5. Part B: proof of presence (#16)

### 5.1 The prover

Presence is a backend behind one interface, chosen automatically the way the credential store backend is, overridable with `KERSTEL_PRESENCE`, and named by `doctor`. The backends and fallbacks are as listed in #16:

| Platform | Prover |
| --- | --- |
| macOS | `LocalAuthentication`, `deviceOwnerAuthentication` policy: Touch ID, then Apple Watch, then the login password. |
| Linux desktop | polkit with interaction allowed, which picks up `fprintd` where a fingerprint is enrolled. With no polkit agent running, there is no prover. *(My call: calling PAM directly would need Kerstel to collect the password itself, which is the CLI-drawn prompt §2 forbids, and the daemon has no terminal to draw it on anyway.)* |
| Headless (SSH, containers, WSL without a desktop) | None. Reveal-class actions are denied with a message naming the reason. `KERSTEL_PRESENCE=tty` opts into a terminal password prompt, and `doctor` warns while it is set. |
| Windows | Windows Hello, once #17 ships. |

The dialog always carries a reason line that names what is being asked, for example "Reveal ks:global/OPENAI_API_KEY" or "Let apps in ~/code/web read 4 keys for 8 hours".

### 5.2 What needs presence

- **Every reveal**, meaning every command that prints a value or writes one out in plain text: `get --reveal`, `resolve`, `sync --reveal` (it prints both sides of a conflict), the UI's reveal, `move --to plaintext`, and `uninstall`. This applies whether gating is on or off, because the person asking for a reveal is at the keyboard anyway. `move` and `uninstall` ask once per run, not once per value, and the dialog says how many values will be written out.
- Approving an app (Part C), adding a saved approval, and marking a key no longer sensitive.
- Turning gating on or off.
- `kerstel unlock` (Part D).

**`resolve` becomes a reveal.** Today it prints a value through the daemon with no prompt, so it is the obvious way around a gated `get --reveal`. Scripts that use `$(ks resolve …)` start showing a dialog, and fail where no prover exists. The docs and the changelog point them to `kerstel run` or `kerstel exec`, which inject values without printing them. *(My call.)*

**No grace window for reveals.** Every reveal asks. A coding agent usually runs inside your terminal session, so a window keyed to the terminal would hand the agent every reveal you make for the next few minutes. Reveals are rare and Touch ID takes a second. #16's grace window is met by the approval window for apps (§6.3), which is where repeated asks would hurt. *(My call.)*

### 5.3 What this does and doesn't stop, until #54

`get --reveal` reads the vault in the CLI process, without the daemon. A program that skips the CLI and reads `vault.db` with the data key from the credential store (`security find-generic-password` on macOS) gets every value with no dialog. Presence on reveal stops an agent that uses Kerstel the normal way. It does not stop one set on getting around it. The security page, the `get` docs, and `doctor` say so until #54 closes the gap on macOS.

## 6. Part C: approvals and allowlists (#14, #15)

### 6.1 Turning it on

Gating of app reads is a setting, `kerstel gate on|off|status`. Turning it on or off needs presence and writes an audit row. Reveals need presence either way (§5.2).

**Gating is on by default,** for new installs and for existing installs after the upgrade that ships Part C. *(Ali's decision.)*

- **New installs:** `init`'s self-check resolves a reference, so the first approval dialog appears during `init`, while the person is there. `init` says one line beforehand so the dialog is expected.
- **After the upgrade:** an app already running keeps the values its hook has already read. The first new read from each repository shows a dialog. The changelog, the release notes, and a one-time line from `doctor` explain what changed and how to turn it off.
- **No prover** (headless, §5.1): gating stays off, because nothing could answer a dialog, and `doctor` says gating is off and why. `gate on` refuses there and names the reason, unless `KERSTEL_PRESENCE=tty` is set.

### 6.2 Who is asking

The daemon identifies the requesting process from the socket itself (the peer's pid from the OS), never from the pid the hook reports in the request. An approval covers a checkout, so a self-reported pid would let any process claim to be one inside an approved checkout. **Part C does not ship until peer identification works.** If Bun can't reach it directly, it goes through the same native helper as the macOS prover (§10), and that spike settles it before Part C is planned. From the pid it reads the executable path, the working directory, and the parent chain. The working directory is matched against registered checkouts (the `projects` table) to find the project.

`kerstel run` resolves in the CLI process, not through the daemon. Under gating it asks the daemon for a decision first and resolves only if the daemon allows it, so `run` and the hook follow one rule.

### 6.3 The approval window

The unit of approval is **a repository**: the outermost registered checkout containing the process's working directory, so one approval covers every member of a monorepo and `turbo dev` across four packages shows one dialog, not four. It is not a process and not a key. One process start resolves every key its project references (main spec §6), and an agent runs the same `node` as you, so per-process or per-key prompts would only add dialogs.

- The first time a process in a checkout asks for a key while gating is on and no window is open for that repository, the daemon shows one dialog: "Let apps in `~/code/web` read 4 keys for 8 hours". The keys are the ones the env files of every checkout in that repository reference, project and global, as `refs` finds them.
- Approved: every process in that repository may read those keys for 8 hours, whoever started it. The window closes early on `kerstel lock` and when the daemon exits.
- A key the repository does not reference, requested by a process inside it, needs its own dialog.
- A process outside every registered checkout (`node -e` in `/tmp`, say) gets a dialog naming the process, its directory, and the key, and approval covers only that process.
- Denied, cancelled, or unanswered after 60 seconds: the read fails. The window stays closed, and the next process asks again. A burst of processes from one repository shares one dialog while it is open.

While a dialog is open, the hook waits for the answer, up to 60 seconds, and prints one line on stderr saying it is waiting for approval in a Kerstel dialog. *(My call. Today the hook times out after 5 seconds.)* A denied read behaves as a missing key does today, with a message that names Kerstel and the denial.

Every dialog answer writes `approve` or `deny` to the log, with the checkout, the keys, and the chain.

### 6.4 Sensitive keys

`kerstel set KEY --sensitive` (and a toggle in the UI) marks a key sensitive. A sensitive key is never covered by an approval window or a saved approval. Every process that asks for it gets its own dialog. Marking a key sensitive needs nothing. Unmarking it needs presence. Production credentials are the intended use.

The mark syncs with the secret, as part of its encrypted record, so a production key marked on one laptop is protected on all your devices. An unmark that arrives through sync was made with presence on the device that sent it, so it applies without asking again. *(My call.)*

### 6.5 Saved approvals

`kerstel allow <path> [--keys <K,...>]` saves an approval with no time limit, for a repository you trust and work in all day. Adding one needs presence. `kerstel allow --list` lists them, and `kerstel allow --revoke <id>` removes one.

A saved approval matches the repository (§6.3) and nothing else. It does not match the executable: `nvm`, `volta`, and Homebrew put a version in Node's real path, so a match on it would break on every Node upgrade, and it would not stop an agent, which runs the same `node` as you. The keys are fixed when the approval is saved, either the ones listed with `--keys` or the ones the repository references at that moment. A key referenced later needs a dialog, so adding a reference to `.env` is never approved silently. *(My call.)*

The docs state the consequence: any program in that repository is allowed, including one an agent started. A saved approval trusts a place, not an intention.

## 7. Part D: lock and unlock (#12)

- `kerstel lock` writes a lock marker under `~/.kerstel/` and stops the daemon, so the data key leaves memory. Today's `lock` op already exits the daemon; what changes is that the next request no longer auto-starts an unlocked daemon.
- While the marker exists, **nothing loads the data key.** The daemon starts locked and answers every `resolve` with `locked` and a message saying to run `kerstel unlock`. Every command that opens the vault with the key refuses the same way: `get`, `resolve`, `run`, `set`, `init`, `move`, `sync` (including background sync, which skips quietly and tries again after unlock), `audit` (it opens the vault for the rotation hint), `ls`, `refs`, and the UI. Today every vault command fetches the key through `openContext`, even one that only lists names, so all of them refuse. `doctor`, `lock`, `unlock`, `update`, and commands that don't open the vault keep working.
- The daemon's idle exit is not a lock. It drops the key from memory as today, and the next request starts the daemon again without asking. *(My call. Only `kerstel lock` asks for presence on the way back.)*
- `kerstel unlock` needs presence, removes the marker, and starts the daemon.
- `doctor` and `kerstel ui` report a locked vault.
- Both write audit rows. Lock closes every approval window.

## 8. Copy, docs, and roadmap

- New CLI page content for `audit`, `gate`, `allow`, `lock`, `unlock`, and `set --sensitive`. The README and `apps/website/src/pages/` change with each part, per AGENTS.md.
- A security page section, "What access gating does and doesn't protect against", covering §5.3, §6.5, and the non-goals, per platform.
- Each part's PR ticks its roadmap box and adds its changelog lines. The rotation hint ships with #11 and needs no new roadmap line.
- The terminal UI spec's §3.2, §3.3, and §4.6 get a note pointing here.

## 9. Testing

- A fake prover backend for tests, selected by an env var that only the test harness sets, which answers yes, no, or never. No test shows a real dialog.
- Tests never print a value, including in audit assertions. A test reads the log and checks that no row contains a known value.
- Peer identification and the parent chain get tests on macOS and Linux in CI.
- Retention is tested with rows backdated past 90 days.

## 10. Left to the builder

- How the compiled binary reaches `LocalAuthentication` on macOS: a small native helper shipped with the release, Objective-C through `bun:ffi`, or JXA through `osascript`. Spike this first. It is the riskiest piece, and #54 will need a signed helper anyway, so a helper that #54 can grow into is worth preferring. The dialog must name Kerstel, not `osascript`.
- How Linux polkit is reached without root. A polkit action usually needs a policy file installed by root, and `install.sh` installs as the user. If no rootless route exists, say so and fall back to PAM, then to "no prover".
- Getting the peer pid from a Unix socket under Bun (`LOCAL_PEERPID` on macOS, `SO_PEERCRED` on Linux).
- Where the gate setting and saved approvals are stored, how sensitive marks fit the sync record format, and how existing records migrate.
- Whether `scope` and `key` become nullable for keyless rows.
- The exact wording of every dialog and message, within the rules above.

## 11. Open questions

None.
