---
title: Sync
description: End-to-end encrypted sync of your vault between your own devices, through a kerstel-server you run.
section: docs
order: 5
---
# Sync

<p class="lede">Keep one vault on your laptop and your desktop. Values are encrypted on your device with a key the server never holds.</p>

Sync is optional and off until you turn it on. It is for one person's devices. A team still commits references and fills each teammate's vault, as in [Working with a team](/docs/teams), until shared vaults ship.

## Run a server

`kerstel-server` stores ciphertext and nothing else. It never sees a scope name, a key name, a value, a project path or a device name, so you can run it anywhere you can reach from your devices. Every release ships it next to the CLI, with the same version.

With Docker:

```bash
docker run -d -p 127.0.0.1:8787:8787 -v kerstel-server:/data ghcr.io/alilibx/kerstel-server:latest
```

The image has no shell, runs as a non-root user, and keeps its database in the `/data` volume. Pin a version (`:0.3.0`) rather than `latest` if you upgrade on your own schedule. The options below work as environment variables with `docker run -e`.

Or download the binary for your platform (`linux-x64`, `linux-arm64`, `darwin-arm64` or `darwin-x64`) from the [latest release](https://github.com/alilibx/kerstel/releases/latest), and check it against the release's `SHA256SUMS`:

```bash
curl -fLO https://github.com/alilibx/kerstel/releases/latest/download/kerstel-server-linux-x64
curl -fLO https://github.com/alilibx/kerstel/releases/latest/download/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
chmod +x kerstel-server-linux-x64
./kerstel-server-linux-x64 --db /var/lib/kerstel/server.db --listen 127.0.0.1:8787
```

| Option | Environment | Default |
|---|---|---|
| `--db <file>` | `KERSTEL_SERVER_DB` | `./kerstel-server.db` |
| `--listen <host:port>` | `KERSTEL_SERVER_LISTEN` | `127.0.0.1:8787` |
| `--enroll-token-file <file>` | `KERSTEL_SERVER_ENROLL_TOKEN` | none: anyone who can reach the server can create a vault |
| `--trust-proxy` | | off: rate limits use the socket address, not `X-Forwarded-For` |

The server speaks plain HTTP, and Kerstel sends a vault only to an `https://` URL, or `http://` to this machine. Put the server behind a proxy that terminates TLS, and start it with `--trust-proxy` so rate limits apply to each client rather than to the proxy. With Caddy:

```
sync.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

With an enroll token, only a device that has it can create a vault: set `KERSTEL_SYNC_ENROLL_TOKEN` when you run `sync setup`. Joining an existing vault never needs it.

## Turn it on

On the device that holds your vault:

```bash
kerstel sync setup https://sync.example.com
```

It shows the server, how many secrets and scopes it will upload, and this device's name, then asks before uploading. The device name is sealed, so the server never sees it.

## Add a device

On the device that is already syncing:

```bash
kerstel sync add-device
```

It prints a line to run on the new device:

```bash
kerstel sync join https://sync.example.com KS-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
```

The code works once and expires in 10 minutes. When the new device answers, both devices show the new device's key fingerprint. Check that they match, then say yes on the first device. The new device checks that the sync key it receives is the one you confirmed, so a server cannot slip in a key of its own.

A new device that already holds secrets merges them in. A key only it holds is uploaded. A key both vaults hold with different values becomes a conflict for you to settle, and nothing is overwritten.

## Day to day

After a command that writes the vault (`set`, `rm`, `init`, `move`, or `ui`), Kerstel syncs in the background. `run` and `exec` start a background sync when none has finished in the last five minutes. Neither one waits for the network, and an unreachable server never fails the command. A value pulled after an app starts reaches it the next time it starts.

`kerstel sync` does the same in the foreground and says what changed. `kerstel sync status` and `kerstel doctor` show the server, the last successful sync, changes still waiting to be pushed, open conflicts, and the last error. `doctor` warns after seven days without a successful sync.

The daemon never syncs and never opens a network connection.

## Conflicts

A key changed on two devices before either synced is a conflict. Kerstel never picks a side. A background sync keeps this device's value, stops pushing that key, and every command prints one line on stderr until you settle it:

```
kerstel: 1 sync conflict. Run `ks sync` to choose which value stays.
```

`kerstel sync` in a terminal asks about each conflict, naming the other device and the time of its change. It shows each value only as its length. `--reveal` shows both values. `kerstel sync --keep local` or `--keep remote` settles every conflict in a script. The value that loses goes to an encrypted backup under `~/.kerstel/backups/_sync/`. So does any value a pull replaces or deletes.

## Remove a device

```bash
kerstel sync devices
kerstel sync remove-device old-laptop
```

Removing a device replaces the sync key. Every record is encrypted again under a new key that only the remaining devices receive, and the server refuses the removed device's requests. The removed device already had every value, so rotate any secret it should no longer hold, at its provider.

To stop syncing the device you are on, run `kerstel sync off`. Its secrets stay on it. `kerstel uninstall` leaves the vault first.

## What the server sees

| The server sees | The server never sees |
|---|---|
| A random vault ID | Scope names, key names, values |
| Each device's random ID and public keys | Device names and hostnames |
| How many records a vault holds, their sizes, and when they change | Project paths, `.env` contents, backups |
| Opaque record IDs, and which of them are deletions | Which record is which key |
| The IP address of each request | The sync key or any data key |

The [security model](/security) covers what a hostile server can and cannot do.
