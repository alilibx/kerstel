# Kerstel — Local-First Secrets Manager for JS Projects

**Status:** Approved design, pre-implementation
**Date:** 2026-09-17
**Replaces:** the Swift menu bar app that previously lived in this repo. It is an unrelated product, not an earlier version: Kerstel's version history starts at 0.1.0. The Swift code is removed from the working tree; git history preserves it.

## 1. Problem

`.env` and `.env.local` files hold secrets in plaintext. Anything that can read files — AI coding agents, editor plugins, accidental commits, backup tools — can read the secrets. Existing solutions (Doppler, Infisical, 1Password CLI) solve this with cloud accounts and explicit wrapper commands (`op run -- ...`). Both are friction Kerstel rejects.

## 2. Product statement

Kerstel is a local-first secrets manager for Node and Bun projects. Secrets live in an encrypted vault on the developer's machine, unlocked via the OS credential store. `.env` files hold only references (`kerstel://<scope>/<KEY>`) — safe to read, grep, and commit. A setup wizard migrates projects without changing how the developer works: `npm run dev` stays `npm run dev`. A local web portal manages the vault. No account, no cloud, no telemetry, no AI — fully deterministic and offline.

**Non-goals for the first release (0.1.0):** cloud sync, team sharing, environments (dev/staging/prod), per-process access approval. All are roadmap items the first release's architecture must not block (see §10).

## 3. Threat model

Two protection levels; the first release ships level 1, the architecture reserves level 2.

- **Level 1 — file-level protection (first release).** No plaintext secret ever sits in a project file. Reading `.env`, committing it, or grepping the repo yields only references. A process that *runs code* in the project can still read resolved values from `process.env`.
- **Level 2 — access-level protection (next).** The resolver daemon gates each resolution: an unrecognized process asking for a key triggers an approval prompt (macOS-Keychain-style: "allow `node (myapp)` to read `OPENAI_API_KEY`?"). This is why resolution is lazy and daemon-mediated from day one — the daemon already sees which process asks for which key.

Out of scope at any level: an attacker with root, a compromised OS keychain, or malicious code running *after* it has been granted a secret.

## 4. Architecture

One TypeScript codebase. One compiled artifact per platform via `bun build --compile` — installing Kerstel requires neither Node nor Bun.

```
┌─────────────┐   spawns/wires    ┌──────────────────┐
│ kerstel CLI │──────────────────▶│  app process      │
│ (wizard, ui,│                   │  (node/bun)       │
│  vault ops) │                   │  + runtime hook   │
└──────┬──────┘                   └────────┬─────────┘
       │ unix socket / named pipe          │ resolve(ref)
       ▼                                   ▼
┌─────────────────────────────────────────────────────┐
│ resolver daemon (auto-started, one per user)        │
│  · unlocks vault once via OS keychain               │
│  · serves resolutions; logs audit entries           │
│  · next: approval gate lives here                   │
└──────────────────────┬──────────────────────────────┘
                       ▼
        ~/.kerstel/vault.db  (AES-256-GCM, SQLite)
        OS keychain: vault data key
```

### 4.1 Components

| Component | Package | Role |
|---|---|---|
| CLI | `packages/cli` | `init` wizard, `set/get/ls/rm`, `ui`, `run`, `doctor`, `daemon`, `uninstall` |
| Vault engine | `packages/cli` (module) | Encrypted SQLite storage, crypto, schema migrations |
| Resolver daemon | `packages/cli` (subcommand) | Unlocks vault, serves resolutions over local IPC, audit log |
| Runtime hook | `packages/hook` | JS preload; `process.env` Proxy that resolves references lazily |
| Portal | `packages/portal` | Local web UI served by the binary on `kerstel ui` |
| Website | `apps/website` | kerstel.dev — marketing + docs |

## 5. Vault

- **File:** `~/.kerstel/vault.db`, SQLite.
- **Crypto:** AES-256-GCM per value, random 96-bit nonce per encryption. The 256-bit data key is generated at first run and stored only in the OS credential store:
  - macOS: Keychain (via `security` / Security.framework bindings)
  - Linux: Secret Service API (libsecret); fallback to a key file with `0600` perms plus a loud warning when no secret service exists
  - Windows: Credential Manager (DPAPI)
- **Schema (versioned, `schema_version` pragma):**
  - `projects(id, name, root_path, created_at)`
  - `secrets(id, scope, project_id NULL, key, value_ciphertext, nonce, environment TEXT NULL /* reserved, unused for now */, created_at, updated_at)`
  - `audit_log(id, ts, event, scope, key, pid, process_name, project_id)`
  - Unique on `(scope, project_id, key)` — the first release ignores `environment`; adding it later extends the unique key without data migration.
