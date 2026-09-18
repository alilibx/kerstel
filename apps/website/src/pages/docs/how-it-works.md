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

A per-user resolver daemon unlocks the vault once, using the credential store, and then answers lookups over a local socket (`~/.kerstel/kerstel.sock`, or a named pipe on Windows). Each request carries a session token, so only processes running as you can ask. The daemon records an audit row for each resolution.

You rarely start it by hand. The hook and `kerstel run` start it on demand; `kerstel daemon status` shows whether it is up.

## Two ways to resolve

### `kerstel run`

```bash
kerstel run -- next build
```

`run` reads the current environment, resolves every reference it finds, and starts the command with plaintext values in place. It is the universal path. It works for IDE run configurations, other languages, and any command that cannot load a Node preload.

### The runtime hook

The hook is a small, dependency-free preload that runs before your app code. It replaces `process.env` with a proxy. When code reads a key whose value starts with `kerstel://`, the hook asks the daemon, memoizes the answer for the life of the process, and returns the real value. Nothing on disk changes, and the hook does not care how the reference got into the environment: dotenv, Bun's native `.env` loader, Next.js env loading, or your shell.

For Bun projects the hook is a `preload` entry in `bunfig.toml`. For Node projects the package scripts run through a shim that sets `NODE_OPTIONS=--require <hook>`.

Child processes are covered: the hook injects itself into the environment it exposes, so a `node` or `bun` child resolves its own references. Variables handed to any child are handed already resolved. A child that is not Node or Bun, such as `python` or `git`, could not resolve a reference anyway.

## When resolution fails

If the daemon is unreachable, the vault is locked, or the key is missing, the hook throws an error that names the reference and points at `kerstel doctor`. It never returns the reference string to your code as if it were the value.

## Edge cases worth knowing

- **Build-time snapshots.** Frameworks that inline environment variables into a client bundle, such as `NEXT_PUBLIC_*`, only see real values when the build itself runs under the hook or through `kerstel run`.
- **Scrubbed environments.** A process launched with a clean environment, or by an absolute-path exec that drops `NODE_OPTIONS`, cannot load the hook. Use `kerstel run` for those.
- **One spawn resolves everything.** Building a child's environment enumerates every variable, so a single spawn resolves every reference in scope, whether or not the child reads it. Expect one audit row per reference per spawn.
