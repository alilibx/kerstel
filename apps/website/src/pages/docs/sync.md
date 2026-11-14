---
title: Sync
description: End-to-end encrypted sync of your vault between your own devices, through a kerstel-server you run.
section: docs
order: 5
---
# Sync

<p class="lede">Keep one vault on your laptop and your desktop. Values are encrypted on your device with a key the server never holds.</p>

Sync is optional and off until you turn it on. It is for one person's devices. A team still commits references and fills each teammate's vault, as in [Working with a team](/docs/teams), until shared vaults ship.

## Set up sync

Run this on the device that holds your vault, in a terminal:

```bash
kerstel sync setup
```

It sets up a sync server and this device step by step. It first asks where the server should run:

| Choice | What happens |
|---|---|
| On another machine, over SSH | Kerstel installs `kerstel-server` there with the system `ssh`. |
| On another machine, I'll run a command there myself | Kerstel prints one command. You run it on the server. |
| On this machine | Kerstel installs `kerstel-server` here. It is reachable only while this machine is on. |
| I already have a server | You give its address, or a server value. |

Kerstel never asks for an SSH password or key. It runs your own `ssh`, so your keys, agent, `~/.ssh/config`, jump hosts and known-hosts checks all apply, and host-key and passphrase prompts show up in your terminal.

### Over SSH or on this machine

Over SSH, Kerstel asks for the host, as you would type it after `ssh`, like `ali@homebox`. It connects and says what it found, such as `Linux x64, Docker found.` On this machine, it checks this machine instead. It supports Linux and macOS hosts, on x64 and arm64.

Then it asks how to run the server:

- **Docker.** The image is `ghcr.io/alilibx/kerstel-server:<version>`, the same version as your Kerstel.
- **A service, no Docker.** It downloads the `kerstel-server` binary of your Kerstel's version, checks it against the release's `SHA256SUMS`, and runs it under systemd on Linux or launchd on macOS.

Without Docker on the host, it uses a service. Linux without systemd needs Docker.

Then it asks how your other devices will reach the server:

