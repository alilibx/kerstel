# Easy sync

- **Status:** draft for review, 2026-11-13
- **Release:** 0.4.0, after 0.3.0 and before access gating (Next)
- **Issues:** [#105](https://github.com/alilibx/kerstel/issues/105) automatic pulls, [#106](https://github.com/alilibx/kerstel/issues/106) one-command server, [#112](https://github.com/alilibx/kerstel/issues/112) HTTPS without a hand-configured proxy, [#108](https://github.com/alilibx/kerstel/issues/108) pair with one pasted value
- **Builds on:** the sync spec (`2026-11-08-sync-between-devices-design.md`). This spec changes its §7.1, §8.1, §9.1, §10 and §13 question 2, and each PR that ships a part updates those sections.

## 1. Problem

0.3.0 made sync work. Setting it up is still hard enough that most people stop partway:

- Starting a server means copying a long `docker run` line, or downloading a binary, checking it against `SHA256SUMS` and writing a service file.
- A server on another machine needs HTTPS, because devices send a vault only to an `https://` URL or to `localhost`. Today that means a domain, DNS, a reverse proxy such as Caddy, and `--trust-proxy`. A box at home reached at `http://192.168.1.20` is refused.
- Pairing prints a URL and a 24-character code to carry to the new device.
- A device pulls only when `run` or `exec` starts after five quiet minutes, or when you run `ks sync`. A device you aren't using never catches up, so people think they must run `ks sync` by hand.

## 2. Intent

One command on the laptop you already use sets everything up. Kerstel installs the server for you, either over SSH or by handing you one command to run on the server. It asks only the questions that matter, then shows you how to add each other device with one pasted value. From then on, every device stays current without you running anything.

The people this serves run their server on a box at home or on a VPS. Both must work without a domain, without a reverse proxy, and without opening ports beyond the one the server listens on.

## 3. Goals, non-goals, anti-goals

**Goals**

- `ks sync setup` with no arguments is a guided wizard that ends with a running server, this device synced, and the next step shown (§4).
- The wizard can install the server over SSH, print one command to install it by hand, install it on this machine, or use a server you already have.
- Three ways for devices to reach the server, all in 0.4.0: a certificate the server makes and devices pin (the default), a Let's Encrypt certificate for your domain, and Tailscale (§6).
- Pairing takes one pasted value, offered on the clipboard (§7).
- Every synced device pulls on its own within a few minutes, including devices that already synced on 0.3.0 (§8).
- Kerstel remembers the server it installed and can show, update, stop and remove it (§9).

**Non-goals**

- Short pairing codes. They need a PAKE, which `node:crypto` lacks. The single value still carries the full 120-bit secret. Sync spec §13 question 2 stays open as later work.
- Reaching a home server from outside the home network. That is the network's job (Tailscale, or port forwarding). Kerstel only reports that the server is unreachable.
- Windows servers or clients (#17).
- Any change to the sync protocol, the record format, or what the server can see (sync spec §4).

**Anti-goals.** The release fails, even if it works, if any of these happen:

- The daemon gains network code. Pulls stay in a separate process (sync spec §8.1).
- The CLI gains listening code. It installs and starts `kerstel-server`; it never serves sync itself (sync spec §9.1).
- Kerstel stores or asks for an SSH password or private key.
- An enroll token appears in any process's command line, or in shell history, on the laptop or on the server. It never expires, so it travels only through files, stdin, hidden prompts and the SSH session's output. (A join value may be pasted as a `ks sync join` argument, as the URL and code are today: it works once and expires in 10 minutes. The bare `ks sync join` prompt is there for anyone who would rather not.)
- A wizard that fails halfway leaves a server running that Kerstel doesn't know about, or a second server beside the first.
- `ks sync` is shown anywhere as a step you must run regularly.

## 4. The setup wizard

`ks sync setup` without a URL starts the wizard. It needs a terminal; without one it fails with the usage line. `ks sync setup <url>` keeps working as today for scripts and for people who already run a server. A server value (§5.3) holds the enroll token, so it is never an argument: the wizard takes it at a hidden prompt, and scripts pass it on stdin with `ks sync setup --server-value -`. For a script that already has the URL and token, `ks sync setup <url> --pin <sha256>` adds the certificate pin; the token still comes from `KERSTEL_SYNC_ENROLL_TOKEN`.

The flow, in the CLI's existing Clack prompt style:

```
$ ks sync setup

◆  Where should the sync server run?
│  ● On another machine, over SSH
│  ○ On another machine, I'll run a command there myself
│  ○ On this machine
│  ○ I already have a server

◆  SSH host  (as you'd type it after "ssh")
│  ali@homebox

│  Connecting with your SSH setup… Linux arm64, Docker found.

◆  Run the server with
│  ● Docker   (ghcr.io/alilibx/kerstel-server:0.4.0)
│  ○ A service, no Docker   (systemd, checksum-verified binary)

◆  How will your other devices reach it?
│  ● Its own certificate, pinned by your devices   (no domain needed)
│  ○ My domain, with a Let's Encrypt certificate
│  ○ Tailscale   (homebox.tail1234.ts.net, found on this host)

◆  Address your devices use  (found 192.168.1.20)
│  192.168.1.20

✔  Server running on homebox, restarts on reboot
✔  This laptop is the first device. Synced 42 secrets.

Add your other devices with:  ks sync add-device
```

Wording is a draft. The order and the choices are decided.

- **Docker or a service** is asked only when Docker is present. Without it, the service path is used and the wizard says so.
- **How devices reach it** lists Tailscale only when Tailscale is running on the server host. The domain choice asks for the domain next and checks that it resolves to the host before installing.
- **The address** defaults to the domain or the `ts.net` name when one was chosen. For a pinned certificate it defaults to the host's public address on a VPS. On a home box, a device stores both the local name (`homebox.local`), when this device can resolve it, and the LAN IP, and tries them in that order, except that the address that answered last goes first. The pin checks the server's key, not its name, so every address is equally safe, and a device that can't resolve `.local` names (no mDNS on many Linux, WSL and VPN setups) still reaches the IP. The join value carries both. Without a name, the wizard warns that you should reserve the IP in your router, since a new one breaks sync until you run `ks sync server address` (§9). `ks sync status` shows which address answered. The builder decides how to tell a VPS from a home box and when to ask.
- After the server is up, the wizard runs the rest of today's `setup`: it creates the vault, registers, uploads, and installs the pull timer (§8).
- Running `ks sync setup` on a device that already syncs says so and points to `ks sync server` and `ks sync add-device`, as today.
- **The install record comes first.** Before it starts anything on the host, the wizard saves an install record (§9) marked unfinished, with a random install ID that it also writes to a marker file beside the server's data. A rerun that finds a server with its own install ID resumes it. My call.
- **A host that already runs a Kerstel server** with an install ID this device has no record of (a second laptop running the wizard, say) is never given a second vault by surprise. The wizard says the host already runs a server and that, if another device already syncs with it, you should run `ks sync add-device` there instead. It offers to stop without changes. My call.

## 5. Installing the server

### 5.1 Over SSH

- Kerstel runs the system `ssh` binary, so your keys, agent, `~/.ssh/config`, jump hosts and known-hosts checks all apply. It passes no password and stores no key. A host-key prompt or a passphrase prompt reaches you through the terminal.
- It finds the OS and architecture (`uname -sm`) and whether Docker and Tailscale are available. Supported hosts are the four `kerstel-server` builds: Linux and macOS, x64 and arm64.
- **Docker:** it runs `ghcr.io/alilibx/kerstel-server` pinned to this CLI's exact version, with a named volume and `--restart unless-stopped`. The server creates the enroll token itself on first start, inside its data volume and as its own non-root user (`kerstel-server` gains a create-if-missing mode for `--enroll-token-file`), so no file needs root to hand over. The wizard reads it back with `docker cp` to stdout, which needs no shell in the distroless image. The service path uses the same create-if-missing mode.
- **Service:** it downloads the matching `kerstel-server` binary on the host, verifies it against the release's `SHA256SUMS` exactly as `kerstel update` does (`packages/cli/src/update/`), and installs a systemd service (Linux) or a launchd agent (macOS) that starts on boot.
- **Root.** Kerstel prefers running as the SSH user. When a step needs root (a system service, binding a port below 1024 for Let's Encrypt), the wizard says which step and why, then runs it with `sudo` in an interactive SSH session so you answer the sudo prompt yourself. My call; the builder picks the exact mechanism per path.
- **Secrets on the host.** The enroll token is generated on the host by the server itself and written to a file with mode `0600`, owned by the user the server runs as. It reaches the laptop over the SSH session's output, never through a command line on either side. Commands that would need a secret read it from a file or stdin.
- **Idempotent.** Each step checks what already exists. A failed run can be rerun and continues; it never starts a second server. A step that fails reports what it left in place.

### 5.2 A command to run yourself

For people who won't let Kerstel log in over SSH. The wizard asks the same questions it can't detect (Docker or not, how devices reach it, the address), then prints one command to paste on the server: a short installer that downloads the matching binary or image, verifies it, starts it, and generates the enroll token.

When it finishes, the installer prints one **server value** (§5.3). You paste that back into the waiting wizard, which then continues as in §4. So the laptop gets the URL, the certificate pin and the enroll token from one paste.

The installer's source is part of the release, checked by `SHA256SUMS`, and the printed command verifies it before running it. The builder decides the exact form (for example, a pinned-hash download of an installer script, or `kerstel-server install`).

### 5.3 The server value

One string, `ks-server1-…`, that carries the server's URL, its certificate pin (if any) and the enroll token. It is what the hand-run installer prints and what the wizard's hidden prompt accepts. It contains a secret, so the installer says to paste it only into Kerstel. Encoding is the builder's call; it must be copy-safe in a terminal (no spaces, no shell-special characters).

### 5.4 On this machine

Installs the server locally with the same Docker or service choice. Devices elsewhere still need one of the three ways in §6; the wizard notes that a laptop server is reachable only while the laptop is on.

### 5.5 A server you already have

Asks for its URL, or a server value at a hidden prompt, then runs today's `setup`. An enroll token can come from `KERSTEL_SYNC_ENROLL_TOKEN` or a prompt with hidden input.

## 6. How devices reach the server (#112)

`kerstel-server` gains built-in TLS. It still runs plain HTTP behind a reverse proxy for people who want that (`--listen` and `--trust-proxy` are unchanged).

### 6.1 Its own certificate, pinned (default)

- On first start with `--tls self` (exact flag naming is the builder's), the server generates a key pair and a long-lived self-signed certificate covering the address the wizard gave it, and keeps both beside its database. It never renews; nothing outside your devices needs to trust it.
- Devices trust this one certificate and nothing else. The pin is the SHA-256 of the certificate's public key (SPKI), so reissuing the certificate with the same key keeps working.
- The laptop gets the pin over SSH or in the server value. Every other device gets it inside the join value (§7). No device ever asks "trust this certificate?".
- With a pin set, the client checks the server's key against the pin instead of a certificate authority, and the `https://` rule of sync spec §7.1 is met. A pin mismatch fails the request with a clear message and is never retried without the pin.
- The key lives with the database and survives `update`, `stop`, and a `remove` that keeps the data. A new key therefore means the server's data is gone too, which sync spec §4 already covers as a deleted vault: every device still has its full vault. On a pin mismatch, `ks sync off` turns sync off on this device even though it can't reach the server to remove itself, and says so. You then run `ks sync setup` once and pair the other devices again. Re-pinning to a new key without re-pairing is out of scope, since a changed key is exactly what a hostile network would present. My call.
- **Constraints for the builder:** the client must pin with what Bun's `fetch` offers in the pinned Bun version (1.4.2), and keep `redirect: "manual"`. A builder check found that `fetch` alone can't enforce an SPKI pin: with `rejectUnauthorized: false`, `checkServerIdentity` never runs. A workable route is to fetch the certificate in one TLS connection, check its key against the pin, then pass that certificate as `ca` and skip only the hostname check in `checkServerIdentity`. That first connection must honour `HTTPS_PROXY` (sync spec §8.1), or the plan must say why it can't. Generating the certificate must not add a dependency to the CLI binary; the server may take one if `node:crypto` can't produce an X.509 certificate, but hand-built DER for one self-signed certificate is preferred.

### 6.2 Your domain, with Let's Encrypt

- `kerstel-server --domain sync.example.com` gets a certificate from Let's Encrypt and renews it before it expires. It needs the domain to resolve to the host and the ACME challenge port reachable (80 for HTTP-01, or 443 for TLS-ALPN-01; builder's call).
- Devices use the normal certificate authority check; no pin.
- The wizard checks DNS before installing and, if the challenge fails, says which port or record is missing.

### 6.3 Tailscale

- When Tailscale is running on the host, the wizard offers its `https://<name>.<tailnet>.ts.net` address. The server listens on `127.0.0.1` only, and Kerstel runs `tailscale serve` on the host to put HTTPS in front of it.
- Devices use the normal certificate check; no pin. Every device that syncs must be on the tailnet; the wizard says so.
- If `tailscale serve` needs HTTPS certificates enabled for the tailnet, the wizard says exactly what to turn on in the Tailscale admin console.

## 7. Pairing with one value (#108)

- `ks sync add-device` prints one line, `ks sync join <value>`, and copies it to the clipboard when it can (`pbcopy`, `wl-copy`, `xclip` or `xsel`; not `pbcopy` over SSH), saying so. When it can't, it says nothing about the clipboard.
- The join value carries the server URL, the certificate pin when there is one, and the 120-bit pairing secret. Its prefix (`ks1-`) versions the format. The pairing ID is still derived from the secret, so the server sees exactly what it sees today.
- `ks sync join` with no arguments asks for the value with hidden input and accepts the whole line pasted (`ks sync join ks1-…`).
- `ks sync join <url> <code>` keeps working, so a 0.4.0 device can join from an older one.
- A device older than 0.4.0 cannot read a join value. `add-device` prints one dimmed line under the join line: if the new device runs an older Kerstel, update it first with `kerstel update`. A pinned server needs 0.4.0 on every device in any case.
- The fingerprint confirmation of sync spec §7.1 is unchanged: both devices show it, and the existing device asks before adding the new one.
- The join value is a secret for its 10 minutes. It is never logged and never passed to another process on the command line.

## 8. Automatic pulls (#105)

- `setup` and `join` install a timer that runs `kerstel sync --background` every five minutes: a launchd agent on macOS, a systemd user timer on Linux.
- `run` and `exec` start a background sync when none has started in the last minute, instead of the last five. They never wait for it. After a failed sync the five-minute guard applies, so an unreachable server never costs a process on every run. A watch loop that starts a run every few seconds therefore costs at most one sync a minute, well under the server's 60 requests a minute per device. My call.
- A device that already synced on 0.3.0 gets the timer on its first sync after the upgrade, background or foreground, without being asked. The next command prints one line saying it was added and how to turn sync off.
- `ks sync off` and `kerstel uninstall` remove the timer.
- `doctor` and `ks sync status` show the timer and when it last ran.
- Where no systemd user session exists, Kerstel says so once, and pulls still happen on `run`, `exec` and every write.
- **Logged out.** The timer pulls while you are logged in. A systemd user timer stops when you log out unless lingering is on, and even then the login keyring that holds the data key is usually locked. Kerstel does not enable lingering or unlock anything. A device that was logged out catches up within five minutes of the next login. `doctor` shows when the last pull ran, so the gap is never silent. Pulling while logged out is out of scope.
- The background process is the one sync spec §8.1 describes: same lock, same environment allowlist, prints nothing, keeps conflicts open.
- **The timer's environment.** A launchd agent or systemd unit inherits no shell environment, so the unit records the allowlisted variables that are set when it is installed: `KERSTEL_HOME`, `KERSTEL_KEYCHAIN_BACKEND`, and the proxy and CA settings of sync spec §8.1. A foreground `ks sync` rewrites the unit when they have changed, and `doctor` warns when the shell and the unit disagree. The unit never records a secret.
- The conflict line on stderr (sync spec §8.4) is the only time a user is told to run `ks sync`.

## 9. Looking after the server (#106)

Kerstel records how it installed the server: the host, the SSH target, Docker or service, the reach method, and the version. Only the device that installed it holds this record; it never syncs. `ks sync server` on any other device shows the address, whether it answers and its version, and says the server is managed from another device, with `ks sync server manage <ssh-host>` to take it over. No device learns which device manages it, since nothing that syncs or that the server holds records that. My call. Where it lives is the builder's call (a `vault_meta` row or a file under `~/.kerstel/`).

| Command | Does |
|---|---|
| `ks sync server` | Shows the server's address, whether it answers, its version, and how it was installed |
| `ks sync server update` | Updates the server to this CLI's version, over SSH, with the same checks as install |
| `ks sync server address <url>` | Points this device at the server's new address. Run it on each device. It keeps the pin, and saves the new address only if the server there answers with the pinned key and knows this vault |
| `ks sync server manage <ssh-host>` | Takes over management from another device (below) |
| `ks sync server stop` | Stops it and keeps its data |
| `ks sync server remove` | Stops and uninstalls it. Asks separately before deleting its database; the default is to keep it |

- For a server installed by hand (§5.2), these commands print the matching line to run on the server instead.
- **Updates.** After `kerstel update` installs a new CLI, it checks the server's version (`GET /v1/health`). If the server is older and this device installed it, it says so and asks whether to update it now. Without a terminal it only says so. `doctor` shows a server that is behind.
- `kerstel uninstall` on the installing device asks whether to remove the server too; the default is no, since other devices may still use it.
- **Taking over management.** `ks sync server manage <ssh-host>` on another synced device takes over: over SSH, it reads the host's install marker and checks that the server there is the one this vault syncs with, then saves the install record here. `kerstel uninstall` and `ks sync off` on the managing device name this command, so a server is never left with nobody able to update it. My call.

## 10. Effects on existing copy

In the PR that ships each part:

- The sync spec sections named at the top of this spec.
- The website's Sync page leads with `ks sync setup` and the wizard. It stops implying you must run `ks sync` by hand. The Caddy example moves to a "behind your own proxy" section.
- The README's sync section, and `ks sync --help`.
- `CHANGELOG.md` under the unreleased section, and the matching `ROADMAP.md` box, per AGENTS.md.
- Every command, flag and message in the copy is checked against the CLI source.

## 11. Build order

Four PRs, one per issue, each shippable alone:

1. **#105 automatic pulls.** Independent of the rest.
2. **#108 join value.** Defines the value format with a pin field, before anything sets a pin.
3. **#112 built-in TLS** in `kerstel-server`, with the pin check in the client.
4. **#106 the wizard and `ks sync server`.** Ties the other three together.

## 12. Testing

- Join value and server value: round trip, old `join <url> <code>` form, a malformed or truncated value refused with a clear message.
- Pinning: a matching pin connects; a different key fails and is not retried without the pin; no redirect is followed.
- Server TLS: a self-signed certificate for an IP and for a name; ACME against a local test CA (Pebble or the builder's equivalent) in CI, not Let's Encrypt.
- Wizard over SSH: against a local SSH target in CI (a container with `sshd`), covering Docker and service paths, a rerun after a failure partway, and a rerun on an installed server.
- No test prints a secret. No enroll token appears in the argv of any process Kerstel spawns, locally or over SSH (check by inspecting argv in tests).
- Timer install and removal on macOS and Linux runners.
- Every temporary home, server database, container and timer is cleaned up.

## 13. Left to the builder

- Exact flag names on `kerstel-server` for the TLS modes.
- The encoding of the join value and the server value.
- How the wizard tells a VPS from a home box when picking the default address.
- The ACME client: a library inside `kerstel-server`, or hand-rolled.
- Where the install record lives.
- The form of the hand-run install command.
