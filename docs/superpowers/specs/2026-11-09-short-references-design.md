# Shorter references: `ks:<scope>`

- **Status:** draft for review, 2026-11-09
- **Release:** 0.2.0
- **Issue:** [#36](https://github.com/alilibx/kerstel/issues/36)
- **Builds on:** the product spec (`2026-09-17-kerstel-secrets-manager-design.md`, §4 references, §6 the hook), the `ks move` spec (`2026-09-24-move-keys-between-vault-and-plaintext-design.md`)
- **Later work it affects:** `kerstel refs` (#10) and `kerstel scan` (#52) parse references, so both start from the parser this spec defines

## 1. Problem

After `init`, a line in `.env` reads:

```bash
OPENAI_API_KEY=kerstel://global/OPENAI_API_KEY
```

The value repeats the key name and adds a ten-character scheme. In a file of twenty variables this is mostly noise. The reference itself has to stay: the hook resolves on it, it names one explicit scope, it turns the committed `.env` into a working `.env.example`, and `uninstall`, `doctor`, `move` and `run` find their work by parsing it.

## 2. Syntax

```bash
OPENAI_API_KEY=ks:global              # the vault key named like the variable
DATABASE_URL=ks:my-app
OPENAI_KEY=ks:global/OPENAI_API_KEY   # a different vault key
STRIPE_SECRET_KEY=kerstel://my-app/STRIPE_SECRET_KEY   # still accepted, never removed
```

| Form | Means | Needs the variable name |
|---|---|---|
| `ks:<scope>` | The key in `<scope>` with the same name as the variable it is assigned to | Yes |
| `ks:<scope>/<KEY>` | The key `<KEY>` in `<scope>` | No |
| `kerstel://<scope>/<KEY>` | Same as above, the 0.1 form | No |

Rules:

- The scope and key patterns don't change (`reference.ts`: scope `^[a-z0-9][a-z0-9._-]*$` up to 64 characters, key `^[A-Za-z_][A-Za-z0-9_]*$` up to 128).
- `ks:` matches in any case (`KS:`, `Ks:`), as URI schemes do. Kerstel always writes it lowercase. `kerstel://` keeps matching exactly as it does today.
- The whole value must match. Leading or trailing spaces, a third segment, or an empty scope or key mean it is not a reference. That is the rule today, and it is what keeps a real value from being read as a reference.
- `ks:<scope>` under a variable whose name is not a valid key (`FOO.BAR`) is not a reference. It is left alone as plain text, as any other non-matching value is.

## 3. Parsing

`parseReference(value, name?)` returns `{ scope, key }` or null, as today. It adds one argument: the name of the variable that holds the value.

- With a name, `ks:<scope>` resolves to `{ scope, key: name }`.
- Without a name, `ks:<scope>` returns null. Callers without a name are the ones that take a reference typed on its own: `kerstel resolve`, and the `scope/KEY` argument of `get`, `set` and `rm`. They report it with a hint: `ks:global needs a key here: ks:global/OPENAI_API_KEY`.

Every caller that reads a dotenv line or an environment variable has the name, so it passes it: `run`, `init` (collect, display, status), `uninstall`, `move`, `doctor`, and the hook.

The hook's own copy in `packages/hook/src/protocol.js` changes the same way. `REFERENCE_FIXTURES` gains a `name` column and the new cases, and the test that proves the two parsers agree runs on every row.

## 4. Writing

| Writer | Writes |
|---|---|
| `init`, for a key stored in the vault | `ks:<scope>` when the variable and vault key share a name, otherwise `ks:<scope>/<KEY>`. The one exception is in §5.1. |
| `ks move` between scopes | The same rule, with the same exception (§5.1). A line `move` rewrites switches to the short form, including a `kerstel://` line. |
| Messages that show a reference on its own (`set`, `rm`, `resolve`, the daemon's `not_found`, `init`'s summary, `uninstall`'s plan, `doctor`) | `ks:<scope>/<KEY>`, which still means the same thing when copied somewhere else |
| `uninstall` | Restores the plain value in place of either form |

`init` and `move` leave other lines alone. An existing `kerstel://` line keeps working, and re-running `init` does not rewrite it (§7, question 1).

## 5. Risks

### 5.1 A shorthand copied under another name

`ks:<scope>` means different keys under different names. Inside a hooked process this can't go wrong: the hook resolves on read, so `env: { B: process.env.A }` copies the value, not the reference, and children get resolved values. It can go wrong where a reference is copied as text before the hook sees it:

- variable expansion in env files (`B=${A}`), which `@next/env`, `dotenv-expand` and Docker Compose all do;
- a shell copying one variable to another (`export B=$A`) before `kerstel exec`.

`B` then holds `ks:global`, which resolves to `global/B`, not `global/A`. Usually there is no `global/B`, and the read fails with `not_found`. If one exists, `B` silently gets the wrong secret.

What this spec does about it:

- **`init` and `ks move` write the full form for any variable that an expansion in the same project's env files uses.** Both already read every env file they change, so they can see `${A}` and `$A`. Both writers need the check: if `move` shortened `A=kerstel://old/A` to `A=ks:new` and left `B=${A}` alone, `B` would look up `new/B`. That covers the common case, which is a Next.js or Compose project.
- The `not_found` error for a shorthand names both the variable and the key it looked for: `B is ks:global, so Kerstel looked for global/B. If B was copied from another variable, write ks:global/<KEY>.`
- The docs say it once, on the references page: copy a reference with its key (`ks:global/A`), never the shorthand.

### 5.2 Older Kerstel reading the short form

A project's `.env` is committed. A teammate or CI machine with Kerstel 0.1.x reads `ks:global` as plain text, so the app gets the literal string. Failures are loud in practice: an API rejects `ks:global` as a key, and a driver can't parse `ks:my-app` as a URL. They are confusing, though.

- The release notes and the references page say that projects set up with 0.2.0 need Kerstel 0.2.0 on every machine that runs them.
- `kerstel doctor` (0.2.0 and later) shows which reference forms a project uses.
- No version check in the launcher. The 0.1 `exec` ignores unknown arguments before `--`, and the only other way to find the installed version, `kerstel --version`, can make a network request. A check would cost every script run and still miss the hook.

### 5.3 A real value that looks like a reference

A plain value such as `ks:prod` now parses as a reference. Under the full-match rule (§2), only a value made of `ks:`, a lowercase scope and nothing else matches. `init` already lists references the vault lacks and asks for their values, so a value read this way is shown to the user, not dropped. The old `kerstel://` form has the same exposure, with a longer prefix.

## 6. Changes by area

- **`packages/cli/src/reference.ts`**: `parseReference(value, name?)`, a `formatEnvReference(name, scope, key)` for lines, and `formatReference` returning `ks:<scope>/<KEY>`. `REFERENCE_PROTOCOL` becomes a list of accepted prefixes.
- **`packages/hook/src/protocol.js`**: mirrors the parser. `preload.js` passes the property name, which it already has in the `get` trap and in the Bun startup pass.
- **`init`**: writes the short forms, and checks expansions (§5.1).
- **`move`**: writes the short forms, and checks expansions the same way `init` does. Its row IDs use the canonical `scope/KEY` pair, not the text in the file, so a `kerstel://` line and a `ks:` line for the same key are one row.
- **`run`, `uninstall`, `doctor`**: pass the variable name. `doctor`'s ".env holds only kerstel:// references" line becomes "only references", and it gains a line counting each form.
- **Copy**: README, the website pages that show references (getting started, how it works, CLI, deploying, teams, security, the home page), the hero animation, and `kerstel --help`.
- **Tests**: the fixtures table with names; the hook-vs-CLI parity test; `init` and `move` each writing both forms, and each writing the full form for a variable another line expands; `uninstall` restoring a shorthand line; `run` and the hook resolving all three forms; `resolve` refusing a bare shorthand with the hint.

## 7. Open questions

1. **Shorten existing `kerstel://` lines?** The issue proposes an opt-in step when `init` is re-run. Recommendation: leave it out of 0.2.0. Both forms work forever, and rewriting committed files makes diffs for no change in behaviour. `ks move` already shortens any line it rewrites.
2. **A `--long` flag for `init`?** Recommendation: no. The full short form `ks:<scope>/<KEY>` is always valid to write by hand, and an extra flag adds a second output format to test.
3. **How `ks ls` shows keys.** It prints `kerstel://scope/KEY` today. Recommendation: `ks:scope/KEY`, matching §4.
