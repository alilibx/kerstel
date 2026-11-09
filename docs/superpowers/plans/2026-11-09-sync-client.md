# Plan: the `ks sync` client

Implements the client half of the [sync spec](../specs/2026-11-08-sync-between-devices-design.md), against `kerstel-server` (#84, merged). Three PRs, each one usable on its own.

## PR 1: one device's sync (#18)

- `packages/cli/src/sync/crypto.ts`: device keys (Ed25519, X25519), sealing the sync key to a device (§5.2), record IDs (§6.1), padded payloads with associated data (§6.2), sealed device names. `node:crypto` only.
- Schema 4: `sync_state` (§6.3). `setSecret` and `removeSecret` mark the key dirty and raise `change` in the same transaction, once sync is on.
- `sync/http.ts`: a signed client for every endpoint PR 1 needs, built on `packages/server/src/protocol.ts`. `fetch` is injectable, so tests run against `createApp` in-process.
- `sync/engine.ts`: pull (§8.3, every row of the table, the full pull), push (§8.2, the `change` check), conflicts kept, never chosen (§8.4), and the sync backup (§8.5) under `backups/_sync/`, a name no scope can take.
- `ks sync setup <url>`, `ks sync` (with `--keep local|remote` and `--reveal`), `ks sync status`, `ks sync devices`, `ks sync off`.

## PR 2: more devices (#82)

`ks sync add-device`, `ks sync join` (with the pairing confirmation check, §7.1, and the merge rules of §10), and `ks sync remove-device` (rotation with `baseRevision` and re-sealed names, §7.3). `uninstall` leaves the vault first.

## PR 3: sync in the background, and the docs

Detached sync after `set`, `rm`, `init` and `move`; a background pull from `run` and `exec`; `~/.kerstel/sync.lock`; the conflict line on stderr; the `doctor` row; the copy changes of §11 and the Sync docs page. Then the nightly channel (#85) can publish a server worth pairing with.