- **Reference syntax:** `kerstel://global/<KEY>` or `kerstel://<project-name>/<KEY>`. Explicit scoping — a reference names exactly one scope, no fallback chain. The wizard makes pointing a project at a global key a one-keystroke choice.

## 6. Runtime resolution

### 6.1 The hook

A small dependency-free JS file (CommonJS + ESM builds) loaded before app code. It replaces `process.env` with a Proxy:

- A `get` whose stored value matches `^kerstel://` resolves through the daemon and returns the plaintext. Resolved values are memoized per process.
- It never cares how the reference entered the env — dotenv, Next.js env loading, Bun's native `.env` loader, or the parent shell. It intercepts the *read*.
- **Child processes:** the hook injects the preload into `NODE_OPTIONS` (and Bun equivalents) in the env it exposes, so spawned node/bun children are covered and can resolve references of their own. Variables already present in the environment are handed to any child already resolved: building a child's envp reads `process.env` through the same trap application code uses, so the hook cannot tell the two apart, and a non-Node child (python, git, curl, ...) could not resolve a reference anyway. This matches level 1's stated boundary — a child is a process that runs code.
  - **Consequence, today, not a future concern:** envp construction enumerates *every* variable, so a single spawn resolves **every reference in the environment**, not only the ones the app actually reads — one audit row per secret, whether or not that secret was ever used. A `git` invocation in a dev server's file watcher resolves the whole vault slice the project references. The planned per-process approval gate has to account for this directly: an approval prompt per key per spawn is unusable, so the gate needs either resolution that is lazy *across* the envp boundary (a child env that still carries references, with the child's own hook resolving on read) or approvals scoped to a process tree rather than a single read.
- Resolution failure (daemon unreachable, key missing, locked vault) throws a clear, actionable error naming the reference and the fix (`kerstel doctor`). It never silently returns the reference string to app code.

### 6.2 Wiring (owned by the wizard, never by the user's fingers)

- **Bun projects:** wired through `kerstel exec`, which passes `--preload <hook>` on the `bun` command line because Bun ignores `NODE_OPTIONS`.
- **Node projects:** the wizard rewrites `package.json` scripts to inject the preload (approach: prefix scripts through a `kerstel exec` shim that sets `NODE_OPTIONS=--require <hook>` and execs the original command verbatim). The user approves the diff.
- **Universal fallback:** `kerstel run -- <cmd>` resolves all references up front and injects plaintext into the child env — for anything outside package scripts (IDE runners, other languages).

### 6.3 Known edge cases (documented, diagnosed by `doctor`)

- Build-time env snapshotting (e.g. `NEXT_PUBLIC_*` inlined into client bundles) works only when the build runs under the hook — the wizard wires build scripts too.
- Processes spawned via absolute-path exec that scrubs env fall back to `kerstel run`.

## 7. The daemon

- One per user, auto-started by the CLI on first use; socket at `~/.kerstel/kerstel.sock` (Windows: named pipe), `0600`. Hook-side auto-start arrives with the setup wizard, which is what teaches the hook where the `kerstel` binary lives.
- **Access boundary:** a per-session bearer token, generated at `~/.kerstel/session.token` (`0600`) and compared in constant time on every request. Combined with the `0600` socket inside the `0700` home, that means only the owning user can read the token and only a caller holding it is served. The daemon does **not** verify peer UID: `node:net` exposes no peer credentials, and obtaining them would require a native module, which the single-self-contained-binary constraint rules out.
- Unlocks the vault once per session via the OS keychain.
- **Windows:** the POSIX mode bits above are inert on NTFS — Node does not translate them into ACLs, so `0700`/`0600` are no-ops there. What protects `~/.kerstel` on Windows is the user profile directory's inherited ACL, and the named pipe carries libuv's default security descriptor. `kerstel doctor` prints this caveat on `win32`. Tightening it (an explicit pipe DACL, an explicit directory ACL) is open work, not something the first release claims.
- Protocol: newline-delimited JSON — `resolve`, `status`, `lock`, `shutdown`. Versioned envelope so access gating can add `approve`. `lock` drops the key by shutting the daemon down — the key is resident in its memory for as long as it serves, so a flag would leave it there — and the next resolution restarts it.
- Writes an `audit_log` row per resolution (key, pid, process name, project).
- Idles out after a configurable period and relocks.

