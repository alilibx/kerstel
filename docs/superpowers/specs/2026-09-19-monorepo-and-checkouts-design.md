# Monorepos and checkouts

**Status:** approved design, 2026-09-19. Extends §5 and §8 of the [product spec](2026-09-17-kerstel-secrets-manager-design.md).
**Release:** 0.2.0 ([#34](https://github.com/alilibx/kerstel/issues/34) monorepo support, [#13](https://github.com/alilibx/kerstel/issues/13) checkout tracking).
**Related:** the [terminal UI spec](2026-09-19-terminal-ui-design.md). Its References screen and `kerstel refs` read the registration this spec changes.

## 1. Problem

`kerstel init` treats the folder it runs in as one project, and the vault identifies a project by its scope name.

- **Monorepos.** A workspace with `apps/web`, `apps/api`, and `packages/db` needs three `init` runs, and nothing notices that all three hold the same `STRIPE_SECRET_KEY`.
- **Checkouts.** Two copies of one package, such as git worktrees, derive the same scope. `registerProject` upserts on the name, so the second `init` replaces the first checkout's root path. `uninstall` restores only the checkout it remembers; the other keeps `kerstel://` references that nothing can resolve once the vault is gone.

## 2. Definitions

- **Workspace root.** A directory whose `package.json` has a `workspaces` field, as an array of globs or an object with a `packages` array, or that has a `pnpm-workspace.yaml` beside its `package.json`. A `.git` directory is not a signal: a plain repo is one project.
- **Member.** A directory matched by a workspace glob, holding a `package.json`. Matching honours `!` negations, never descends into `node_modules` or a dot-directory, and sorts by path.
- **Package with env files.** A member, or the root itself, where `discoverEnvFiles()` finds at least one readable `.env*` file. Only these are set up; a library package with no env files is not listed.
- **Checkout.** One folder holding one package. A package has one scope and any number of checkouts.

## 3. Workspace detection

A new module, `packages/cli/src/init/workspace.ts`:

```ts
export interface Workspace {
  root: string;
  source: "package.json" | "pnpm-workspace.yaml";
  packages: DetectedProject[];   // root first when it has env files, then members by path
}
export function detectWorkspace(dir: string): Workspace | null;
```

- Globs expand with `Bun.Glob` relative to the root, directories only.
- `pnpm-workspace.yaml` is read for its `packages:` list only: a block sequence of plain or quoted strings. Any other shape prints one warning naming the file and treats the directory as no workspace, so a YAML feature Kerstel does not parse cannot silently set up the wrong folders.
- A root whose globs match nothing, or whose members all lack env files, is reported as a workspace with an empty `packages` list, so `init` can say so rather than fall back to setting up the root as a lone project.

`init` inside a member, or in any folder that is not a workspace root, behaves exactly as today. There is no upward search for a root.

## 4. `init` at a workspace root

1. **Refuse `--scope`.** A scope names one package. Exit `2` with `--scope names one package. Run kerstel init --scope <name> inside that package.`
2. **Pick.** After the banner, one step line: `Workspace: 4 packages with .env files`. Then a multiselect, every package preselected, labelled by its path relative to the root (`(root)` for the root itself) with a hint naming its env files and its `package.json` name. `--yes` and `--non-interactive` take all. An empty selection ends the run with `Nothing selected. Nothing was changed.` and exit `0`. An empty `packages` list ends it with `No package in this workspace has a .env file.` and exit `1`, as a lone project without env files does today.
3. **Detect and parse each selected package** through the existing per-package pipeline: `detectProject`, `loadEnvFiles`, `collectKeys`, the unreadable and unsupported warnings, each prefixed with the package's relative path.
4. **Teammate flow, per package,** for references whose values the vault lacks. Prompts name the package. `--from-stdin` JSON may nest by package path, `{"apps/web": {"KEY": "value"}}`, or stay flat, in which case a key applies to every package that lacks it.
5. **One overview.** Sections per package, each the same table `init` prints today. Suggestions come from the classifier with one workspace rule on top: a plaintext key that appears in two or more selected packages with the same value is suggested `global`, reason `same value in web and api`, unless the classifier says `plaintext`. With different values it stays `project` in each. `--global` and `--keep` apply across every package.
6. **One "Look right?".** Accept everything, change some from a checklist whose items read `web: DATABASE_URL`, or go one by one, package by package.
7. **One `.gitignore` question.** Its answer applies to the root's `.gitignore` and to each selected package's own `.gitignore` when it has one. The rewrite rule per file is today's.
8. **One "Apply these changes?".** The diff view shows every file of every package, labelled `web: .env`, `web: package.json`, `(root): .gitignore`, and so on. `--dry-run` stops here, as today.
9. **Apply, package by package,** in the order listed: encrypted backup under `~/.kerstel/backups/<scope>/<ts>/`, env rewrite, script wiring in that package's `package.json`, registration, then the self-check through that package's wired scripts. A package that fails stops the run with the package named; packages already applied stay applied and registered, and re-running `init` at the root is safe, since every step is idempotent today.
10. **Summary.** One line per package with its scope and its wired scripts, then the usual next steps.

Root scripts are wired only when the root itself is a selected package. A root `package.json` whose scripts call `turbo run dev`, `nx`, or `pnpm -r` spawns member scripts, which are wired, so the hook loads where the code runs.

## 5. Scope names

The rule is today's: the package's `package.json` name through `slugifyScope`, so `@acme/api` is `api`, and the directory basename when there is no name. Two members of one workspace cannot share a name, and sharing a slug across workspaces is handled by the collision rule in §6.

## 6. Checkouts

### 6.1 Schema

Schema version 3 rebuilds `projects`:

```sql
CREATE TABLE projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,          -- the scope
  root_path     TEXT    NOT NULL UNIQUE,   -- one row per checkout
  package_name  TEXT,                      -- the package.json name, when it has one
  created_at    INTEGER NOT NULL
);
CREATE INDEX projects_name_idx ON projects(name);
```

The migration copies every row with its `id`, so `secrets.project_id` and `audit_log.project_id` keep pointing where they did, and leaves `package_name` null for rows written before this version. A version-2 vault can hold two rows for one folder, from `init --scope a` and then `init --scope b` in the same place; the migration keeps the newest row per `root_path` and drops the rest. The dropped scope's secrets stay in the vault, since secrets are keyed by scope text, and `refs` lists them as referenced by no project if nothing else uses them.

`registerProject(scope, rootPath, packageName)` upserts on `root_path`. `listProjects()` returns every row; callers that want one entry per scope group the rows.

### 6.2 Recognising a checkout in `init`

Before registering, `init` looks at the rows that already hold the derived scope.

| Rows with this scope | Outcome |
| --- | --- |
| None | Register. |
| One whose `root_path` is this folder | Re-run on the same checkout. Register, which updates `package_name`. |
| One whose package is this package | A second checkout. Register a new row. |
| Otherwise | A different package with the same slug. Exit `2`: `The scope "api" belongs to @acme/api at /Users/ali/src/acme/apps/api. Re-run with --scope <name> to give this package its own.` |

"The same package" means the row's `package_name` equals this package's `package.json` name. A row with a null `package_name`, written before this version, is compared by reading the `package.json` at its `root_path`; when that folder is gone the row counts as the same package only if this package has no name and the two basenames match, which is the old rule's best guess. A package with no name in either place matches by basename.

### 6.3 A second checkout's values

The second checkout has either references, plaintext, or a mix.

- A reference the vault already holds resolves as it does for a teammate today, and nothing is stored twice.
- A plaintext key whose value equals the vault's becomes a reference with no store and no prompt. The overview marks it `already in the vault`.
- A plaintext key whose value differs is marked `differs from the vault` in the overview, and "Look right?" offers `keep the vault's value` (default) or `use this file's value`. Keeping rewrites the line to the reference, and the file's value survives only in the encrypted backup, exactly as a losing value does across env files today. Using it overwrites the vault's value, which from Next writes a `set` audit row.

### 6.4 Every checkout, everywhere

- **`uninstall`** already loops over every `projects` row, so it restores every checkout. A checkout whose folder is gone is reported as unreachable by its root, as today, and a secret counts as used when any checkout references it.
- **`refs`** and the UI's References screen group rows by scope and list each checkout root under it.
- **`doctor`** in a checkout is unchanged. At a workspace root it adds one line per registered package under that root, with the wired-script and reference counts `projectStatus` computes for a lone project.

## 7. Documentation changes

- `docs/cli.md`: the `kerstel init` row and flag table describe the root behaviour, the pick step, the shared-key rule, and the `--scope` refusal; the `--from-stdin` row describes the nested form. The `uninstall` row says every checkout is restored.
- `docs/getting-started.md` gains a short "In a monorepo" section. The README's `init` sentence mentions workspaces.
- The product spec §8 gets one paragraph pointing here.
- `CHANGELOG.md`: one `Added` line for monorepo `init`, one `Fixed` line for checkouts.

## 8. Testing

- **Detection:** fixtures for the `workspaces` array, the object form, `pnpm-workspace.yaml` with plain and quoted entries, a negation glob, a member under `node_modules` that must be skipped, a member without env files that must be excluded, an unparsable YAML that must warn, and a root with env files of its own.
- **`init` at a root** with the scripted prompter: all packages, a subset, an empty selection, `--yes`, `--dry-run` writing nothing, `--scope` refused, a shared key suggested `global`, a shared key with differing values kept per package, a failure in the second package leaving the first applied, and the nested `--from-stdin` form.
- **Migration:** a version-2 vault upgrades with every `id`, `name`, `root_path`, and `created_at` intact and `package_name` null; `secrets.project_id` still joins.
- **Registration:** each row of the table in §6.2, including the null `package_name` cases.
- **Second checkout:** equal values become references without a store, a differing value with each answer, references already in the vault.
- **`uninstall`** restores two checkouts of one package and reports a missing one.
- No test prints a value, and every temp tree, vault, and home is removed.
