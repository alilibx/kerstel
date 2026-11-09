# `kerstel scan`: find every env file and what it holds

- **Status:** approved design, 2026-11-09
- **Release:** 0.2.0
- **Issue:** [#52](https://github.com/alilibx/kerstel/issues/52)
- **Builds on:** the product spec (`2026-09-17-kerstel-secrets-manager-design.md`, §5 the `init` classifier), the monorepo spec (`2026-09-19-monorepo-and-checkouts-design.md`, §2 and §3 workspace detection), the short references spec (`2026-11-09-short-references-design.md`)
- **Later work it affects:** `init` at a monorepo root (#34) uses the workspace detection this PR builds. `kerstel refs` (#10) reads the same per-file report.

## 1. Problem

`init` answers one question for one folder: "set up this project". Nothing answers the one that comes first: which env files on this machine, or in this monorepo, still hold secrets in plain text? People have them in old projects, in `.env.bak` copies left over from before `init`, in templates that someone filled in with a real key, and sometimes in git.

`kerstel scan [path]` walks a tree and reports every env file it finds. It reads; it never writes, registers, or migrates.

## 2. What it reports

### 2.1 Files

The walk looks at every file whose name `detect.ts` recognises, sorted into three kinds:

| Kind | Names | How its lines are judged |
|---|---|---|
| env | `.env`, `.env.local`, `.env.production`, ... (`isEnvFileName`) | Every line, §2.2 |
| template | `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, and their `.local` forms | Only for values that are certainly real, §2.2 |
| backup | `.env.bak`, `.env.orig`, `.env~`, the swap files, ... (`isBackupEnvFileName`) | Every line, as env. A `.swp` or `.swo` file is binary, so it is listed but not read. |

Templates are new to Kerstel. `init` skips them because nothing loads them, but they are usually committed, so a real key pasted into one is the leak most likely to already be public.

### 2.2 Lines

Each line gets one verdict. A new `judge(key, value)` in `init/classify.ts` decides it, built on `explain()` so the two cannot drift:

| Verdict | When | Example |
|---|---|---|
| reference | `parseReference(value, key)` returns a reference (any of the three forms) | `OPENAI_API_KEY=ks:global` |
| secret | `explain()` says the vault, for a reason that names a credential: the key's name, a URL with a password or a token in its query, or a key in `GLOBAL_KEYS`. Also any value with a known token prefix (`sk_`, `ghp_`, `AKIA`, a JWT, ...), whatever its key, so `NEXT_PUBLIC_STRIPE_KEY=sk_live_...` counts. Also a PEM private key block. | `STRIPE_SECRET_KEY=sk_live_...` |
| unclear | `explain()` says the vault only because it could not tell (`Might be a secret, so it's safer in the vault`) | `APP_NAME=Northwind Traders` |
| config | `explain()` says plaintext | `PORT=3000` |

In a template only the certain signals count, since `STRIPE_SECRET_KEY=sk_test_xxx` and `DATABASE_URL=postgres://postgres:postgres@localhost/app` are what templates are for. `isTemplateSecret(value)` is true for:

- a known token prefix,
- a URL with a password in its userinfo,
- a URL with a credential in its query (`SECRET_QUERY`, as `explain()` uses it),
- a PEM block (below),

and, for the first three, only when the credential part (the text after the prefix, the password, or the query parameter's value) looks real: 16 or more characters, mixing letters and digits, with no run of three or more `x`, `X`, `*` or `0`, and none of the words `your`, `here`, `replace`, `example`, `changeme` in any case. So `sk_test_xxx`, `ghp_your_token_here` and `postgres:postgres@` are placeholders, and `?token=8f3kQ2...` is not. Everything else in a template is config.

`parseDotenv` puts a value it can't read in `unsupported` and never hands its text on, on purpose: inspecting it would mean reading key material. `scan` judges those entries without their values:

- **A PEM block is a secret.** The parser already recognises an unquoted one by its `-----BEGIN ...-----` header. This PR has it also recognise a quoted value whose first line is a PEM header (`KEY="-----BEGIN PRIVATE KEY-----`, then the body), and mark both entries `pem: true` on `UnsupportedValue`. The judgement reads that flag, so the body is never inspected. This applies in templates too.
- **Any other value that spans lines** is judged by its key's name alone: a name that announces a credential (`SECRET_KEYS`) makes it a secret, any other name makes it unclear.
- **A line that is not `KEY=value`** is listed as an unreadable line with its line number, not judged.

### 2.3 References

A reference is checked against the vault by name only, with `readStoredReferences(vaultPath())`: the `secrets` table's `scope` and `key` columns are not encrypted. `scan` never fetches the data key, never shows a Keychain prompt, and never creates `~/.kerstel`. With no vault, every reference is reported as not in this vault.

### 2.4 Git

For each env file inside a git work tree, `scan` records one of the statuses `ks move` already uses (`move/git.ts`):

- **tracked:** git has the file. If it holds a secret, this is the worst case and is flagged first.
- **not ignored:** not tracked, but `git add .` would add it.
- **ignored:** fine.

Git is asked once per repository, not once per file: `git ls-files -z -- <files>` and `git check-ignore -z --stdin`, each with that repository's env files. A repository is a directory the walk finds a `.git` in (a directory, or a file for a worktree or submodule), or the one `git rev-parse --show-toplevel` names for the scan root. Without git on `PATH`, the status is left out and the summary says so once.

A reference-only file that git tracks is fine; `init` suggests committing one. Git history is out of scope: a secret removed from a tracked file is still in history, so the advice for a tracked file says to rotate the key.

## 3. The walk

`kerstel scan` with no path scans the current directory. `kerstel scan ~` scans the home directory.

- **Never descends into:** `node_modules`, `.git`, `.hg`, `.svn`, `.kerstel` (its backups are encrypted), package manager and tool caches (`.cache`, `.npm`, `.pnpm-store`, `.yarn`, `.bun`, `.nvm`, `.cargo`, `.rustup`, `.gradle`, `.m2`, `.venv`, `__pycache__`, `.tox`), `.Trash`, and on macOS `~/Library`. The list is one constant in the scan module.
- **Never follows a symlinked directory,** and never crosses into another filesystem (the device number changes), the same rule as `find -xdev`. That keeps it out of network mounts, `/Volumes`, and `/proc`. A symlinked env file is read, as `init` reads one.
- **Unreadable directories** are counted, and listed with `--verbose`. They never stop the walk and never change the exit code.
- **No depth limit.** The skip list is what keeps a home directory fast. On a terminal, a progress line on stderr shows the folder count and is cleared when the walk ends. Ctrl-C stops the walk and prints nothing more.
- **macOS privacy prompts.** Scanning `~` reads Desktop, Documents and Downloads, so macOS may ask once whether the terminal can access them. Answering Don't Allow makes them unreadable folders. The CLI docs say so.

## 4. Projects and workspaces

Files are grouped by project, so the report says what to run where.

- **Project:** the nearest folder at or above the env file, up to the scan root, that holds a `package.json`. An env file with no such folder is grouped under its own folder and marked `no package.json`.
- **Workspace:** a project whose `package.json` has a `workspaces` field or that has a `pnpm-workspace.yaml`. Its members are grouped under it. This PR builds `detectWorkspace()` in `init/workspace.ts` exactly as monorepo spec §3 specifies it, so #34 only has to use it. There is no upward search for a workspace root: scanning inside `apps/web` reports `apps/web` as its own project, as `init` there would treat it.
- **Set up:** a project whose folder has a `projects` row (`readProjectRows`, no key needed) shows its scope.
- **Where `init` reaches.** `init` reads env files directly in a package folder, never in its subfolders. An env file in a project's own folder is one `init` would migrate. A nested one (`repo/config/.env`, `repo/docker/.env`) is still grouped under the project, but the summary gives it its own advice (§5.1), since running `init` would leave it as it is.

## 5. Output

### 5.1 Terminal

```
Scanned ~/src: 1,284 folders, 37 env files

shop  ~/src/shop  workspace, 3 packages
  apps/web
    .env            ✗ 4 secrets · tracked by git
    .env.local      ✓ 6 references
  apps/api
    .env            ! 2 secrets, 1 unclear · not ignored by git
    .env.bak        ! backup copy · 3 secrets
    docker/.env     ! 1 secret
  packages/db
    .env.example    ✗ template · 1 secret · tracked by git

blog  ~/src/blog  set up as blog
  .env              ! 1 reference not in this vault (ks:blog/RESEND_API_KEY)

scripts  ~/src/scripts  no package.json
  .env              ! 1 secret

12 more projects with nothing to do (--all lists them)

✗ 2 files with secrets are tracked by git. Untrack them (git rm --cached <file>),
  then rotate the keys: they stay in git history.
    ~/src/shop/apps/web/.env
    ~/src/shop/packages/db/.env.example
! 1 project holds secrets in plain text. Run kerstel init in it:
    ~/src/shop
! 2 files kerstel init doesn't read hold secrets. Store each value with
  kerstel set, then replace it with its ks: reference, or delete the file:
    ~/src/shop/apps/api/docker/.env
    ~/src/scripts/.env (no package.json)
! 1 backup copy holds secrets. Delete it:
    ~/src/shop/apps/api/.env.bak
```

- Counts only by default. `--keys` adds the key names and line numbers under each file, never values.
- A project with nothing to do (only references that resolve, config, and templates without secrets) collapses into the "more projects" line. `--all` lists it.
- A workspace with plaintext gets one `kerstel init` line at its root, which #34 makes set up every package. (Between this PR and #34 landing, the line names each package folder instead.)
- Each file with secrets is named in exactly one advice group, checked in this order: tracked by git, template (replace the value with a placeholder and rotate the key), backup copy (delete it), a file `init` reads (run `init` in the project, or at its workspace root), and any other file (§4: a nested env file, or one outside any Node or Bun project).
- The ✗ marks are reserved for secrets git tracks and secrets in templates, since those are likely already shared. `!` is everything else that needs action.
- Nothing found at all: `No env files under ~/src.` and exit `0`.

### 5.2 `--json`

One object on stdout, for CI and scripts. It always includes key names and line numbers, never values:

```json
{
  "root": "/Users/ali/src",
  "folders": 1284,
  "unreadable": ["/Users/ali/src/private"],
  "git": true,
  "projects": [
    {
      "path": "/Users/ali/src/shop/apps/web",
      "workspace": "/Users/ali/src/shop",
      "packageJson": true,
      "scope": null,
      "files": [
        {
          "name": ".env",
          "kind": "env",
          "git": "tracked",
          "secrets": [{ "key": "STRIPE_SECRET_KEY", "line": 3 }],
          "unclear": [],
          "config": 2,
          "references": [{ "key": "OPENAI_API_KEY", "line": 1, "ref": "ks:global/OPENAI_API_KEY", "inVault": true }],
          "unreadableLines": []
        }
      ]
    }
  ]
}
```

`ref` is always the full `ks:<scope>/<KEY>` form, even when the line has the shorthand. `git` is `null` outside a repository. The shape is documented on the CLI page and covered by a test, so changing it is a breaking change.

## 6. Exit codes

| Code | When |
|---|---|
| `0` | No secret in plain text anywhere: no secret line in an env, backup, or template file. Unclear lines, unresolved references, and unreadable folders don't count. |
| `1` | At least one secret line. |
| `2` | Bad usage: the path doesn't exist or isn't a directory, or an unknown flag. |

So `kerstel scan` works as a CI step or a cron job as it is. An unresolved reference is `doctor`'s concern, as it is for `refs`.

## 7. Decisions

1. **Unclear lines don't fail the scan.** `explain()` sends anything it can't place to the vault, which is the right default for `init` but would make `scan` fail on `APP_NAME=Northwind Traders` forever, with no way to say "this one is fine". They are shown, and `--keys` names them. A `--strict` flag can come later if people ask.
2. **No allow list for keys kept in plain text on purpose in 0.2.0.** Every secret line is a finding. If a team keeps one on purpose, the right fix is the vault. If this turns out to be noisy, a `# kerstel: plaintext` comment on the line is the likely shape later.
3. **Template placeholders that look like tokens** (`sk_test_xxx`, `ghp_your_token_here`) are not secrets. The rule is in §2.2. The test fixture lists the placeholders seen in popular starters.
4. **`kerstel ui` gets no Scan screen in 0.2.0.** The References screen stays as the terminal UI spec defines it: registered checkouts only. A Scan screen would reuse this module, but it is not part of #8, #9, or #10.
5. **`scan --init`, chaining into migration, comes later.** 0.2.0 only reports.

## 8. Changes by area

- **`packages/cli/src/scan/`** (new): `walk.ts` (the walk and skip list), `report.ts` (per-file judgement, projects, git), `render.ts` (terminal and JSON).
- **`init/workspace.ts`** (new): `detectWorkspace()`, monorepo spec §3.
- **`init/classify.ts`:** `judge(key, value)` and `isTemplateSecret(value)`, next to `explain()`.
- **`init/detect.ts`:** exports the template test (`isTemplateEnvFileName`), and moves the `.swp`/`.swo` names into a helper so `scan` knows not to read them.
- **`init/dotenv-file.ts`:** `UnsupportedValue` gains `pem?: true`, set for an unquoted PEM block and for a quoted value whose first line is a PEM header. `init`'s messages don't change.
- **`move/git.ts`:** a batched `gitStatuses(repo, files)` beside `gitFileStatus`, which `move` keeps using.
- **`commands/scan.ts`** and **`index.ts`:** the command, its flags (`--keys`, `--all`, `--json`, `--verbose`), and the `--help` line.
- **Copy:** the CLI docs page (command row, the JSON shape, the macOS prompt note), getting started (a "Find what's left" step), the security page (scan as an audit), and the README command list.
- **`CHANGELOG.md`:** one `Added` line.

## 9. Tests

- **Walk:** a temp tree with nested projects, `node_modules` and `.git` holding env files that must be skipped, a symlinked directory that must not be followed, a symlinked env file that is read, an unreadable directory counted without failing, and a tree with no env files.
- **Judgement:** `judge()` on every row of §2.2, including a token-prefixed value under a `NEXT_PUBLIC_` key, a shorthand reference, and the template rules with real keys, real query tokens, and placeholders. A complete multi-line PEM file, unquoted and quoted, in an env file and in a template, counts as a secret through the report and makes the scan exit `1`.
- **Advice:** a nested env file with a secret gets the `kerstel set` advice, not `init`; each advice group in §5.1's order.
- **Workspaces:** the monorepo spec §8 detection fixtures, and members grouped under their root.
- **Git:** tracked, not ignored, and ignored files in a temp repo, a file in a nested repository, and git missing from `PATH`.
- **References:** in the vault, not in it, and no vault at all, with no `~/.kerstel` created.
- **Output:** the terminal report with and without `--keys` and `--all`, the JSON shape, and each exit code.
- **No values:** every test scans fixtures whose values are unique markers and asserts that no marker appears in stdout or stderr, in every output mode.