## 8. CLI & wizard UX

`curl -fsSL https://kerstel.dev/install.sh | bash` → downloads the platform binary to `~/.kerstel/bin`, symlinks into PATH, runs first-time setup (creates vault, stores key in keychain).

`kerstel init` (in a project) — every step shows what it will do and asks:

1. Detect runtime + package manager (npm/pnpm/yarn/bun).
2. Parse `.env`, `.env.local` (and variants). Show findings. Per key: → project scope / → existing or new global key / leave plaintext (fine for non-secret URLs).
3. Encrypted backup of originals to `~/.kerstel/backups/<project>/<ts>/`, then rewrite files with references.
4. Wire the hook (§6.2); show the `package.json` diff for approval.
5. Offer `.gitignore` update (making committing `.env` possible — user's call).
6. Run a self-check: spawn a probe process through the wired scripts, confirm resolution works.

When one key appears in several files with different values, `init` stores the highest-precedence one (`.env.<x>.local` > `.env.local` > `.env.<x>` > `.env`), rewrites every occurrence to that single reference, keeps the losing values only in the encrypted backup, and names the affected files — Kerstel has no environments yet, so one key resolves to exactly one value.

**Teammate flow:** clone → `kerstel init` reads committed references, lists keys the local vault lacks, prompts for values. References double as a living `.env.example`. Each value is stored in the vault as it is entered, before the apply confirmation — the confirmation governs the writes to the project's own files, and a value supplied for a reference the repository already carries needs no further approval.

Other commands: `set/get/ls/rm` (get requires a `--reveal` flag to print plaintext), `ui`, `run`, `doctor` (wiring + daemon + keychain diagnostics), `daemon start|stop|status`, `uninstall` (restores plaintext `.env` from vault before removing itself, with confirmation).

## 9. Portal

`kerstel ui` → daemon serves a SPA on `127.0.0.1:<random port>`, opens the browser with a one-time bearer token in the URL; all API calls require it. Features: manage global/project secrets, see which projects reference which keys, audit log view, vault lock/unlock. Values render masked; reveal is per-value and audited. No remote assets — everything ships in the binary.

## 10. Roadmap

The public, tick-box version of this roadmap is the repo-root `ROADMAP.md`, published at kerstel.dev/roadmap.


- **First release, 0.1.0 (this build):** everything above except the portal (§9).
- **0.2.0 — local portal:** `kerstel ui` as described in §9. Moved out of 0.1.0 so binaries ship sooner.
- **Next — access gating:** daemon approval prompts per unknown process/key, allowlists, Touch ID / polkit for sensitive ops.
- **Later — optional sync & teams:** E2E-encrypted sync (client-side keys only), environments, shared vaults.

## 11. Repo & open source

Bun workspace monorepo, MIT license:

```
packages/cli  packages/hook  packages/portal  apps/website
docs/   (this spec, roadmap, SECURITY.md threat model, CONTRIBUTING.md)
```

- The Swift menu bar app removed in the first implementation commit (history retained). `install.sh`/`uninstall.sh` rewritten for the binary flow.
- **Website:** kerstel.dev rebuilt for the new product — futuristic design, animated plaintext→reference hero, one-liner install front and center, security-model page, docs.
- **CI:** GitHub Actions — test matrix (macOS, Linux; Node + Bun), release workflow building binaries for macOS arm64/x64, Linux x64/arm64, Windows x64; checksums published; `install.sh` picks the right asset.

## 12. Testing

- **Vault:** unit tests for crypto round-trips, wrong-key failure, schema migration, concurrent access.
- **Hook:** integration tests spawning real Node and Bun processes — dotenv load, Bun native env, child-process propagation, Next.js-style build-time reads, failure modes.
- **Wizard:** fixture projects (npm/pnpm/yarn/bun, messy multi-file `.env`s) run through `init` non-interactively; assert file rewrites, backups, wiring, and self-check pass.
- **Daemon:** protocol tests, bad-token rejection, relock-on-idle.
- **E2E:** install-script smoke test in CI containers.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Hook edge cases (env snapshotting, exotic spawns) | `kerstel run` always works; `doctor` diagnoses; edge cases documented |
| Linux machines without a secret service | Explicit degraded mode (key file + warning), never silent |
| Wizard rewrites user files | Diff + consent per step, encrypted backups, `uninstall` restores |
| `bun build --compile` platform quirks | Release CI builds and smoke-tests every target from day one |
