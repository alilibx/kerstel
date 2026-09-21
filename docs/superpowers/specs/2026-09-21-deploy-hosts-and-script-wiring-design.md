# Deploy hosts and script wiring

**Status:** approved design, 2026-09-21. Replaces the wiring rule in §6.2 of the [product spec](2026-09-17-kerstel-secrets-manager-design.md) and extends §8 step 4.
**Release:** 0.1.3 ([#60](https://github.com/alilibx/kerstel/issues/60) `Bun.env`, [#61](https://github.com/alilibx/kerstel/issues/61) compound scripts, [#62](https://github.com/alilibx/kerstel/issues/62) the launcher).
**Related:** the [monorepo and checkouts spec](2026-09-19-monorepo-and-checkouts-design.md), whose per-package wiring step (§4 step 9) runs the wiring this spec defines. The [research notes](../research/2026-09-21-deploy-hosts-and-script-wiring-research.md) hold the host, framework, and prior-art findings this spec rests on.

## 1. Problem

`kerstel init` rewrites every non-lifecycle `package.json` script to `kerstel exec -- <command>`. Three things go wrong with that, all found on real projects on 2026-09-20.

1. **Deploy hosts run wired scripts without the binary.** Vercel, Netlify, Cloudflare Pages, Railway, Fly.io, Heroku, Coolify, Google Cloud Buildpacks, Azure App Service, DigitalOcean App Platform, Docker image builds, and GitHub Actions all run `npm run build`, and most also run `npm start`. None has `kerstel`, so the script dies with `kerstel: command not found`. There is nothing for Kerstel to do on those hosts: values come from the host's own secret store, and `.env` is either gitignored or holds only references. This hits every user who deploys.
2. **Compound scripts are half wired.** `"dev": "kerstel exec -- node scripts/copy.mjs && next dev"` runs only the first command under Kerstel. The shell splits on `&&`, so `next dev` starts unhooked, reads the literal `kerstel://` string, and the app fails with an error that names neither Kerstel nor the cause. The same happens with `||`, `;`, and `|`. A leading assignment, `NODE_ENV=x next dev`, breaks outright: `NODE_ENV=x` becomes the executable. `doctor` counts every such script as wired.
3. **`Bun.env` is hook-blind.** The hook replaces `process.env` with a Proxy. `Bun.env` still points at the raw object and returns the reference.

## 2. What the research settled

Full findings, with citations, are in the research notes. The points that shaped this design:

- **Hosts read script names, not script text.** The names a host runs on its own are `build`, `start`, npm's implicit `prebuild`, `postbuild`, `prestart`, `poststart`, and the host-specific `vercel-build`, `now-build`, `heroku-prebuild`, `heroku-build`, `heroku-postbuild`, `heroku-cleanup`, `gcp-build`, `apphosting:build`, `build:azure`, Netlify's `*:build`, and Expo's six `eas-build-*` hooks. A wrapped `build` does not break host detection: Netlify substring-matches `next build` inside the wrapped text. The one open question is AWS Amplify, which classifies a Next app by its `build` script's text; whether that match is a substring test is UNKNOWN.
- **Every binary-only peer leaves host commands alone.** Doppler, Infisical, and 1Password never ask users to put their CLI in `package.json`. Hosts get secrets by a sync integration or an image `ENTRYPOINT`. dotenvx, an npm package, degrades to "log the error, run anyway" unless `--strict`.
- **A shell fallback is not portable.** npm uses `cmd.exe` on Windows, which has no `command` builtin and no `/dev/null`, and the Bun Shell rejects `>/dev/null 2>&1`. `node ./file.cjs` behaves the same under npm, pnpm, Yarn, and `bun run` on every OS, which is why husky moved its `prepare` hook to `node .husky/install.mjs`.
- **A committed file must be inert.** The 2025 npm compromises (chalk, Shai-Hulud, nx) all ran at install time. A launcher that downloads nothing and has no `postinstall` adds no such surface.
- **Local unwired builds have a real cost in four frameworks.** SvelteKit `$env/static/private`, Astro's private `import.meta.env`, Nuxt `runtimeConfig` defaults, and Next's prerendered HTML all bake whatever `process.env` holds at build time. Every other framework reads `process.env` at runtime and is hook-friendly, so `build` must stay wired on the developer's machine.
- **`Bun.env` cannot be made lazy.** Measured on Bun 1.4.2: `Bun.env` is the same raw object as the original `process.env`; the property is non-configurable and non-writable, `globalThis.Bun` is too, and Bun's env object rejects accessor descriptors. The only correct fix is eager.
- **Turborepo strict mode strips the hook's variables.** `NODE_OPTIONS` is on Turborepo's built-in pass-through list; `KERSTEL_SOCKET`, `KERSTEL_TOKEN_FILE`, and `KERSTEL_HOOK_DIR` are not.

## 3. Options and the choice

| Option | Verdict |
| --- | --- |
| **Wire only scripts a host never runs.** A pick step in `init`, host-run names deselected. | Rejected. The four frameworks above need `build` hooked locally, so every SvelteKit and Astro user would have to remember `kerstel exec -- npm run build`. It also leaves a heuristic name list to maintain. |
| **A committed launcher.** `node .kerstel/exec.cjs -- <command>` in every script; the file runs `kerstel exec` when the binary exists and the command unchanged when it does not. | **Chosen.** Covers every host at once, because every host runs scripts through the package manager, and keeps `build` hooked locally. Costs: one file in the repo, one extra `node` start per script, and longer script lines. |
| **Install Kerstel on the host.** | Rejected. It would create a vault on the host for nothing. |
| **An npm shim package.** | Rejected. It conflicts with the shadowed-binary defence from 0.1.2, adds a dependency to every project, and puts Kerstel on the install-time attack surface. |
| **One `kerstel exec -- sh -c '<script>'` per compound script.** | Rejected for compound scripts. `sh` is not on `cmd.exe` or the Bun Shell, and quoting the whole script inside the wrapper is fragile. Per-command wrapping keeps each script readable and reversible. |

## 4. The launcher

### 4.1 The file

`init` writes `.kerstel/exec.cjs` at the package root. It is committed, like `package.json`. It is plain CommonJS with no dependencies, no install-time behaviour, and nothing that downloads. The first line is a fixed marker with a format version, `// Kerstel launcher, format 1. Written by kerstel init; edits are overwritten on the next run.`, followed by a short comment saying what it does and linking to `https://kerstel.dev/docs/deploying`. The format version changes only when the file's behaviour changes, so a CLI release does not touch every repo.

`init` writes the file whenever at least one script is wired in any form, and rewrites it whenever the file on disk differs byte for byte from the text this Kerstel generates: an older format, a hand edit, or a tampered copy all come back to the generated text, which is what the marker line promises. A file that already matches is left alone and not shown. The apply step shows a write as `Writing .kerstel/exec.cjs`, and the diff view lists a new file with its full text and a changed one as a normal diff, since it holds no secret.

A `.gitignore` line that would hide `.kerstel/` is reported in the `.gitignore` step, `!  .gitignore hides .kerstel/, so the launcher would not reach your deploy host. Remove that line before committing.`, and left alone; `init` never edits lines other than the env-file lines it owns today.

### 4.2 What it does

The launcher takes everything after the first `--` as the command.

1. **Find the binary.** It walks `PATH` looking for `kerstel` (`kerstel.exe` on Windows), skipping every directory whose path contains a `node_modules/.bin` segment. npm and bun put `node_modules/.bin` first on `PATH` when running a script, and the shadowed-binary defence exists because a dependency can plant a `kerstel` there. `kerstel exec` still runs its own check afterwards; this skip keeps the launcher from being the thing that hands the command to the shadow.
2. **With the binary,** it spawns `kerstel exec -- <command>` with inherited stdio, forwards `SIGINT`, `SIGTERM`, and `SIGHUP` to the child, and exits with the child's exit code, or `128` plus the signal number when the child died of a signal. Everything `exec` does today stays where it is: the shadow tripwire, the missing-command message and exit `127`, the hook install, the daemon start, `--preload` for a `bun` command.
3. **Without the binary,** it writes one line to stderr, `kerstel: not installed here, running without it: next build`, and spawns the command as written with the same stdio and signal handling. A command that cannot start prints `kerstel: "next" was not found on PATH.` and exits `127`, or `126` when it exists but cannot run, matching `exec`. The line always prints, on a deploy host and on a teammate's fresh clone alike: on a host it is one line of noise per script, on a clone it is the only hint that the app is about to read literal references.

On macOS and Linux the command runs through `child_process.spawn` with no shell, so arguments reach the child byte for byte. Under `bun run`, Bun runs `node .kerstel/exec.cjs` with the system `node`, or with itself when `node` is absent, and either way step 2 hands the command to `kerstel exec`, which adds `--preload` for Bun.

### 4.3 Windows

The launcher looks for `kerstel.exe`, and resolves the command it runs without the binary through `PATH` and `PATHEXT`. On Windows the executables a package installs, `next`, `vite`, and every other `node_modules/.bin` entry, are `.cmd` shims, and Node refuses to spawn a `.cmd` or `.bat` file without a shell. When the resolved file ends in `.cmd` or `.bat`, the launcher runs it through `cmd.exe /d /s /c` with the command line built the way npm's own `@npmcli/run-script` builds it: each argument wrapped in double quotes with inner quotes doubled, and `cmd.exe`'s metacharacters (`&`, `|`, `<`, `>`, `^`, `%`, `!`, and parentheses) escaped with `^`. Any other resolved file (`.exe`, a `#!` script under Git Bash is not a case here) is spawned directly, as on the other platforms. Windows binaries are a Later roadmap item, so until they ship every Windows run takes step 3, and a Windows teammate on a wired repo depends on this path.

## 5. Wiring scripts

### 5.1 The prefix

`EXEC_PREFIX` becomes `node .kerstel/exec.cjs -- `. The old prefix, `kerstel exec -- `, stays recognised everywhere as the **legacy form**: `init` converts it, `doctor` names it, `uninstall` strips it.

### 5.2 Simple commands

A script that is one simple command is wired as today, with the prefix in front of the command word rather than the string: `NODE_ENV=production next start` becomes `NODE_ENV=production node .kerstel/exec.cjs -- next start`. `sh` and the Bun Shell both apply a leading assignment to the command that follows it, so `NODE_ENV` still reaches `next` through the launcher and `exec`, both of which pass their environment on unchanged.

### 5.3 Compound scripts

The wirer tokenises the script with POSIX shell rules: words split on unquoted whitespace, single quotes take everything literally, double quotes honour backslash escapes, and a backslash outside quotes escapes the next character. It recognises the operators `&&`, `||`, `;`, and `|`, and splits the script into simple commands at them. Each simple command is its leading `NAME=value` words, then a command word, then arguments. The prefix is inserted at the character offset of the command word, so the rest of the script stays byte-identical, quoting and spacing included.

Some command words never run JavaScript and are **left unwrapped** so a `rm -rf dist` does not start the daemon:

| Left unwrapped | Why |
| --- | --- |
| `echo`, `printf`, `true`, `false`, `exit`, `test`, `[`, `sleep` | Shell builtins and no-ops |
| `rm`, `rmdir`, `mkdir`, `cp`, `mv`, `touch`, `ls`, `cat`, `chmod`, `ln`, `tar`, `gzip` | File utilities that start no process |
| `docker`, `curl`, `wget` | Never load the hook |

`find` and `git` are not on the list: `find -exec node ...` and a git hook can start a Node process, which would then run unhooked.

Anything else is wrapped, including `make`, `env`, `sh`, `bash`, `npx`, `bunx`, `npm`, `pnpm`, `yarn`, and `bun`: the hook reaches every Node and Bun descendant through `NODE_OPTIONS`, so `sh -c "node x.js"` under the launcher is hooked too. A command word that is `kerstel`, or `node` followed by `.kerstel/exec.cjs`, is already wired.

The **whole script is skipped**, with the reason shown in the wiring summary and in `doctor`, when it contains any of:

| Reason | Trigger |
| --- | --- |
| `changes directory` | A command word `cd`, `pushd`, or `popd`. The launcher path is relative to the package root, and npm runs the script there; after a `cd` it would not be found. |
| `shell control` | `(`, `)`, `{`, `}`, backticks, `$(`, a newline, or a command word `if`, `for`, `while`, `until`, `case`, `export`, `set`, `unset`, `source`, `.`, `eval`, `exec`, `!`, `command`, `builtin`, `time`, `[[`. `exec` runs its first argument without a shell, so a builtin in command position would be looked up on `PATH` and fail. |
| `redirection` | `<`, `>`, `>>`, `2>`, `&>`, or a lone `&` |
| `unbalanced quote` | A quote with no closing partner |
| `no command` | A simple command that is only assignments, or an operator with nothing after it |
| `nothing to wire` | Every command word is on the left-unwrapped list, as in `rm -rf dist` |

A skipped script keeps its text and is never counted as wired, with one exception. An older `init` put one prefix in front of the whole script whatever its shape, and a script the tokeniser cannot read (a redirection, a subshell, an open quote) that starts with a prefix still runs through the shell and still works: it counts as wired, `init` leaves it alone, and `uninstall` strips the leading prefix. A script refused for a command word, such as `kerstel exec -- cd x && node a.js`, is broken (`exec` cannot run `cd`) and stays refused with that reason. The rules look through an existing `kerstel ... -- ` to the word after it, so a wrapped `cd` is still a `cd`. Re-running `init` on a script wired by an older Kerstel finishes it: `kerstel exec -- node a.js && next dev` becomes `node .kerstel/exec.cjs -- node a.js && node .kerstel/exec.cjs -- next dev`.

Each refused script is named on its own line before the overview, whether or not anything else changes: `!  Script "postbuild" is not wired through Kerstel: changes directory.` Lifecycle and already-wired scripts are not listed, since they are the expected shape of a `package.json`. When a script was refused, the closing lines say `the scripts Kerstel can wire are wired` rather than `your scripts are wired`.

### 5.4 Lifecycle scripts

`preinstall`, `install`, `postinstall`, `prepare`, and `prepublishOnly` stay unwired. The launcher would survive a host's install, but on a developer's machine a wired `postinstall` would start the daemon during every `npm install`.

### 5.5 The self-check

§8 step 6 of the product spec runs its probe through `<runtime> .kerstel/exec.cjs -- <runtime> -e ...` from the package root, with the directory of the running binary put first on the probe's `PATH`, so the file just written is the thing being checked and it finds the binary the wizard is running from. Running from source there is no `kerstel` binary on any `PATH`, so the probe calls the CLI entry point directly, as before; the launcher's own tests cover the file.

## 6. `doctor`

`projectStatus` keeps deriving everything by running the wirer, and reports per script rather than a count:

| State | Meaning |
| --- | --- |
| wired | Every wrappable command carries the launcher prefix |
| wired (old form) | At least one command carries `kerstel exec -- ` and none carries the launcher prefix |
| partly wired | Some wrappable commands carry a prefix and some carry none |
| not wired | No prefix anywhere |
| skipped: `<reason>` | The wirer skips the script, with the reason from §5.3, including `nothing to wire` |

The first matching row from the top of this order decides: skipped, then not wired, then partly wired, then wired (old form), then wired. So `kerstel exec -- node a.js && next dev` is `partly wired`, because `next dev` carries no prefix, and `kerstel exec -- node a.js && kerstel exec -- next dev` is `wired (old form)`.

The `Scripts` row reads `4 of 5 go through Kerstel` and passes when every wrappable script is wired in the current form. Otherwise it warns with `Fix: kerstel init`. Exceptions are named in the same detail, separated by semicolons: `2 of 3 go through Kerstel; partly wired: dev; skipped: postbuild (changes directory)`. Skipped scripts do not count against the pass, and are named even when it passes.

A new `Launcher` row in the project group, judged by comparing the file with the text this Kerstel generates: `.kerstel/exec.cjs is current` passes; `.kerstel/exec.cjs is missing` is a problem with `Fix: kerstel init`; `.kerstel/exec.cjs is format 1, current is 2` (the marker names an older format) and `.kerstel/exec.cjs differs from what kerstel init writes` (the marker is current, the body is not) both warn with the same fix; `.kerstel/exec.cjs is not Kerstel's (no marker line)` warns and names the file. The row appears only when at least one script is wired in either form.

## 7. `uninstall`

`unwirePackageJson` strips both prefixes from every simple command, using the same tokeniser, and reports the script names as today. The plan lists `.kerstel/exec.cjs` under the project's files as `delete`, shown as a removed file in the diff view, when its marker line is Kerstel's; a file without the marker is left in place and named in the closing notes: `.kerstel/exec.cjs in <root> is not Kerstel's, so it was left alone.` After the file is deleted, `.kerstel/` is removed when it is empty.

## 8. `Bun.env`

When the hook installs under Bun (`process.versions.bun` is set), it resolves every `kerstel://` value in the raw env before it installs the Proxy, and writes the plaintext back into the raw object. `Bun.env` is that object, so it returns plaintext from then on. `process.env` still gets the Proxy, so a reference assigned later, by a dotenv library for example, resolves lazily as it does under Node.

A reference that fails to resolve at startup is left as it is, with one warning through `process.emitWarning` naming the variable and `kerstel doctor`. The lazy read of that variable through `process.env` then throws the same error it throws today, so a stale reference in `.env` that the app never reads does not crash the process. A key the vault lacks (`not_found`) is that key's problem and the loop goes on to the next reference. Any other failure, an unreachable daemon or one that does not answer, would cost the full timeout again for every remaining reference, so the loop stops after that one warning, which says the rest were left for `process.env` to resolve on the read.

The hook's per-process memo is keyed by variable name and checked against the reference it was filled from. `Bun.env.KEY = "kerstel://..."` writes to the raw object and bypasses the Proxy's `set` trap, which is what clears the memo under Node; without the check, a startup value would be served for a reference that is no longer there.

Consequences, stated so the docs can say them: under Bun every reference in the environment resolves at process start, not on first read, which is one audit row per reference per process; and `Bun.env` sees a reference assigned after startup as the literal string, so code that assigns and reads late should use `process.env`. Under Node nothing changes.

## 9. Monorepos

The [monorepo spec](2026-09-19-monorepo-and-checkouts-design.md) applies wiring per package in §4 step 9. Each selected package with at least one wired script gets its own `.kerstel/exec.cjs`, because npm runs a package's scripts with that package as the working directory. The root gets one only when the root is a selected package. The diff view labels the file `web: .kerstel/exec.cjs`, and the summary line per package lists wired, skipped, and legacy scripts. `uninstall` deletes each package's launcher.

## 10. Documentation

- **A new docs page, `apps/website/src/pages/docs/deploying.md`, at `/docs/deploying`.** Hosts do not need Kerstel: the launcher runs your scripts unchanged where the binary is absent, and prints one line saying so. Set every key on the host, or keep `.env` out of git: a committed `.env` of references reaching a host where a key is not set gives the app the literal `kerstel://` string, and the page shows what that failure looks like. A Turborepo section with the `globalPassThroughEnv` snippet for `KERSTEL_SOCKET`, `KERSTEL_TOKEN_FILE`, and `KERSTEL_HOOK_DIR`. A table of what each host runs on its own, from the research notes, and the Docker `CMD` table showing which official images start through `npm start` and which through `node <file>`. A note on `Bun.env` from §8.
- **`docs/cli.md`:** the `init` row describes the launcher, the per-command wiring, and the skip reasons; the `exec` row says the launcher calls it; the `doctor` row describes the per-script states and the `Launcher` row; the `uninstall` row says the launcher is deleted.
- **`docs/how-it-works.md`** and the README's step 5 describe the launcher instead of a bare `kerstel exec` prefix. The README's `exec` versus `run` table adds a row: `Where the binary is absent: exec runs the command unchanged through the launcher; run fails.`
- **The product spec:** §6.2 points here for wiring, §6.3 keeps its claim that the wizard wires build scripts and adds that it does so through the launcher, so the same `build` runs hooked locally and unchanged on a host, and §8 step 4 says the wizard writes the launcher.
- **`CHANGELOG.md`:** one `Fixed` line for `Bun.env`, one `Fixed` line for compound scripts, one `Added` line for the launcher under 0.1.3.

## 11. Testing

- **Tokeniser** (`init-wiring.test.ts`): every operator; quoted operators that must not split (`echo "a && b"`); escaped spaces; leading assignments before and after wrapping; each left-unwrapped word; each skip reason with the exact text; a script already in the legacy form finished into the new form; an idempotent second run; byte-identical output outside the inserted prefixes, including tabs and `\r\n`.
- **Launcher** (`launcher.test.ts`, new): with a fake `kerstel` on `PATH` it spawns `exec` with the command intact and forwards the exit code and a signal death; with `kerstel` only inside a `node_modules/.bin` on `PATH` it treats the binary as absent; without the binary it prints the one line and runs the command; a missing command exits `127`; the marker line and format version are what `doctor` and `uninstall` read; under `bun run` with the system `node` and with `node` absent; the Windows command line for a `.cmd` shim with an argument containing a space, a double quote, `&`, and `%`, checked as a string on every platform and end to end on the Windows CI runner.
- **`init`** (`init.test.ts`): writes the launcher, rewrites an older format and a hand-edited body, leaves a matching one untouched and unlisted, warns about a `.gitignore` that hides it, and the self-check passes through the file just written.
- **`doctor`** (`doctor-checks.test.ts`, `init-status.test.ts`): each state in §6 including the two precedence examples, the `Launcher` row's five outcomes, and no `Launcher` row in a project with nothing wired.
- **`uninstall`** (`uninstall-unwire.test.ts`, `uninstall-plan.test.ts`): both prefixes stripped per command; the launcher deleted with an empty `.kerstel/` removed; a foreign file left and named.
- **Hook** (`preload.test.ts`): under Bun, `Bun.env.KEY` and `process.env.KEY` both return the value; a reference that fails to resolve stays a reference with one warning and throws on the lazy read; under Node, `process.env` behaviour is unchanged and nothing resolves before the first read.
- **End to end** (`e2e.test.ts`): a wired compound script with a leading assignment runs both commands hooked, in a temp project, with an isolated short `KERSTEL_HOME`.
- **Website:** the build fails when `/docs/deploying` is missing from the docs navigation, and the link check covers the new page.
- No test prints a value, and every temp project, vault, and home is removed.

### 11.1 Fixtures

Three tiers, each a step further from the developer's machine.

**Tier 1: framework fixtures, in `bun test`.** `fixtures/projects/<name>/` holds one small real project per env-loading mechanism, committed with its lockfile: `next` (`@next/env` into `process.env`, Turbopack), `vite-react` (`loadEnv` and `VITE_` inlining), `sveltekit` (`$env/static/private`, the one verified case of a private value baked at build), `astro` (private `import.meta.env` and `astro:env` secrets), and `hono-bun` (Bun's native loader and `Bun.env`). Each has a `.env` with three keys, a private value, a public-prefixed value, and a value its build bakes, and a page or endpoint that prints a hash of each resolved value, so a test can assert on the output without a secret ever reaching stdout. One parametrised test in `fixtures.test.ts` runs the same four steps against each: `init --yes` from the compiled binary, `dev` for a few seconds with a request to the endpoint, `build` with a grep of the output for `kerstel://`, and `uninstall` with a diff of the tree against the original. The fixtures' `node_modules` are installed lazily and cached in CI by lockfile hash; the job is skipped when `FIXTURES=0`. Five fixtures cover each mechanism once; more are added only when a framework loads env a way none of these does.

**Tier 2: host simulators, no accounts.** A separate job after the launcher ships, on the Linux runner and locally with Docker running. It takes the wired `next` fixture, removes `kerstel` from `PATH`, and runs each host's own builder: the official Next Dockerfile, `railpack build` and `nixpacks build` (Railway, Coolify), `pack build` with the Heroku builder (Heroku, DigitalOcean) and the Google builder (Cloud Run, App Engine), `vercel build` from a linked project, and `netlify build --offline`. Each asserts that the build exits `0`, that the launcher's stderr line appears once per wired script, and that the output holds no literal `kerstel://` when the host env carries the values. The Windows CI runner covers the `.cmd` path of §4.3 with the same fixture.

**Tier 3: real hosts, before a release.** One public sample repo, connected to Vercel, Netlify, Railway, and Cloudflare, with the host env set by hand. The release rehearsal in `AGENTS.md` gains a line: redeploy the sample and check the endpoint. A scheduled workflow can take this over later.
