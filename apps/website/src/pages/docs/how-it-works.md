---
title: How resolution works
description: Reference syntax, scopes, the resolver daemon, and how the runtime hook turns a reference into a value.
section: docs
order: 3
---
# How resolution works

<p class="lede">A reference is a pointer into your vault. This page follows one from the <code>.env</code> file to <code>process.env</code>.</p>

## References and scopes

A reference looks like this:

```
kerstel://<scope>/<KEY>
```

The scope is either `global` or a project name. A reference names exactly one scope and resolves there or fails. There is no fallback chain: `kerstel://myapp/API_KEY` never quietly picks up `global/API_KEY`. If you want a project to use a shared value, point the project's `.env` at the global reference directly.

## The vault

Values live in `~/.kerstel/vault.db`, encrypted per value with AES-256-GCM. The data key lives in your OS credential store. The [security model](/security) covers this in detail.

## The daemon

A per-user resolver daemon unlocks the vault once, using the credential store, and then answers lookups over a local socket (`~/.kerstel/kerstel.sock`). Each request carries a session token, so only processes running as you can ask. The daemon records an audit row for each resolution.

`kerstel run` never talks to the daemon: it opens the vault directly and resolves references itself. The hook does need the daemon, and `kerstel exec` (which `init` writes into your scripts) starts it on demand, as does `kerstel resolve`; you never start it by hand. If the hook can't reach it, the error names the reference and tells you to run `kerstel doctor`. `kerstel daemon status` shows whether it is up at any time, and `kerstel daemon start` is there if you want to start it yourself, or to read why it won't start.

## Two ways to resolve

### `kerstel run`

```bash
kerstel run -- next build
```

`run` reads the current environment, resolves every reference it finds, and starts the command with plaintext values in place. It is the universal path. It works for IDE run configurations, other languages, and any command that cannot load a Node preload.

### The runtime hook

The hook is a small, dependency-free preload that runs before your app code. It replaces `process.env` with a proxy. When code reads a key whose value starts with `kerstel://`, the hook asks the daemon, memoizes the answer for the life of the process, and returns the real value. Nothing on disk changes, and the hook does not care how the reference got into the environment: dotenv, Bun's native `.env` loader, Next.js env loading, or your shell.

`kerstel init` wires this up for you. Every script in `package.json` becomes `kerstel exec -- <your original command>` — npm lifecycle scripts such as `postinstall` and `prepare` are never wrapped, because that would make `npm install` itself depend on Kerstel . A Bun project is wired the same way: `kerstel exec` passes `--preload` to `bun` itself, so nothing per-machine is written into the project. Kerstel writes the hook's files to `~/.kerstel/hook` the first time any `kerstel` command runs, and the file everything points at is `~/.kerstel/hook/preload.cjs`.

### What `kerstel exec` does

`kerstel exec -- <command>` is the whole wrapper, and it resolves nothing itself. It sets `KERSTEL_SOCKET`, `KERSTEL_TOKEN` and `KERSTEL_HOOK_DIR` for the child, appends `--require <the hook>` to `NODE_OPTIONS`, and starts the command. When the command it is about to run is `bun` or `bunx`, it also inserts `--preload=<the hook>` directly after the executable, because Bun does not honour `NODE_OPTIONS=--require`. Then the hook takes over and resolves each reference lazily, on the read.

### Wiring it by hand

A project with no `package.json` scripts to wrap runs its command through the wrapper directly:

```bash
kerstel exec -- <your command>
```

That is the same wiring `init` writes into a script, and it works for Node and Bun alike. The hook only activates when `KERSTEL_SOCKET` and `KERSTEL_TOKEN` are in the environment, and `kerstel exec` is what sets them — preloading the hook by hand, through `bunfig.toml` or `NODE_OPTIONS`, resolves nothing on its own. For a command the hook cannot reach at all, such as an IDE run configuration, `kerstel run -- <your command>` resolves every reference up front and passes plaintext values to the child.

Child processes are covered: the hook injects itself into the environment it exposes, so a `node` or `bun` child resolves its own references. Variables handed to any child are handed already resolved. A child that is not Node or Bun, such as `python` or `git`, could not resolve a reference anyway.

## When resolution fails

If the daemon is unreachable, the vault is locked, or the key is missing, the hook throws an error that names the reference and points at `kerstel doctor`. It never returns the reference string to your code as if it were the value.

## Edge cases worth knowing

- **Build-time snapshots.** Frameworks that inline environment variables into a client bundle, such as `NEXT_PUBLIC_*`, only see real values when the build itself runs under the hook or through `kerstel run`.
- **Scrubbed environments.** A process launched with a clean environment, or by an absolute-path exec that drops `NODE_OPTIONS`, cannot load the hook. Use `kerstel run` for those.
- **One spawn resolves everything.** Building a child's environment enumerates every variable, so a single spawn resolves every reference in scope, whether or not the child reads it. Expect one audit row per reference per spawn.