| Choice | What it means |
|---|---|
| Its own certificate, pinned by your devices | No domain needed. The server listens on 8787. See [Its own certificate, pinned](#its-own-certificate-pinned). |
| My domain, with a Let's Encrypt certificate | The server listens on 443 and answers the challenge on 80. Kerstel warns when the domain does not point at the host yet. See [Your domain, with Let's Encrypt](#your-domain-with-lets-encrypt). |
| Tailscale | Offered when the host runs Tailscale. On a command you run yourself, it is always offered. Every device that syncs must be on your tailnet. See [Tailscale](#tailscale). |

For a pinned server, it asks for the address your devices use. It starts from what it found. A host with a public IPv4 address (a VPS) gets `https://<public-ip>:8787`. A host that reports only private addresses, when your `ssh` reaches it at a public one, is a VPS behind its provider's NAT: it gets the name or IP that `ssh` connects to. A home box gets its `.local` name first, `https://<hostname>.local:8787`, when this device resolves that name, and then its LAN addresses. Docker's and Tailscale's own addresses are left out, since other devices on your LAN can't reach them. You can edit the answer. Give up to four addresses, separated by commas. A device uses the first one that answers, and `kerstel sync status` shows which one answered last.

The installer says the server is running only once it answers on the host, or, with a domain, once it runs. Kerstel then turns sync on for this device and uploads the vault. The server restarts on reboot.

### A command you run yourself

Kerstel asks the same questions without detecting anything, then prints one command to paste on the server. The command downloads the installer for your Kerstel's version, checks its SHA-256 against a hash Kerstel computed, and only then runs it. When it finishes, the server prints a server value (`ks-server1-…`). Paste it at the hidden prompt, `Paste the server value it printed`. The value holds the enroll token, so treat it as a secret. Kerstel never takes it as an argument.

### A server you already have

Give its address, or paste a server value. The address and the enroll token (`Enroll token (leave empty if the server has none)`) are asked at hidden prompts. `KERSTEL_SYNC_ENROLL_TOKEN` supplies the token instead. For an `https://` address it also asks `Certificate pin (leave empty if the server has a CA certificate)`: give the `sha256/…` pin of a server that runs with its own certificate. Kerstel then shows the server, how many secrets and scopes it will upload, and this device's name, and asks before uploading.

For a script, pass a server value on stdin, so it never lands in your shell history or a process list:

```bash
printf '%s\n' "$VALUE" | kerstel sync setup --server-value - --yes
```

On a terminal, `--server-value -` asks for the value at a hidden prompt instead of reading it. Without a terminal, `kerstel sync setup` with no arguments prints its usage instead.

### If a step fails

Every step on the host checks what already exists, so run `kerstel sync setup` again and it continues where it stopped. On the host this device set up a server on, a new run continues with that server, even after `kerstel sync off`. If this device has a server on another host, finished or not, a new run asks before setting up another, and the default is no. If sync is already on, `kerstel sync setup` says so and points at `kerstel sync server` and `kerstel sync add-device`.

If the host already runs a Kerstel server that another device set up, Kerstel stops and says to run `kerstel sync add-device` on that device. A server you started yourself from the image counts too, and so does a `kerstel-server` volume the installer did not make, so Kerstel never starts a second server beside it. This device keeps its record of the server it set up before.

### What the install changes on the host

| Runtime | What it creates |
|---|---|
| Docker | A container and a volume, both named `kerstel-server`. The container restarts unless you stop it. The enroll token is `/data/enroll-token` in the volume. |
| Service | `~/.kerstel-server/` for the SSH user, holding the database, the binary and the enroll token. On Linux the unit is `/etc/systemd/system/kerstel-server.service`, and it runs as that user. On macOS it is `/Library/LaunchDaemons/dev.kerstel.server.plist`. |

`kerstel-server` creates the enroll token file the first time it starts. The token never appears in a command line or in shell history. Devices need it to create a vault, not to join one.

Run the installer as your own user, not through `sudo`: it stops when `sudo` runs it with your home folder. It asks for `sudo` only where it must, and says why before it asks:

- The service install needs `sudo` once, because the unit or plist belongs to root and systemd or launchd starts it.
- Docker needs `sudo` only when your user cannot reach the Docker daemon.
- Tailscale needs `sudo` only when your user is not a Tailscale operator.

With a domain on Linux, the unit adds `CAP_NET_BIND_SERVICE`, so the server can listen on 80 and 443 as your user.

**SELinux.** On SELinux-enforcing hosts (RHEL, Fedora, Rocky), systemd may refuse to run the service's binary from your home directory (`203/EXEC`). Use Docker there, or relabel the binary.

### Look after the server

The device that set up the server keeps a record of it in `~/.kerstel/sync-server.json`. It holds no secret and never syncs.

| Command | What it does |
|---|---|
| `kerstel sync server` | Shows the server's address, whether it answers, its version, and where it runs. |
| `kerstel sync server update` | Updates the server to this Kerstel's version. |
| `kerstel sync server address <url>` | Points this device at the server's new address. It saves the address only when the server there answers with the pinned key and knows this device. Run it on each device. |
| `kerstel sync server manage <ssh-host>` | Takes over a server another device set up, after checking that it is the one this vault syncs with. |
| `kerstel sync server stop` | Stops the server and keeps its data. |
| `kerstel sync server remove` | Removes the server. It asks first, and asks again before it deletes the database. |

For a server you installed with a pasted command, these print the matching command to run on the server.

`update`, `stop` and `remove` pass the server's install ID to the installer. If the host now runs a server that another device set up, they change nothing there and say so. `manage` asks before it replaces this device's record of a server on another host, and the default is no. It refuses while this device is still setting up a server elsewhere: finish it with `kerstel sync setup`, or run `kerstel sync server remove`.

`kerstel update` checks the server after it installs a new Kerstel. If the server is older, it says so and asks whether to update it now. If that server update fails, `kerstel update` still succeeds, since Kerstel itself was updated, and says to run `kerstel sync server update`. Without a terminal, or with `--check`, it only says so. `kerstel doctor` warns about a server that is behind. `kerstel uninstall` on the device that set up the server asks whether to remove it too, and the default is no, since other devices may still use it. `kerstel sync off` and `kerstel uninstall` name `kerstel sync server manage` when they leave the server running, so another device can look after it.

## Run a server yourself

The wizard does everything below for you. Run `kerstel-server` yourself when you want a different setup, or when the wizard does not fit.

`kerstel-server` stores ciphertext and nothing else. It never sees a scope name, a key name, a value, a project path or a device name, so you can run it anywhere you can reach from your devices. Every release ships it next to the CLI, with the same version.

Kerstel sends a vault only to an `https://` URL, or `http://` to this machine. The server can serve HTTPS itself, in three ways. Pick the one that fits where it runs. Each has its own section below.

| You have | Read the section |
|---|---|
| A server at home or on a VPS, with no domain | Its own certificate, pinned |
| A domain that points at the server | Your domain, with Let's Encrypt |
| A Tailscale network | Tailscale |
| A proxy or load balancer that already terminates TLS | Behind your own proxy |

First get the server. With Docker, the examples below use this image:

```
ghcr.io/alilibx/kerstel-server:latest
```

The image has no shell, runs as a non-root user, and keeps its database in the `/data` volume. Pin a version (`:0.3.0`) rather than `latest` if you upgrade on your own schedule. The options below work as environment variables with `docker run -e`.

Or download the binary for your platform (`linux-x64`, `linux-arm64`, `darwin-arm64` or `darwin-x64`) from the [latest release](https://github.com/alilibx/kerstel/releases/latest), and check it against the release's `SHA256SUMS`:

```bash
curl -fLO https://github.com/alilibx/kerstel/releases/latest/download/kerstel-server-linux-x64
curl -fLO https://github.com/alilibx/kerstel/releases/latest/download/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
chmod +x kerstel-server-linux-x64
```

| Option | Environment | Default |
|---|---|---|
| `--db <file>` | `KERSTEL_SERVER_DB` | `./kerstel-server.db` |
| `--listen <host:port>` | `KERSTEL_SERVER_LISTEN` | `127.0.0.1:8787`, or `0.0.0.0:443` with `--domain` when neither this flag nor the variable is set |
| `--enroll-token-file <file>` | `KERSTEL_SERVER_ENROLL_TOKEN_FILE`, or `KERSTEL_SERVER_ENROLL_TOKEN` for the token itself | none: anyone who can reach the server can create a vault |
| `--trust-proxy` | | off: rate limits use the socket address, not `X-Forwarded-For` |
| `--tls self` | `KERSTEL_SERVER_TLS` | off: plain HTTP |
| `--tls-name <name>` | `KERSTEL_SERVER_TLS_NAMES` | none. Repeat the flag, or comma-separate the variable. |
| `--domain <name>` | `KERSTEL_SERVER_DOMAIN` | none |
| `--acme-email <address>` | `KERSTEL_SERVER_ACME_EMAIL` | none |
| `--acme-http <host:port>` | `KERSTEL_SERVER_ACME_HTTP` | `0.0.0.0:80` |
| `--acme-directory <url>` | `KERSTEL_SERVER_ACME_DIRECTORY` | Let's Encrypt |

A flag wins over its variable. `--domain` ignores `KERSTEL_SERVER_TLS` and `KERSTEL_SERVER_TLS_NAMES`, and `--tls self` ignores `KERSTEL_SERVER_DOMAIN`.

With an enroll token, only a device that has it can create a vault: set `KERSTEL_SYNC_ENROLL_TOKEN` when you run `sync setup`. Joining an existing vault never needs it. `--enroll-token-file` creates the file with a new token when it does not exist, and says so without printing the token.

Two commands read a running setup. `kerstel-server info` prints the version, the TLS mode and, with `--tls self`, the pin. `kerstel-server value --url <url>` prints a server value (`ks-server1-…`) from the token file and the pin, with the same flags and environment variables as the server. Up to four `--url` addresses are allowed. Pass the value to a device with `kerstel sync setup --server-value -` on stdin. With Docker, run it as `docker exec kerstel-server kerstel-server value --url <url>`.

### Its own certificate, pinned

This needs no domain and no proxy. The server makes a certificate for itself, and your devices trust exactly that one. Start it on an address your devices can reach, and name that address:

```bash
./kerstel-server-linux-x64 --db /var/lib/kerstel/server.db \
  --listen 0.0.0.0:8787 --tls self --tls-name 203.0.113.7
```

`--tls-name` adds a DNS name or an IP address to the certificate. Repeat it for more. The certificate always covers `localhost` and `127.0.0.1`, and the `--listen` host when it is a specific address. If you add a name later, the server reissues the certificate with the same key, so devices that already pin it keep working.

When it starts, the server prints the pin of its certificate:

```
Certificate pin: sha256/…
```

Give that pin to `sync setup`:

```bash
kerstel sync setup https://203.0.113.7:8787 --pin sha256/…
```

Kerstel checks the server's key on every request. If the key changes, it sends nothing and says so. The pin travels inside the line that `add-device` prints, so your other devices pair as before and never type it.

The server keeps its key and certificate beside its database, as `<db>.tls-key.pem` and `<db>.tls-cert.pem`. The key stays the same across restarts, so the pin does too. A new database file means a new key and a new pin.

You can give the server a domain later. Start it with `--domain` and the same database file. Its Let's Encrypt certificate is for the same key, so devices that pin it keep working.

With Docker, name the address and set the mode with environment variables, and publish the port:

```bash
docker run -d --name kerstel-server --restart unless-stopped -p 8787:8787 -v kerstel-server:/data \
  -e KERSTEL_SERVER_TLS=self -e KERSTEL_SERVER_TLS_NAMES=203.0.113.7 \
  ghcr.io/alilibx/kerstel-server:latest
docker logs kerstel-server | grep 'Certificate pin'
```

### Your domain, with Let's Encrypt

Point a DNS record for your domain at the server, and let traffic reach it on TCP 80 and 443. The server answers Let's Encrypt's challenge on port 80 and serves HTTPS on port 443. It gets the certificate when it starts and renews it when fewer than 30 days remain, checking every 12 hours. A certificate that lasts less than 90 days is renewed when a third of its time remains.

```bash
sudo ./kerstel-server-linux-x64 --db /var/lib/kerstel/server.db \
  --domain sync.example.com --acme-email you@example.com
```

Listening on 80 and 443 needs root, as `sudo` gives here, or `CAP_NET_BIND_SERVICE` on Linux.

Running with `--domain` means you agree to the ACME CA's terms of service (Let's Encrypt by default). `--acme-email` is optional. If the server can't get a certificate, it says what to fix, prints `No certificate yet. Trying again in an hour.`, and retries. The ACME account key lives beside the database as `<db>.acme-account.pem`.

With Docker, the image listens on 8787 unless you say otherwise, so set the listen address to 443. Keep `--restart unless-stopped`: a renewal restarts the HTTPS listener. If it can't listen again within 10 tries, a second apart, the server exits so Docker can start it again.

```bash
docker run -d --name kerstel-server --restart unless-stopped -p 80:80 -p 443:443 -v kerstel-server:/data \
  -e KERSTEL_SERVER_DOMAIN=sync.example.com \
  -e KERSTEL_SERVER_LISTEN=0.0.0.0:443 \
  ghcr.io/alilibx/kerstel-server:latest
```

Then, on your first device:

```bash
kerstel sync setup https://sync.example.com
```

No pin is needed: the certificate is one every device already trusts.

### Tailscale

If all your devices are on a Tailscale network, let Tailscale serve HTTPS. Start the server on this machine only, then publish it to your tailnet:

```bash
kerstel-server --listen 127.0.0.1:8787
tailscale serve --bg 8787
```

With Docker, publish the port on the loopback address and run the same `tailscale serve` command on the host:

```bash
docker run -d --name kerstel-server --restart unless-stopped -p 127.0.0.1:8787:8787 -v kerstel-server:/data ghcr.io/alilibx/kerstel-server:latest
tailscale serve --bg 8787
```

On a server the wizard set up, `kerstel sync server remove` turns off `tailscale serve` on port 443, including any other handlers you set up there.

Turn on HTTPS certificates for your tailnet first: in the Tailscale admin console, open DNS and enable MagicDNS and HTTPS Certificates. Every device that syncs must be on the tailnet. The address is `https://<machine>.<tailnet>.ts.net`, with no pin:

```bash
kerstel sync setup https://<machine>.<tailnet>.ts.net
```

### Behind your own proxy

Without `--tls` or `--domain`, the server speaks plain HTTP. Put it behind a proxy that terminates TLS, and start it with `--trust-proxy` so rate limits apply to each client rather than to the proxy. With Caddy:

```
sync.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

## Turn it on with an address

To use a server you already run, on the device that holds your vault:

```bash
kerstel sync setup https://sync.example.com
```

For a server with its own certificate, add the pin the server printed: `kerstel sync setup https://203.0.113.7:8787 --pin sha256/…`. `--pin` works only with an `https://` URL. Without it, `sync setup` can't check that server's certificate, and says to pass `--pin`. A pin that is not the server's fails, and nothing is sent.

It shows the server, whether its certificate is pinned, how many secrets and scopes it will upload, and this device's name, then asks before uploading. The device name is sealed, so the server never sees it.

## Add a device

On the device that is already syncing:

```bash
kerstel sync add-device
```

It prints one line to run on the new device, and copies it to the clipboard when it can (with `pbcopy`, `wl-copy`, `xclip` or `xsel`; over SSH on a Mac it skips `pbcopy`, which would fill the other Mac's clipboard):

```bash
kerstel sync join ks1-…
```

On the new device, paste the line as a command. Or run `kerstel sync join` on its own and paste the value at the hidden prompt, which keeps it out of your shell history. `join` prints the server it is joining before you confirm anything. The value holds the server address, the certificate pin when the server has one, and the pairing secret, so treat it as a secret until it expires. It works once and expires in 10 minutes. A device older than 0.4.0 can't read it: update that device first with `kerstel update`. To pair from a device on 0.3, run `kerstel sync join <url> <code>` instead. When the new device answers, both devices show the new device's key fingerprint. Check that they match, then say yes on the first device. The new device checks that the sync key it receives is the one you confirmed, so a server cannot slip in a key of its own.

A new device that already holds secrets merges them in. A key only it holds is uploaded. A key both vaults hold with different values becomes a conflict for you to settle, and nothing is overwritten.

## Day to day

You don't need to run anything. Every synced device pulls changes every five minutes on its own, through a launchd agent on macOS or a systemd user timer on Linux. `sync setup` and `sync join` install it, and a device that already syncs gets it on its next sync. It pulls while you are logged in: a device that was logged out catches up within five minutes of the next login. Kerstel never turns on systemd lingering and never unlocks your keyring. Where pulls can't be scheduled, on Linux with no systemd user session or on a Mac nobody is logged in to (over SSH, for example), `sync setup`, `sync join` and every `kerstel sync` you run say so, and pulls still happen on `run`, `exec` and every write. On macOS, the first time the pull is scheduled, the system shows a "Background Items Added" notification, and turning Kerstel off under Login Items in System Settings stops the pulls.

After a command that writes the vault (`set`, `rm`, `init`, `move`, or `ui`), Kerstel pushes the change in the background at once. `run` and `exec` start a background sync when none has started in the last minute, or five minutes after a failed one. Neither one waits for the network, and an unreachable server never fails the command. A value pulled after an app starts reaches it the next time it starts.

`kerstel sync status` and `kerstel doctor` show the server, the last successful sync, when the scheduled pull last ran, changes still waiting to be pushed, open conflicts, and the last error. For a pinned server, `sync status` also shows a `Certificate` line with its pin. `doctor` warns after seven days without a successful sync, and when the scheduled pull is missing or its settings differ from your shell's. `kerstel sync off` and `kerstel uninstall` remove the scheduled pull. A scheduled pull that finds no vault, as when `KERSTEL_HOME` is on a drive that isn't mounted yet, does nothing and runs again five minutes later. You need `kerstel sync` itself only to settle a conflict or to see what changed.

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

To stop syncing the device you are on, run `kerstel sync off`. Its secrets stay on it. If this device's sync settings are damaged, `sync off` still turns sync off here, but can't leave the vault on the server. `kerstel uninstall` leaves the vault first.

## What the server sees

| The server sees | The server never sees |
|---|---|
| A random vault ID | Scope names, key names, values |
| Each device's random ID and public keys | Device names and hostnames |
| How many records a vault holds, their sizes, and when they change | Project paths, `.env` contents, backups |
| Opaque record IDs, and which of them are deletions | Which record is which key |
| The IP address of each request | The sync key or any data key |

The [security model](/security) covers what a hostile server can and cannot do.
