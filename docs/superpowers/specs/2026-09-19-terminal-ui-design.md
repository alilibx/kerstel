# Terminal UI: `kerstel ui`, `refs`, and `audit`

**Status:** approved design, 2026-09-19. Replaces §9 of the [product spec](2026-09-17-kerstel-secrets-manager-design.md), which planned a local web portal.
**Releases:** 0.2.0 ships `kerstel ui` with the Secrets and References screens and `kerstel refs` ([#8](https://github.com/alilibx/kerstel/issues/8), [#9](https://github.com/alilibx/kerstel/issues/9), [#10](https://github.com/alilibx/kerstel/issues/10)). Next ships audit rows for every write, `kerstel audit`, and the Audit screen ([#11](https://github.com/alilibx/kerstel/issues/11)).
**Related:** the [monorepo and checkouts spec](2026-09-19-monorepo-and-checkouts-design.md), which changes how projects are registered. The References screen and `refs` read that registration.

## 1. Why a terminal UI and not a web portal

The product spec planned `kerstel ui` as a web page on `127.0.0.1`, served by the daemon and opened with a one-time token. The design was dropped for these reasons.

- **A loopback port is reachable by every local process and every website open in the browser.** The daemon's socket is a file, mode `0600` inside a `0700` home, so only the owning user can reach it. A TCP port has no owner. Guarding it takes a token exchange, `Origin` and `Host` checks, and a session credential, and each is a place to get wrong. Kerstel listens on no port today, and a portal would have been the first thing the security page had to explain.
- **The daemon is the access boundary for every running app.** Adding an HTTP listener with add, edit, delete, and reveal endpoints would put the write surface in the process every hook talks to.
- **`lock` exits the daemon on purpose,** so the key leaves memory. A portal inside the daemon would die on lock and on the idle timeout, and keeping it alive would mean turning lock back into a boolean that leaves the key in the heap.

A terminal UI has none of these problems. It is the CLI with a different renderer: the same process model as `kerstel set`, the same vault access, the same credential store, and nothing new listening anywhere.

## 2. Scope

| Item | Release | Issue |
| --- | --- | --- |
| `kerstel ui`: screen layer, Secrets screen, References screen | 0.2.0 | #8, #9, #10 |
| `kerstel refs [--by-key]` | 0.2.0 | #10 |
| Audit rows for `set`, `rm`, `init`, and the UI's writes | Next | #11 |
| `kerstel audit` and the Audit screen | Next | #11 |

**Out of scope.** Lock and unlock ([#12](https://github.com/alilibx/kerstel/issues/12)) move to Next, beside Touch ID and polkit ([#16](https://github.com/alilibx/kerstel/issues/16)). Today every backend reads the key silently while you are logged in: `security find-generic-password` trusts the `security` tool that stored the item, `secret-tool lookup` is silent while the login keyring is open, and the file backend is a file. A `kerstel unlock` that asks for nothing would look stronger than it is. Lock ships when unlock can ask for something.

Windows stays unsupported, as the docs say. The screen layer uses VT escape sequences and raw mode, which Windows Terminal supports, but nothing here is tested there.

## 3. Commands

Every screen in the UI has a plain command for pipes and scripts: `ls` for Secrets, `refs` for References, `audit` for Audit. The commands print the same text on a terminal and in a pipe, with the theme's colour only on a terminal.

### 3.1 `kerstel refs [--by-key]`

Lists which project files reference which secrets, and which secrets nothing references.

- For every registered checkout (one `projects` row each, see the monorepo spec), it runs `detectProject(root)` and `loadEnvFiles`, parses each `.env*` file with `parseDotenv`, and collects every reference value, `kerstel://` and the shorter `ks:` form that ships in the same release ([#36](https://github.com/alilibx/kerstel/issues/36)). The scan lives in a new module, `packages/cli/src/project-refs.ts`, which `uninstall`'s planner also calls for its `unresolvable` and `unused` lists, so the two cannot drift.
- Existence comes from `listSecrets()`, so `refs` never decrypts a value. It reads project files and never writes them.
- Default output groups by scope, then by checkout root, then by file:

  ```
  web  /Users/ali/src/shop/apps/web
    .env         kerstel://web/DATABASE_URL
                 kerstel://global/STRIPE_SECRET_KEY
    .env.local   kerstel://web/SESSION_SECRET   ✗ not in the vault

  api  /Users/ali/src/shop/apps/api
    .env         kerstel://global/STRIPE_SECRET_KEY

  Unreachable
    ✗ legacy  /Users/ali/src/legacy   the folder no longer exists

  Referenced by no project
    kerstel://global/OPENAI_API_KEY
  ```

- `--by-key` inverts it: each secret, then the files that reference it, then the unresolvable references at the end.
- Exit code `0` always. An unresolvable reference is information, not a failure; `doctor` is the tool that judges.

### 3.2 Audit rows (Next)

The log records `resolve` (daemon), `reveal` (`get --reveal`), and `run` today. Every write path gains a row:

| Event | Written by |
| --- | --- |
| `set` | `kerstel set`; `kerstel init`, one row per value it stores; the UI's add and edit |
| `remove` | `kerstel rm`; the UI's delete |
| `reveal` | `get --reveal` (already); the UI's reveal |

Process name is `kerstel` and the pid is the CLI's own, as `reveal` and `run` do now. A row never carries a value. `uninstall` deletes the vault, so it writes nothing.

### 3.3 `kerstel audit [--scope <s>] [--key <KEY>] [--action <a>] [--limit <n>]` (Next)

Newest first, 50 rows by default, as one aligned table:

```
2026-09-19 14:02:11  resolve  kerstel://web/DATABASE_URL       node (41230)
2026-09-19 13:58:40  set      kerstel://global/OPENAI_API_KEY  kerstel (41102)
2026-09-19 13:58:02  reveal   kerstel://global/OPENAI_API_KEY  kerstel (41077)
```

Filters combine. `--action` accepts `resolve`, `run`, `reveal`, `set`, or `remove`, and rejects anything else with exit `2`. `listAudit` grows a filter object, `{ limit, scope?, key?, event? }`, applied in SQL so the log is never loaded whole.

## 4. `kerstel ui`

### 4.1 Process model

`kerstel ui` opens the vault once through `openContext()`, exactly as `kerstel set` does, and holds it for the session. The daemon keeps serving beside it: SQLite's WAL mode and the 5-second busy timeout already cover a `daemon serve` writing audit rows while the UI writes a secret. The UI never talks to the daemon.

Without a TTY on stdin and stdout it exits `2` with one line: `kerstel ui needs an interactive terminal. Use kerstel ls, kerstel refs, and kerstel audit in a pipe.` A terminal smaller than 60 columns by 16 rows shows one centred line, `Terminal too small (60×16 minimum)`, until it is resized.

### 4.2 Screen layer

A small module tree in `packages/cli/src/tui/`, with no new dependency. Rendering is pure: state plus size in, lines out.

| Module | Role |
| --- | --- |
| `terminal.ts` | Enters and leaves the alternate screen, raw mode, and hidden cursor. Reads bytes from stdin, reports resizes. Restores the terminal on every exit path: normal quit, Ctrl-C (byte `0x03` in raw mode), and an uncaught error, which it rethrows after restoring. Exposes an interface so tests inject a fake. |
| `keys.ts` | Turns byte chunks into key events: printable characters, Enter, Esc, Tab, Backspace, arrows, Home, End, PageUp, PageDown, and Ctrl combinations. Unknown sequences are dropped. |
| `frame.ts` | The frame type, an array of rows, and the helpers that pad, truncate, and lay out columns by `Bun.stringWidth`, so wide and combining characters line up. |
| `widgets/` | Pure renderers: `list` (rows, a cursor, a filter line, a scroll window), `input` (single line, with a masked mode that echoes dots), `confirm` (a one-line yes or no), `statusbar` (keys for the current screen). |
| `app.ts` | The state type and `update(state, event)`, a pure reducer that returns the next state and a list of effects. Effects are `reload`, `store`, `remove`, and `reveal`. The loop applies effects against `data.ts` and feeds the results back as events. |
| `screens/secrets.ts`, `screens/references.ts`, `screens/audit.ts` | One renderer and one sub-reducer per screen. |
| `data.ts` | The adapter over `Vault` and the `project-refs` scan. It is the only place a value is decrypted. |

Each frame is a full redraw: cursor home, every row written and cleared to the end of line. No diffing. A frame is written only after an event, so an idle UI costs nothing.

Colour comes from the existing theme module, which already honours `NO_COLOR` and prints plain text when stdout is not a terminal. `TERM=dumb` is not detected today; the UI needs raw mode and the alternate screen anyway, so it refuses to start there with the same message as the no-TTY case.

### 4.3 Screens and keys

Three screens on tabs across the top: `Secrets`, `References`, and `Audit` (Next; until then the tab is absent).

| Key | Everywhere |
| --- | --- |
| `Tab`, `Shift-Tab`, `1` `2` `3` | Switch screen |
| `j` `k`, `↑` `↓`, `PageUp` `PageDown`, `g` `G` | Move |
| `/` | Filter the list; `Esc` clears |
| `?` | Show the keys for this screen |
| `q`, Ctrl-C | Quit |

Every screen ends with a status bar naming the keys that apply to the current row. While an input or a confirm is open, every key goes to it, and `Esc` closes it without changing anything.

### 4.4 Secrets

The list groups by scope, `global` first and then each project scope alphabetically, with columns for the reference, the value shown as the CLI's fixed-width mask (`mask()` in `output.ts`, twelve dots, so the mask never hints at length), and the last update.

| Key | Action |
| --- | --- |
| `r` | Reveal the value on the current row. It replaces the dots until you move, press `Esc`, or leave the screen, and a `reveal` audit row is written first. |
| `a` | Add. Pick the scope from the existing ones, `global`, or type a new one. Type the key. Type the value in the masked input. Confirm `Store kerstel://<scope>/<KEY>?`. |
| `e` | Edit the value on the current row, in the masked input, then confirm. |
| `d` | Delete the current row. The confirm names how many project files reference it, from the same scan the References screen uses: `Referenced by 2 project files. Delete kerstel://web/DATABASE_URL? y/N`. |

Validation is the CLI's: `isValidScope`, `isValidKey`, and the transport cap `set` enforces today, which moves from `secrets.ts` into a shared `MAX_VALUE_CHARS` constant. A rejected input shows the same sentence the CLI prints, on the input line, and keeps the input open.

A decrypted value exists only in the screen state while it is shown, and the reducer clears it on every move. Nothing in the UI logs, and `terminal.ts` writes only frames, so a value cannot reach scrollback: the alternate screen is discarded on exit.

Add and edit write `set` rows and delete writes a `remove` row from Next. In 0.2.0 the UI writes `reveal` rows only, matching what the CLI records.

### 4.5 References

The `refs` scan, rendered as a tree: scope, then checkout root, then file, then references. `b` toggles the by-key view. An unresolvable reference is marked in the theme's problem colour, an unreachable checkout shows its reason, and the last group is the secrets no project references. `Enter` on a reference jumps to its row on the Secrets screen. The scan runs on entering the screen and on `R`, and while it runs the status bar says so; a monorepo with many packages is a few hundred file reads, well under a second.

### 4.6 Audit (Next)

The `audit` table as a list, newest first, 200 rows at a time. `/` filters by key, `a` cycles the action filter through all, `resolve`, `run`, `reveal`, `set`, and `remove`, and `n` loads the next 200. `Enter` on a row jumps to its secret on the Secrets screen if it still exists.

### 4.7 Errors

A failed effect, such as a vault write that hits a full disk, becomes an `error` event: the message shows in the status bar in the problem colour until the next key, and the screen keeps its state. The message is the store's own, which carries paths and errno text, never a value. An error that is not from an effect, such as a bug in a renderer, restores the terminal and exits `1` with the message on stderr, as any CLI command does.

## 5. Documentation and roadmap changes

- `ROADMAP.md`: the `0.2.0: local portal` section becomes `0.2.0: terminal UI and monorepos`, and #11 (audit) and #12 (lock) move to `Next: access gating`. The GitHub milestone `0.2.0` keeps its name with a new description, and #11 and #12 move to the `Next` milestone. #8 and #9 are retitled for the terminal UI, and #10 and #11 are reworded for the command plus screen.
- The product spec: §2, §4.1, §5, §8, §9, §10, and §11 are updated in the same PR as this spec.
- `apps/website/src/pages/docs/cli.md` gains rows for `ui`, `refs`, and, in Next, `audit`, each in the PR that ships the command. The README's command list follows. `CHANGELOG.md` gets one line per user-visible change.
- The security page's "no network" sentence does not change, and the "where plaintext appears" list gains the UI's reveal.

## 6. Testing

- **Store:** `listAudit` filters, alone and combined; rows for `set`, `remove`, and `reveal` from the commands and from `init` (Next).
- **`refs`:** a temp tree with two checkouts, one resolvable reference, one unresolvable, one unreachable project, and one unreferenced secret, in both views; the planner's `unresolvable` and `unused` lists still match after the scan moves.
- **`audit`:** table output against fixed rows; each filter; the rejected action.
- **Keys:** every sequence in `keys.ts`, including split chunks and an unknown sequence.
- **Renderers:** each widget and screen rendered at a fixed size for a fixed state, asserted line by line, including truncation of a wide-character reference and the too-small message.
- **Reducer:** scripted key sequences for add, edit, delete, reveal and clear-on-move, filter, screen switch, and an error event; assertions on the state and the effects, never on a terminal.
- **Terminal:** the restore sequence is asserted on the fake for quit, Ctrl-C, and a thrown error. No test needs a PTY.
- No test prints a value, and every temp vault and home is removed.
