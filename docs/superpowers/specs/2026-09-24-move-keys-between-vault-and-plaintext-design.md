# `ks move`: change where a key lives after init

- **Status:** approved design, 2026-09-24
- **Release:** 0.1.4
- **Issue:** [#71](https://github.com/alilibx/kerstel/issues/71)
- **Builds on:** the product spec (`2026-09-17-kerstel-secrets-manager-design.md`, §5 the wizard, §7 uninstall)

## 1. Problem

`kerstel init` asks, once per key, where each value should live: in the vault for this project, in the vault shared by every project (`global`), or in plain text in the env file. After that the choice is hard to change:

- **Plain text → vault** works by re-running `init`, which offers every key still in plain text again. Nothing tells the user this.
- **Vault → plain text** has no path except `kerstel uninstall`, which undoes everything.
- **Project ↔ shared** has no path at all. A user who stored `OPENAI_API_KEY` per project and later wants one shared copy has to `ks set` by hand and edit every file.

## 2. Command

### 2.1 Interactive (default)

`kerstel move` with no key names, in a project `init` has seen:

```
$ ks move
  whasal: 6 variables in .env, .env.local

? Which keys?  (space to pick, enter to confirm)
  [ ] DATABASE_URL    Vault, this project
  [x] STRIPE_KEY      Vault, this project
  [ ] OPENAI_API_KEY  Vault, shared
  [ ] PORT            Plain text   3000
  ...

? Move STRIPE_KEY to:
  > Vault, shared by all your projects
    Keep as plain text

  .env, .env.local:  STRIPE_KEY = kerstel://whasal/STRIPE_KEY  →  kerstel://global/STRIPE_KEY
  kerstel://whasal/STRIPE_KEY is removed from the vault (nothing else here uses it)
? Apply?  Yes / No

✓ Backed up .env, .env.local
✓ STRIPE_KEY now reads kerstel://global/STRIPE_KEY
```

1. **Scan.** The same env-file discovery and loading `init` uses (`discoverEnvFiles`, `loadEnvFiles`, `dotenv-file.ts`): templates and backup copies skipped, unsupported lines never offered. `collectKeys` is not used: it keeps one winning value per key and only the names of files that disagree, which would hide a second reference. `move/scan.ts` groups instead by key and current place: one row per distinct reference (`whasal/KEY`, `global/KEY`), plus one row for the key's plain-text lines if it has any, each row carrying the files it covers. Each row shows its current place: `Vault, this project`, `Vault, shared`, `Plain text`.
2. **Values.** A plain-text value is printed only when `isSafeToDisplay` allows it (the #46 rules); otherwise it shows as its length. A vault value is never printed.
3. **Pick keys**, then **pick a destination per key** from `DESTINATION_CHOICES`, minus the key's current place. When several keys are picked, one question per key; a key whose answer would leave it where it is is dropped.
4. **Preview** every change (§4), then **Apply? Yes / No**, default No.
5. **Apply** (§5).

The menus use `init`'s prompter. Key names given without `--to` skip step 3's first menu and ask only the destination.

### 2.4 Without a terminal

A question that cannot be asked is an error, never a default:

| Arguments | Terminal | No terminal |
|---|---|---|
| none | menus | exit 2: `ks move asks questions, and this is not a terminal. Name the keys and --to, for example: ks move STRIPE_KEY --to global --yes` |
| keys, no `--to` | destination menu | exit 2, same message |
| keys and `--to` | preview, then Apply? | preview, then exit 2 unless `--yes`: `Apply needs a terminal; re-run with --yes.` |
| keys, `--to`, `--yes` | preview, apply | preview, apply |
| `--to` without keys | exit 2: `--to needs the keys to move.` | same |

A conflict (§3.2) or a tracked file (§4.2) without its flag is a refusal in the direct form whether or not there is a terminal, so a script behaves the same when run by hand.

Exit codes follow `init`: 0 done or nothing to do, 1 refused (§3.2, §4.2) or no named key left to move, 2 usage or a question with no terminal, 130 cancelled.

### 2.2 Direct

```
ks move STRIPE_KEY PORT --to global|project|plaintext [--yes] [--replace] [--allow-tracked]
```

No menus. The preview still prints; `--yes` answers Apply. `--to` applies to every named key. A named key the scan does not find, or that is already at the destination, is reported and skipped; if no key is left, exit 1. The flags:

- `--replace`: see §3.2.
- `--allow-tracked`: see §4.2.

### 2.3 Pointer from `init`

Whenever `init` finishes with keys still in plain text, or reports "Already migrated", it prints one more line:

```
ℹ To move a key between the vault and plain text later, run ks move.
```

## 3. What a move does

`<project>` is the project's scope name, as `init` registered it.

| From → To | Env files | Vault |
|---|---|---|
| plain → project | value → `kerstel://<project>/KEY` | value stored in `<project>` (§3.2 if one exists) |
| plain → shared | value → `kerstel://global/KEY` | value stored in `global` (§3.2 if one exists) |
| project → shared | `<project>/KEY` → `global/KEY` | value copied to `global` (§3.2); project copy deleted if unused (§3.1) |
| shared → project | `global/KEY` → `<project>/KEY` | value copied to `<project>` (§3.2); `global` never deleted |
| project → plain | reference → the value | project copy deleted if unused (§3.1) |
| shared → plain | reference → the value | `global` never deleted |

Every file of this checkout that defines the key is rewritten, the same set `init` would rewrite. Writing a plain value uses `restoreLineValue`, the quoting `uninstall` already uses, so the line comes back in the form the parser reads.

If a key's reference differs between files (`.env` has `whasal/KEY`, `.env.local` has `global/KEY`), the key is listed once per distinct reference and the preview names which files each row covers.

### 3.1 Deleting the project copy

A project-scope secret is deleted after the move only when, after the rewrite, no env file in this checkout still references it. Shared (`global`) secrets are never deleted by a move: other projects may use them, and Kerstel cannot see their files.

"This checkout" is the only one Kerstel knows about until #13 tracks each checkout separately. If the vault's recorded root for the project is not the current directory, another checkout may still read the secret, so the copy is **kept**, and the preview says so:

```
  kerstel://whasal/STRIPE_KEY is kept: whasal was set up in /Users/ali/src/whasal, which may still use it.
```

When the vault has no record of the project yet, there is no other checkout Kerstel knows of, and the copy is deleted if unused. The deleted value is saved in the backup taken before the rewrite (§5.1).

### 3.2 A destination that already holds a value

Any move into the vault, to `global/KEY` or to `<project>/KEY`, first looks up that entry. A project entry can exist with no file here referencing it: another checkout's, or one left by `ks set`.

- **Absent or the same value:** nothing to ask.
- **Different value:** interactive asks, default first. For `global`:

  ```
  ? kerstel://global/STRIPE_KEY already holds a different value (41 chars). Which one stays?
    > Keep the shared value; this project uses it from now on
      Replace it with this project's value (every project using the shared key changes too)
  ```

  For `<project>`, the same question with `the vault's value; these files use it from now on` and `Replace it with the value being moved (anything else reading kerstel://whasal/STRIPE_KEY changes too)`.

  Kerstel does not read other projects' or checkouts' files, so it cannot say who else reads the entry, and the prompt does not guess a count. The direct form refuses with the first sentence unless `--replace` is given. Either way, the value that loses is saved in the backup (§5.1).

### 3.3 What a move does not touch

`package.json` wiring, the launcher, and `.gitignore` stay as they are. If, after a move, no env file of the project holds a reference, the summary adds:

```
ℹ Nothing here reads the vault any more; ks uninstall removes the wiring.
```

## 4. Preview

Printed before Apply, in both forms. One block per key:

```
  STRIPE_KEY → Keep as plain text
    .env, .env.local:  kerstel://whasal/STRIPE_KEY  →  plain text (32 chars)
    kerstel://whasal/STRIPE_KEY is removed from the vault (nothing else here uses it)
```

### 4.1 No values

A value going into a file is shown as its length, whatever `isSafeToDisplay` says: the user picked the key, and the preview is about where it goes, not what it is.

### 4.2 Plain text into a file git would commit

For each file that would receive a plain-text value, when the project is a git repository:

- tracked (`git ls-files --error-unmatch <file>` succeeds), or
- not ignored (`git check-ignore -q <file>` fails),

the preview warns:

```
!  .env is tracked by git; STRIPE_KEY's value would be committed.
!  .env.local is not in .gitignore; STRIPE_KEY's value could be committed.
```

Interactive: the warning stays above Apply, and the default stays No. Direct: the command refuses unless `--allow-tracked` is given. Outside a git repository, or when `git` is not on `PATH`, no check is made and nothing is said.

### 4.3 Keys that cannot move

- **A reference the vault does not hold** (a teammate's clone before `init` filled it in): named, not offered. `Run ks init to store it first.`
- **A value the parser refused** (`init`'s unsupported lines): never listed.
- **A key in plain text with different values in different files**, moving into the vault: the same rule and wording as `init` (the value from the first file wins; the others survive in the backup).

## 5. Apply

In order:

1. **Backup** (§5.1). Printed as `✓ Backed up .env, .env.local`.
2. **Vault writes:** `setSecret` for every destination value.
3. **Env file rewrites,** each atomic: write the new bytes to a temp file in the same directory (`.<name>.kerstel-tmp`, mode copied from the original), `fsync`, then `renameSync` over the original. `init` writes env files with a plain `writeFileSync`, so this is a new helper, `writeFileAtomic` in `move/apply.ts`; a crash mid-write leaves either the old file or the new one, never half of each. A leftover temp file from a crash is removed on the next run.
4. **Vault deletions:** `removeSecret` for each project copy §3.1 allows.
5. **Project record:** `registerProject(scope, root)` only when the vault has no record for the scope. A record with a different root is left alone: overwriting it would make the next move in this checkout believe it is the only one, and §3.1 would delete copies the recorded checkout still reads.
6. One `✓` line per key.

**Rollback.** If step 2 or 3 fails, every vault entry step 2 touched goes back to its state from step 1: a replaced value is written back, a new entry is removed. Files already rewritten in step 3 are restored from the backup. Step 4 does not run. The command exits 1 naming what failed and the backup directory. A failure in step 4 or 5 leaves an extra vault entry or a missing record, which loses nothing, and is reported.

### 5.1 The backup

`createBackup` saves the env files to be rewritten, as `init` does. For a key already in the vault those files hold only `kerstel://` references, so the backup gains a `vault` section: every vault entry the move will delete (§3.1) or overwrite (§3.2), with its value, encrypted with the data key like the files, one `vault.enc` alongside the `.enc` files and its entries (`scope`, `key`, `bytes`, `sha256`, no value) listed in the manifest. `readBackup` returns it; `restoreBackup` ignores it, so restoring files never writes to the vault. The manifest stays `version: 1`, since the section is optional and older readers skip unknown fields.

## 6. Other commands

- **`uninstall`:** no change to what it restores; it reads backups through `readBackup`, which now also returns the `vault` section, and ignores it. It restores the references that remain; plain-text keys are already plain text; a deleted project copy is not a reference any more.
- **`doctor`:** no change.
- **`init`:** only the pointer line (§2.3).

## 7. Code

- `packages/cli/src/move/scan.ts`: the per-reference grouping from §2.1 step 1, over `loadEnvFiles` output.
- `packages/cli/src/move/plan.ts`: pure planner. Input: the scanned keys (key, files, current reference or value), the vault lookups it needs, the destinations, the registered root, the git status of each file. Output: the rewrites, vault writes, deletions, kept copies with reasons, conflicts, and warnings. No I/O.
- `packages/cli/src/move/apply.ts`: steps 1-6 of §5, the rollback, and `writeFileAtomic`, against the real vault and files.
- `packages/cli/src/move/git.ts`: the tracked/ignored checks, via `Bun.spawnSync`, returning `null` outside a repository.
- `packages/cli/src/commands/move.ts`: argument parsing, the prompts, the preview, apply.
- `index.ts`: `move` in the dispatcher and the help text.
- `packages/cli/src/init/backup.ts`: the optional `vault` section (§5.1).
- Reuses from `init`: env discovery and parsing, `explain`/`isSafeToDisplay`, `DESTINATION_CHOICES`, `formatReference`, `createBackup`, `restoreLineValue`, `setLineValue`.

## 8. Docs

- CLI page: a `move` row with both forms and the three flags.
- Getting started: a short "Changing your mind" section after the wizard.
- README: the command list.
- `init` copy that mentions the pointer line.
- Changelog: an `Added` line under 0.1.4.

## 9. Testing

- **Planner** (`move-plan.test.ts`): every row of the §3 table; an existing destination entry, shared and project, same and different value, with and without `--replace`; project copy deleted when unused, kept when another file still references it, kept when the recorded root differs, deleted when there is no record; a key with different references in different files (two rows, each naming its files); a key with a reference in one file and a plain value in another; a missing reference; nothing left to move.
- **Apply and backup** (`move-apply.test.ts`): the backup's `vault` section holds every deleted and overwritten value and `restoreBackup` leaves the vault alone; a failure injected at step 2 and at step 3 leaves the vault and files as they were; `writeFileAtomic` leaves no temp file behind and keeps the original's mode; a differing project record is never overwritten.
- **No terminal:** every row of the §2.4 table.
- **Git checks** (`move-git.test.ts`): a temp repository with a tracked file, an ignored file, and an untracked unignored file; no repository.
- **Command** (`move.test.ts`): the direct form end to end on a temp project and vault, including refusals, `--yes`, and exit codes; a scripted interactive run through the test prompter; the backup exists before the files change; no value appears in stdout or stderr.
- **init:** the pointer line appears on "Already migrated" and when plain-text keys remain.
