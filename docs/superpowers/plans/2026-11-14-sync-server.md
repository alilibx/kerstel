# Setup wizard and `ks sync server` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ks sync setup` with no arguments is a wizard that installs `kerstel-server` over SSH, by a command you paste on the server, or on this machine, and then syncs this device; `ks sync server` shows, updates, moves, stops and removes the server it installed (#106).

**Architecture:** One POSIX `sh` installer, `kerstel-server.sh`, does every step on the server host: detect, install (Docker or a service), and later info, update, stop and remove. The CLI embeds it, so its version always matches the CLI's. The CLI runs it over SSH (uploaded through stdin, then run in an SSH session with a terminal for `sudo`), locally, or prints a one-line command that downloads the released copy and checks its SHA-256 first. The installer never builds secrets itself: `kerstel-server` creates the enroll token on first start and prints the server value (`ks-server1-…`) through a `value` subcommand, which reads the token from its file. The CLI reads that value from the session's output, so the token never appears on a command line. The CLI records what it installed in `~/.kerstel/sync-server.json`. A device can hold several addresses for one server and tries them in order.

**Tech Stack:** TypeScript on Bun 1.4.2, `bun:test`, POSIX `sh` (checked with `shellcheck`), the system `ssh`, Docker, systemd, launchd. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-13-easy-sync-design.md` §2-§5, §6.3 (the Tailscale steps), §9, §10, §12. It updates sync spec `docs/superpowers/specs/2026-11-08-sync-between-devices-design.md` §7.1, §9.1 and §10.

**Branch:** `feat/sync-server`, stacked on `feat/server-tls` (PR #118), which is stacked on `feat/join-value` (PR #117).

## Global Constraints

- The CLI gains no listening code; it installs and starts `kerstel-server`. The daemon gains no network code.
- Kerstel never stores or asks for an SSH password or private key. It runs the system `ssh`, so the user's keys, agent, `~/.ssh/config`, jump hosts and known-hosts checks apply, and host-key and passphrase prompts reach the user's terminal.
- An enroll token never appears in any process's command line or shell history, on either machine. It travels only through files, stdin, hidden prompts and the SSH session's output. Tests check the argv of every process Kerstel spawns, locally and over SSH.
- A server value (`ks-server1-…`) holds the enroll token, so it is never an argument: the wizard takes it at a hidden prompt, and scripts pass it on stdin with `ks sync setup --server-value -`.
- A wizard that fails halfway never leaves a server running that Kerstel has no record of, and never starts a second server beside the first.
- Every step on the host checks what already exists, so a rerun continues where a failed run stopped.
- The server runs the CLI's exact version: `ghcr.io/alilibx/kerstel-server:<version>`, or the `kerstel-server-<platform>` binary of that release, checked against the release's `SHA256SUMS` as `kerstel update` checks the CLI.
- Supported hosts are the four `kerstel-server` builds: Linux and macOS, x64 and arm64.
- `ks sync` is never shown as a step to run regularly.
- Tests never touch the real `~/Library/LaunchAgents`, `/Library/LaunchDaemons`, `/etc/systemd`, `launchctl`, `systemctl`, `docker`, `tailscale`, `ssh`, or the developer's real `~/.kerstel`. They never print a secret, and they clean up every temporary home, container, unit and listener. The SSH end-to-end test runs only in CI or when `KERSTEL_TEST_SSH_HOST` is set.
- Copy uses `cliName()`. Status lines go to stderr with `process.stderr.write`. Every user-visible change gets a `CHANGELOG.md` line, and the website and README match the source (AGENTS.md).

## Decisions for the maintainer

- **One installer, three routes.** `kerstel-server.sh` is the hand-run installer of spec §5.2 and also what the CLI runs over SSH and on this machine, so all three behave the same. It ships in each release as `kerstel-server.sh`, covered by `SHA256SUMS`. The printed command downloads that exact version, checks its SHA-256 against a hash the CLI computed from its own embedded copy, and only then runs it.
- **Over SSH:** the CLI uploads the installer to `~/.kerstel-server/kerstel-server.sh` through `ssh <host> 'umask 077; mkdir -p ~/.kerstel-server && cat > …'` (no secret in it), then runs `ssh -t <host> sh ~/.kerstel-server/kerstel-server.sh <command> <args>`. With `-t`, `sudo` prompts reach the user. The CLI copies the session's output to the terminal line by line, except that it reads any `ks-server1-…` value instead of printing it.
- **The token and the value are made by `kerstel-server`.** `--enroll-token-file <file>` now creates the file (random 32 bytes, base64url, mode `0600`) when it does not exist, and logs that it did, without the token. A mistyped path fails closed: no device can create a vault until the right token is used. `kerstel-server value --url <url>…` prints `ks-server1-…` from the token file and the TLS pin, using the same flags and environment variables as the server. In Docker it runs as `docker exec kerstel-server kerstel-server value …`, which needs no shell in the distroless image.
- **The install ID** is made by the CLI and saved in the install record (marked unfinished) before anything changes on the host. The installer stores it as the container label `dev.kerstel.install-id`, or in `~/.kerstel-server/install-id` for a service.
- **Where things live on the host.** Docker uses container `kerstel-server`, volume `kerstel-server`, `--restart unless-stopped`, and the token at `/data/enroll-token`. A service keeps its data, binary and token in `~/.kerstel-server/` of the SSH user. On Linux the unit is `/etc/systemd/system/kerstel-server.service`, running as that user. On macOS it is `/Library/LaunchDaemons/dev.kerstel.server.plist` with `UserName`. Both need `sudo` once, and the installer says why before it asks. For `--domain`, the Linux unit adds `AmbientCapabilities=CAP_NET_BIND_SERVICE`.
- **The install record** is `~/.kerstel/sync-server.json`, mode `0600`. It holds no secret and never syncs.
- **Several addresses.** `SyncConfig.servers: string[]` replaces `server`. The first address that answers in a process is used for the rest of it, and `ks sync status` shows which one answered last. Join values carry up to four addresses (#108's format already allows this). A pin mismatch never moves on to the next address.
- **Telling a VPS from a home box.** The installer reports the host's IPv4 addresses. Any public one (not 10/8, 172.16/12, 192.168/16, 100.64/10, 127/8 or 169.254/16) means a VPS, and the default address is `https://<public-ip>:8787`. Otherwise it is a home box: the defaults are `https://<hostname>.local:8787`, when this device resolves that name, then `https://<lan-ip>:8787`. The wizard shows them and lets you edit them.
- **The SSH end-to-end test** runs in a CI job on `ubuntu-latest`. The job starts `sshd` on `127.0.0.1:2222` for the runner user, builds the server image and binary for the CLI's version, and serves them from a loopback mirror. The installer accepts `--releases-url` only for `https://` or loopback `http://`, like `KERSTEL_RELEASES_URL`.

## Review Focus

1. **A wizard that dies after the server started but before this device synced** (Ctrl-C, a dropped SSH session, a failed upload). A rerun finds its unfinished record and the host's matching install ID, resumes, and never starts a second server. Tests: Task 8, `a rerun resumes an unfinished install`; Task 4, `install twice starts one server`.
2. **A second laptop running the wizard against a host that already runs a Kerstel server.** It stops without changes and points to `ks sync add-device`. Test: Task 8, `a host with someone else's server is left alone`.
3. **An enroll token in argv,** on the laptop or the host. Tests: Task 4, `the token never reaches argv` (the fake `docker` and `systemctl` record argv); Task 6, `ssh argv never carries a token or a value`.
4. **A home box whose `.local` name doesn't resolve on another device** (WSL, many Linux setups, VPNs). That device falls back to the LAN IP. Test: Task 2, `the next address is tried when one can't be reached`.
5. **`sudo` asks for a password.** The prompt reaches the user, and nothing the user types is captured or logged. Test: Task 6, `output passes through and only the value is held back`, with a fake `ssh` that prints `[sudo] password for ali:` without a newline.

---

### Task 1: The server makes its token and prints its value

**Files:**
- Create: `packages/server/src/server-value.ts`
- Modify: `packages/server/src/index.ts` (`--enroll-token-file` create-if-missing, `KERSTEL_SERVER_ENROLL_TOKEN_FILE`, the `value` and `info` subcommands, `HELP`)
- Test: `packages/server/test/server-value.test.ts`, `packages/server/test/server.test.ts`

**Interfaces:**
- Produces, in `server-value.ts` (imports only `node:crypto` and `./pin`):
  - `interface ServerValue { urls: string[]; pin: Buffer | null; token: string }`
  - `SERVER_VALUE_PREFIX = "ks-server1-"`
  - `encodeServerValue(v: ServerValue): string`. The record: flag byte (bit 0 = pin), the pin when flagged, a 1-byte token length and the token in UTF-8 (1-255 bytes), the URLs joined with `\n` (1-4, no control characters), then 4 bytes of SHA-256 over all of that. Unpadded base64url. It throws on bad input.
  - `parseServerValue(text: string): ServerValue | "malformed" | "newer"`, with the same rules as `parseJoinValue` (trimming, `ks-server<N>-` with N > 1 is `newer`, a re-encode check, the checksum).
- `kerstel-server value --url <url> [--url <url>]…` prints exactly one line, the server value. It reads the token from `--enroll-token-file` or `KERSTEL_SERVER_ENROLL_TOKEN_FILE`, and the pin from the `--tls self` files beside `--db` when `--tls self` is set. It fails with exit 1 when there is no token file. It never prints the token in any other form.
- `kerstel-server info` prints `version=<v>`, `tls=off|self|acme` and, with `--tls self`, `pin=sha256/…`, one per line, and never the token.

- [ ] **Step 1: Write the failing tests:**
  - `server-value.test.ts`: a round trip with and without a pin and with two URLs; truncated and changed values are `malformed`; `ks-server2-…` is `newer`; encoding throws on an empty token, a 256-byte token, no URLs, five URLs, and a URL with `\t`.
  - `server.test.ts`: `--enroll-token-file` on a missing file creates it with mode `0600` and a 43-character token, and the same file is reused on the next start; the log line says it was created and does not contain the token; `KERSTEL_SERVER_ENROLL_TOKEN_FILE` works like the flag; a process test of `value --url https://a:8787 --url https://b:8787` with `--tls self` prints a value whose parsed token equals the file's and whose pin equals the certificate's; `info` prints no token.
- [ ] **Step 2: Run** `bun test packages/server`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the behaviour above. Write the token file with the same exclusive create used for the TLS key in `tls.ts`.
- [ ] **Step 4: Run** `bun test packages/server` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(server): make the enroll token and print a server value`.

### Task 2: A device holds several addresses for its server

**Files:**
- Modify: `packages/cli/src/sync/state.ts` (`SyncConfig.servers`, `SYNC_META.servers`, `SYNC_META.lastAddress`, `loadSync`, `writeSync`)
- Modify: `packages/cli/src/sync/http.ts` (`ClientOptions.servers`, address fallback)
- Modify: `packages/cli/src/commands/sync.ts`, `packages/cli/src/sync/background.ts`, `packages/cli/src/commands/uninstall.ts`, `packages/cli/src/doctor/checks.ts` (every `config.server` reader)
- Test: `packages/cli/test/sync.test.ts`, `packages/cli/test/sync-pin.test.ts`

**Interfaces:**
- Produces:
  - `SyncConfig.servers: string[]` (at least one). It is stored as `sync_server` (the first address, unchanged for a 0.3 vault) plus `sync_servers` (every address joined with `\n`). A vault with only `sync_server` loads as `[server]`.
  - `SYNC_META.lastAddress = "sync_last_address"`, written after each successful sync.
  - `syncClient({ servers, … })` and `pairingClient(servers: string[], fetch?, pin?)`. For each process, the first request tries the addresses in order and moves on only on `unreachable`. The address that answered is used for the rest of the client's life. `client.address(): string | null` returns it.

Behaviour to implement:
- `join` saves every address from the join value, in order. `add-device` writes `config.servers` into the join value.
- `ks sync status` prints `Server        <address that answered last> (also <others>)`, or the first address when none has answered yet.
- This also settles #108's deferred item: a pairing answer that timed out on one address and then gets `pairing_used` on the next one is reported as `That pairing may already have been answered. On the other device, check whether this device was added.`

- [ ] **Step 1: Write the failing tests:**
  - `the next address is tried when one can't be reached`: a config with `["http://127.0.0.1:1", SERVER]` syncs, and `sync_last_address` is `SERVER`.
  - `a pin mismatch never moves on`: with a pinned TLS server as the first address and a listener with another key as the second, the client fails with `pin_mismatch` and never contacts the second.
  - `a 0.3 vault loads as one address`.
  - `join saves every address`.
  - `status shows the address that answered`.
- [ ] **Step 2: Run** `bun test packages/cli/test/sync.test.ts packages/cli/test/sync-pin.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the behaviour above.
- [ ] **Step 4: Run** `bun test packages/cli` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(sync): try each of a server's addresses in order`.

### Task 3: `ks sync setup` takes a server value

**Files:**
- Modify: `packages/cli/src/commands/sync.ts` (split `setup` into argument parsing and an exported `enableSync`; `USAGE`)
- Create: `packages/cli/src/sync/server-value.ts`, which re-exports the server's codec for the CLI
- Test: `packages/cli/test/sync.test.ts`

**Interfaces:**
- Consumes: Task 1's codec, Task 2's `servers`.
- Produces: `enableSync(ctx: CliContext, o: { servers: string[]; pin: Buffer | null; token: string | null; yes: boolean; deps: SyncDeps }): Promise<number>`. It is today's `setup` body after parsing: the summary, the upload question, register, push and schedule. The wizard calls it.

Behaviour to implement:
- `ks sync setup --server-value -` reads one line from stdin and parses it. Errors name the problem the same way `join` does (malformed, newer, unsafe URL). The value's token is used in place of `KERSTEL_SYNC_ENROLL_TOKEN`.
- `ks sync setup <url> [--pin <pin>] [--yes]` is unchanged.
- `ks sync setup` with no arguments and no terminal fails with the usage line and returns 2. With a terminal it starts the wizard (Task 8). Until Task 8 lands, it prints the usage line.
- `USAGE` gains `` `  ${cliName()} sync setup                     Set up a server and this device, step by step` `` and `` `  ${cliName()} sync setup --server-value -    Read a server value from stdin` ``.

- [ ] **Step 1: Write the failing tests:**
  - `setup reads a server value from stdin`: it syncs with the value's URLs, pin and token against a TLS test server that requires that token.
  - `a bad server value is refused before any request`.
  - `the token from a server value is never printed`.
  - `setup with no arguments and no terminal prints the usage line`.
- [ ] **Step 2: Run** `bun test packages/cli/test/sync.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the behaviour above. Read stdin through an injectable `SyncDeps.stdin?: () => Promise<string>`.
- [ ] **Step 4: Run** `bun test packages/cli` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(sync): set up from a server value on stdin`.

### Task 4: The installer script

**Files:**
- Create: `packages/server/install/kerstel-server.sh`
- Create: `packages/server/test/installer.test.ts`, `packages/server/test/helpers/fake-host.ts`
- Modify: `.github/workflows/ci.yml` (`shellcheck packages/server/install/kerstel-server.sh` in the `website` job, next to the existing `install.sh` check)

**Interfaces:**
- Produces the command line `sh kerstel-server.sh <command> [options]`:
  - `detect` prints `os=`, `arch=`, `docker=yes|no`, `systemd=yes|no`, `tailscale=<dns name>|no`, `hostname=`, one `ipv4=` line per address, and `installed=docker|service|no` with `install-id=<id>` when installed.
  - `install --version <v> --install-id <id> --runtime docker|service --reach self|domain|tailscale [--name <address>]… [--domain <d>] [--port <p>] [--releases-url <url>] [--url <url>]…` installs or continues an install, then prints the server value line from `kerstel-server value`.
  - `info` prints the detect lines for the installed server, plus `version=`, `pin=` and `running=yes|no`.
  - `value --url <url>…` prints the server value again.
  - `update --version <v> [--releases-url <url>]` replaces the binary or the image, keeping data and settings, and restarts.
  - `stop` stops it and keeps everything.
  - `remove [--delete-data]` stops and uninstalls it, keeping the data unless asked.
- Output rules: progress lines start with `kerstel-server.sh: `. A line asking for `sudo` first says which step needs it and why. The value is printed as `Server value (paste it only into Kerstel): ks-server1-…`. Errors exit non-zero, after a line saying what was left in place.

Behaviour to implement (POSIX `sh`, `set -eu`, no bashisms, `shellcheck`-clean):
- `docker` is used as is when `docker info` works, else through `sudo` after saying so. `--runtime docker` with Docker missing is an error. The image is `ghcr.io/alilibx/kerstel-server:<version>`, used when present locally and pulled otherwise.
- Docker settings:
  - `self`: `-p 8787:8787`, `KERSTEL_SERVER_TLS=self`, `KERSTEL_SERVER_TLS_NAMES` from `--name`.
  - `domain`: `-p 80:80 -p 443:443`, `KERSTEL_SERVER_DOMAIN`, `KERSTEL_SERVER_LISTEN=0.0.0.0:443`.
  - `tailscale`: `-p 127.0.0.1:8787:8787`, then `tailscale serve --bg 8787`, through `sudo` when it needs it. When that fails because HTTPS certificates are off, it says to turn on MagicDNS and HTTPS Certificates under DNS in the Tailscale admin console.
  - Always: `KERSTEL_SERVER_ENROLL_TOKEN_FILE=/data/enroll-token`, `--label dev.kerstel.install-id=<id>`, `--restart unless-stopped`, volume `kerstel-server:/data`.
- The service runtime downloads `kerstel-server-<os>-<arch>` and `SHA256SUMS` from `<releases-url>/releases/download/v<version>/` with `curl` or `wget`, checks it with `sha256sum` or `shasum -a 256`, installs it to `~/.kerstel-server/bin/kerstel-server`, and writes the systemd unit or the launchd plist described in the decisions above, with `KERSTEL_SERVER_ENROLL_TOKEN_FILE=~/.kerstel-server/enroll-token`. It stores the install ID in `~/.kerstel-server/install-id`.
- Idempotent: an existing container, unit or binary with the same install ID is kept or updated, never doubled. A different install ID makes `install` stop with exit 3 and the line `kerstel-server.sh: this host already runs a Kerstel server that another device set up.`.
- No token ever appears in an argument. The value comes from `kerstel-server value`, which reads the file.

- [ ] **Step 1: Write `fake-host.ts`:** a temp `HOME` and a `bin` directory of fake `docker`, `systemctl`, `launchctl`, `sudo`, `tailscale`, `curl`, `uname`, `hostname` and `ip` scripts. They record their argv to a log and act on files under the temp dir. Fake `docker exec … value` and fake service starts run the real `packages/server/src/index.ts value` against the temp data dir, so the printed value is real. `sudo` runs its arguments.
- [ ] **Step 2: Write the failing tests** in `installer.test.ts`:
  - `detect reports the host`.
  - `install with Docker starts one container with the settings for each reach`.
  - `install twice starts one server`.
  - `another install ID is left alone` (exit 3).
  - `the service install verifies the checksum` (a wrong `SHA256SUMS` fails before anything is installed).
  - `the systemd unit runs as the user`.
  - `the token never reaches argv`: no logged argv contains the token from the token file.
  - `the value line is printed`.
  - `stop keeps data, remove keeps data unless asked`.
  - `update keeps the install ID and settings`.
  - Plus `shellcheck` on the script when `Bun.which("shellcheck")` exists.
- [ ] **Step 3: Run** `bun test packages/server/test/installer.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `kerstel-server.sh`.
- [ ] **Step 5: Run** the tests, `shellcheck packages/server/install/kerstel-server.sh` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** with the message `feat(server): an installer that sets up kerstel-server on a host`.

### Task 5: Ship the installer, and the command to paste

**Files:**
- Modify: `.github/workflows/release.yml` (copy `packages/server/install/kerstel-server.sh` into `release/` before `SHA256SUMS`, then publish it)
- Modify: `scripts/release-verify.ts` and its test, if they list the expected assets
- Create: `packages/cli/src/sync/installer.ts`
- Modify: `packages/cli/src/assets.d.ts` (`declare module "*.sh"`)
- Test: `packages/cli/test/sync-installer.test.ts`

**Interfaces:**
- Produces:
  - `installerScript(): string`, the embedded script's text, imported with `with { type: "file" }`.
  - `installerSha256(): string`.
  - `manualCommand(o: { version: string; args: string[]; releasesUrl?: string }): string`: one line, `(f=$(mktemp) && trap 'rm -f "$f"' EXIT && curl -fsSL <url>/releases/download/v<version>/kerstel-server.sh -o "$f" && (sha256sum 2>/dev/null || shasum -a 256) < "$f" | grep -q '^<hash> ' && sh "$f" <args>)`. It downloads to a private file (a fixed `/tmp` path could be swapped between the check and `sh` on a shared host), and `<args>` are each single-quoted. `<url>` is `KERSTEL_RELEASES_URL` or the GitHub repository, as in `release-source.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `the embedded script is the repository's`: its text equals `packages/server/install/kerstel-server.sh`, and its hash equals `sha256` of that file.
  - `the manual command checks the hash before running`: running the printed command in a temp dir against a loopback mirror serving the script runs it, and serving a changed script makes it exit non-zero without running it. Use a fake `sh` that records whether it ran.
  - `arguments are quoted`: an argument with a space and a `'` round-trips.
- [ ] **Step 2: Run** `bun test packages/cli/test/sync-installer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the module and the release change. Check that the compiled CLI embeds the script by running `bun run --cwd packages/cli build` and `./dist/kerstel --version`.
- [ ] **Step 4: Run** the tests and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(sync): ship the server installer and a command to paste`.

### Task 6: Run the installer over SSH or here

**Files:**
- Create: `packages/cli/src/sync/remote.ts`
- Test: `packages/cli/test/sync-remote.test.ts`

**Interfaces:**
- Consumes: Task 5's `installerScript`.
- Produces:
  - `interface InstallerRun { code: number; lines: string[]; value: string | null }`. `lines` holds every output line except the value.
  - `interface Host { label: string; run(args: string[], o?: { interactive?: boolean }): Promise<InstallerRun> }`
  - `sshHost(target: string, deps?: { spawn?: SpawnFn }): Host`. The first `run` uploads the script with `ssh -o BatchMode=no <target> 'umask 077; mkdir -p ~/.kerstel-server && cat > ~/.kerstel-server/kerstel-server.sh'`, with the script on stdin. Each `run` then executes `ssh [-t] <target> sh ~/.kerstel-server/kerstel-server.sh <quoted args>`, with `-t` when `interactive`. stdin is inherited for prompts. stdout and stderr are read chunk by chunk and copied to the terminal, except a line holding `ks-server1-…`, which is captured into `value` and never echoed.
  - `localHost(deps?): Host`, the same over `sh <temp copy>`. The temp copy is mode `0700` and deleted afterwards.
  - `SpawnFn = (argv: string[], o: { stdin: "inherit" | string }) => { stdout: ReadableStream; stderr: ReadableStream; exited: Promise<number> }`. It defaults to `Bun.spawn`.
  - A test-only `KERSTEL_TEST_SSH_CONFIG` adds `-F <file>` to every `ssh` argv. It is used only by the end-to-end test.

- [ ] **Step 1: Write the failing tests** with a fake `ssh` script on `PATH` that records argv and stdin and runs the remote command locally under `sh`:
  - `uploads, then runs`.
  - `ssh argv never carries a token or a value`: no argv contains the value or the token in it.
  - `output passes through and only the value is held back`: the fake prints `[sudo] password for ali:` with no newline, some lines, and the value. The terminal copy has all but the value, and `value` is set.
  - `a failed run reports its code`.
  - `localHost removes its temp copy`.
- [ ] **Step 2: Run** `bun test packages/cli/test/sync-remote.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `remote.ts`.
- [ ] **Step 4: Run** the tests and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(sync): run the server installer over ssh or on this machine`.

### Task 7: The install record and the wizard's defaults

**Files:**
- Create: `packages/cli/src/sync/install-record.ts`, `packages/cli/src/sync/host-facts.ts`
- Test: `packages/cli/test/sync-install-record.test.ts`

**Interfaces:**
- Produces:
  - `interface InstallRecord { installId: string; route: "ssh" | "manual" | "local"; host: string | null; runtime: "docker" | "service"; reach: "self" | "domain" | "tailscale"; addresses: string[]; version: string; finished: boolean }`.
  - `readInstallRecord(home?: string): InstallRecord | null`, `writeInstallRecord(r: InstallRecord, home?: string): void` (mode `0600`, an atomic rename) and `removeInstallRecord(home?: string): void`. The file is `<kerstelHome>/sync-server.json`.
  - `parseHostFacts(lines: string[]): HostFacts`, where `HostFacts = { os: "linux" | "darwin" | string; arch: string; docker: boolean; systemd: boolean; tailscale: string | null; hostname: string; ipv4: string[]; installed: "docker" | "service" | null; installId: string | null }`.
  - `defaultAddresses(facts: HostFacts, o: { port: number; resolves: (name: string) => Promise<boolean> }): Promise<{ kind: "vps" | "home"; addresses: string[]; warn: string | null }>`. It follows the rule in Decisions. `warn` is `` `No name for this host resolves here, so devices use its IP address. Reserve that address in your router: if it changes, run ${cliName()} sync server address on each device.` `` when a home box gets only an IP.

- [ ] **Step 1: Write the failing tests:** a record round trip with mode `0600`; a missing or malformed record reads as null; detect output parses; a public IP gives `vps` with that IP; private IPs with a resolving `.local` give the name first, then the IP; with nothing resolving they give the IP and the warning; CGNAT `100.64.0.0/10` counts as private.
- [ ] **Step 2: Run** `bun test packages/cli/test/sync-install-record.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules. `resolves` defaults to `dns.lookup` with a 2-second timeout.
- [ ] **Step 4: Run** the tests and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(sync): remember the server Kerstel installed`.

### Task 8: The wizard

**Files:**
- Create: `packages/cli/src/sync/wizard.ts`
- Modify: `packages/cli/src/commands/sync.ts` (`setup` with no arguments on a terminal runs the wizard)
- Test: `packages/cli/test/sync-wizard.test.ts`

**Interfaces:**
- Consumes: `Host` (Task 6), the install record and `defaultAddresses` (Task 7), `manualCommand` (Task 5), `enableSync` (Task 3), and `parseServerValue`.
- Produces: `runWizard(ctx: CliContext, deps: SyncDeps & { hostFor?: (route: "ssh" | "local", target: string | null) => Host; resolves?: (name: string) => Promise<boolean> }): Promise<number>`.

The flow, in order. The question text and choices are exact; the spec's draft wording is final here:
1. If sync is already on: `` Sync is already on for this vault. Run ${cliName()} sync server to see the server, or ${cliName()} sync add-device to add a device. ``, then return 0.
2. `select("Where should the sync server run?")`, with the choices `ssh` "On another machine, over SSH", `manual` "On another machine, I'll run a command there myself", `local` "On this machine" and `existing` "I already have a server".
3. **`existing`:** `text("Server address, or paste a server value", { secret: true })`. A `ks-server1-…` value goes to `enableSync` with its URLs, pin and token. A URL goes to `enableSync` with that URL, `KERSTEL_SYNC_ENROLL_TOKEN`, or else a hidden `text("Enroll token (leave empty if the server has none)", { secret: true })`.
4. **`ssh`:** `text('SSH host (as you\'d type it after "ssh")')`, then `host.run(["detect"])`, printing `Connecting with your SSH setup… <OS> <arch>, Docker found.` (or `no Docker`). An unsupported OS or arch stops with a message naming the four supported builds.
5. **`local`:** detect on `localHost()`, the same way.
6. **`manual`:** ask everything detection would have answered (runtime, reach, address). Print `manualCommand(...)` and say to run it on the server. Then `text("Paste the server value it printed", { secret: true })`.
7. When `detect` reports an installed server: if the record's `installId` matches, say `Found the server this device started setting up. Continuing.` and resume. Otherwise print `` <host> already runs a Kerstel server. If another device syncs with it, run ${cliName()} sync add-device there instead. `` and offer `stop` "Stop without changes" (the default) or nothing else. Return 1.
8. Runtime: `select("Run the server with")`, offering `docker` "Docker (ghcr.io/alilibx/kerstel-server:<version>)" and `service` "A service, no Docker (systemd, checksum-verified binary)", or "(launchd, …)" on macOS. It is asked only when Docker is present. Without Docker, it prints `No Docker on <host>, so the server runs as a service.`
9. Reach: `select("How will your other devices reach it?")`, offering `self` "Its own certificate, pinned by your devices (no domain needed)", `domain` "My domain, with a Let's Encrypt certificate", and `tailscale` "Tailscale (<dns name>, found on this host)" only when detected.
   - `domain`: ask `text("Domain")`. Resolve it here and compare with the host's IPv4s. On no match, warn `<domain> does not point at <host> yet. Let's Encrypt needs it to.` and ask whether to continue.
   - `tailscale`: say `Every device that syncs must be on your tailnet.`
10. Addresses: for `self`, `text("Address your devices use (found <addresses>)")`, prefilled with `defaultAddresses`; a comma-separated answer gives several. Print the warning when there is one. For `domain` and `tailscale`, the address is `https://<domain>` or `https://<dns name>`, with no question.
11. Write the install record with `finished: false` and a new install ID, then `host.run(["install", …], { interactive: true })`. A non-zero code prints `` The install stopped. Run ${cliName()} sync setup again to continue. `` and returns 1. The record stays unfinished.
12. On success: `ok("Server running on <host>, restarts on reboot")`, then `enableSync(…)` with the value's URLs, pin and token and `yes: true`, since the person already chose to set up. Then mark the record finished, and print `Add your other devices with:  <cli> sync add-device`.

- [ ] **Step 1: Write the failing tests,** with a `ScriptedPrompter`, a fake `Host` that returns scripted `detect` and `install` outputs (its `install` returns a real server value for an in-process TLS test server), and a temp home:
  - `over SSH with Docker, the default path ends synced`.
  - `without Docker it uses a service and says so`.
  - `Tailscale is offered only when detected`.
  - `a domain that doesn't resolve to the host asks before going on`.
  - `the manual route prints a command and takes the pasted value`.
  - `an existing server by URL or value`.
  - `a rerun resumes an unfinished install` (the second run sends `install` with the same install ID).
  - `a host with someone else's server is left alone` (no `install` call, return 1).
  - `a failed install leaves the record unfinished and says to rerun`.
  - `sync already on says so`.
  - `the token is never printed`.
- [ ] **Step 2: Run** `bun test packages/cli/test/sync-wizard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `wizard.ts` and the `setup` hook.
- [ ] **Step 4: Run** `bun test packages/cli` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(sync): set up a server and this device in one guided command`.

### Task 9: `ks sync server`

**Files:**
- Create: `packages/cli/src/commands/sync-server.ts`
- Modify: `packages/cli/src/commands/sync.ts` (dispatch `server`; `USAGE`)
- Test: `packages/cli/test/sync-server.test.ts`

**Interfaces:**
- Consumes: the install record, `sshHost`/`localHost`, `manualCommand`, the sync client, `GET /v1/health`.
- Produces: `syncServerCommand(args: string[], deps: SyncDeps & { hostFor?: …; health?: (url: string) => Promise<{ version: string } | null> }): Promise<number>`.

Behaviour to implement (spec §9):
- **`ks sync server`** prints the server's addresses, whether it answers, its version from `/v1/health` (through the pinned client when pinned), and, with a record, `Installed  <route>, <runtime>, <reach>, on <host>`. Without a record, it prints `` Managed from another device. To manage it from here: ${cliName()} sync server manage <ssh-host> ``.
- **`update`** runs `update --version <cli version>` over the recorded route, or prints `manualCommand` for a manual install. It refuses without a record.
- **`address <url>`** keeps the pin and saves the new address first in `servers` only when that server answers with the pinned key and lists this device (a signed `devices()` call). Otherwise it changes nothing and says why.
- **`manage <ssh-host>`** runs `info` over SSH, checks that the host's pin (or, unpinned, one of its addresses) matches this vault's config and that `devices()` succeeds through it, then saves a finished record with route `ssh`.
- **`stop`** runs `stop` over the recorded route.
- **`remove`** asks `Remove the server from <host>?`. It then asks separately `Also delete its database? Every device keeps its secrets, but syncing stops.`, with the default No, and runs `remove [--delete-data]`. Afterwards it deletes the record.
- Each command without a terminal, where it would ask, fails with a usage line. The `USAGE` lines list all six.

- [ ] **Step 1: Write the failing tests,** with a fake `Host` and a temp home: one test per subcommand, plus `manual installs print the line to run`, `address refuses a server that doesn't know this vault`, `manage refuses a host whose pin doesn't match`, and `remove keeps the database by default`.
- [ ] **Step 2: Run** `bun test packages/cli/test/sync-server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the behaviour above.
- [ ] **Step 4: Run** `bun test packages/cli` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(sync): ks sync server shows, updates, moves, stops and removes the server`.

### Task 10: Updates, doctor, uninstall and sync off

**Files:**
- Modify: `packages/cli/src/commands/update.ts`, `packages/cli/src/doctor/checks.ts`, `packages/cli/src/commands/doctor.ts`, `packages/cli/src/commands/uninstall.ts`, `packages/cli/src/commands/sync.ts` (`off`)
- Test: `packages/cli/test/update-command.test.ts`, `packages/cli/test/doctor-checks.test.ts`, `packages/cli/test/uninstall.test.ts`, `packages/cli/test/sync.test.ts`

Behaviour to implement:
- **After `kerstel update` installs a new CLI,** with an install record and a server whose `/v1/health` version is older:
  - It says `` The sync server on <host> runs <old>; this Kerstel is <new>. ``.
  - On a terminal, it asks `Update the server now?` (default Yes) and runs `ks sync server update`. Without a terminal, it says to run that.
- **`doctor`'s Sync row** warns `the server runs <old>, older than this Kerstel` with the fix `<cli> sync server update`, when a record exists and the server is behind.
- **`uninstall`** on a device with a record asks `Also remove the sync server on <host>? Other devices may still use it.` (default No). Yes runs `sync server remove`, keeping the database. No prints `` The server keeps running. To manage it from another device: ${cliName()} sync server manage <host> ``. `--dry-run` only lists it.
- **`ks sync off`** on a device with a record prints the same `manage` line, and keeps the record.

- [ ] **Step 1: Write the failing tests** for each behaviour, with fakes for health and the host.
- [ ] **Step 2: Run** the four test files. Expected: FAIL.
- [ ] **Step 3: Implement** the behaviour above.
- [ ] **Step 4: Run** `bun run test` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(sync): keep the server current from kerstel update, doctor and uninstall`.

### Task 11: The SSH end-to-end test in CI

**Files:**
- Create: `packages/cli/test/sync-wizard-ssh.test.ts`
- Modify: `.github/workflows/ci.yml` (a `wizard-ssh` job on `ubuntu-latest`)

Behaviour to implement:
- The job:
  - Builds the CLI and the server for the checkout's version.
  - Builds the server image as in `release.yml` and tags it `ghcr.io/alilibx/kerstel-server:<version>` locally.
  - Lays out a release mirror under a temp dir (`releases/download/v<version>/` holding `kerstel-server-linux-x64`, `kerstel-server.sh` and `SHA256SUMS`), served on `127.0.0.1` with `python3 -m http.server`.
  - Starts `sshd` on `127.0.0.1:2222` with a fresh host key and an authorized key for the runner user, and writes an `ssh` config that names it `kerstel-test`.
  - Runs the test with `KERSTEL_TEST_SSH_HOST=kerstel-test`, `KERSTEL_TEST_SSH_CONFIG=<file>` and `KERSTEL_RELEASES_URL=http://127.0.0.1:<port>`.
- The test:
  - Is `test.skipIf(!process.env.KERSTEL_TEST_SSH_HOST)`.
  - Drives `runWizard` with a scripted prompter for Docker + `self`, then for service + `self`. Each run checks that the server answers over HTTPS with the pinned key and that this device synced.
  - Reruns the wizard to check that it resumes, and that no second container or unit appears.
  - Checks the argv of every process on the host (`ps -eo args` sampled during the install) never contains the token.
  - Runs `ks sync server remove` with `--delete-data` at the end, and removes the container, unit, volume and temp homes.
- [ ] **Step 1: Write** the test and the job.
- [ ] **Step 2: Run** the test locally. Expected: SKIP. Run `actionlint` on the workflow if available.
- [ ] **Step 3: Commit** with the message `test(sync): run the setup wizard over ssh in CI`.

### Task 12: Copy, specs, changelog and roadmap

**Files:**
- Modify: `apps/website/src/pages/docs/sync.md` (lead with `ks sync setup`)
- Modify: `apps/website/src/pages/docs/cli.md` (`sync setup`, `sync server …`, `update`, `doctor`, `uninstall`)
- Modify: `README.md`, `packages/server/README.md` (`value`, `info`, the token file, the installer)
- Modify: `docs/superpowers/specs/2026-11-08-sync-between-devices-design.md` §7.1, §9.1, §10
- Modify: `CHANGELOG.md`, `ROADMAP.md` (tick #106)
- Regenerate: `docs/`

- [ ] **Step 1: Rewrite the top of `sync.md`:** `kerstel sync setup` and what it asks, the three routes, then adding devices. The manual `docker run` and binary instructions move under "Run a server yourself". Nothing says to run `kerstel sync` regularly.
- [ ] **Step 2: Update `cli.md`, both READMEs and the sync spec** to match the source, command by command and message by message.
- [ ] **Step 3: Add `CHANGELOG.md` lines** under Added:
  - ```kerstel sync setup` with no arguments sets up a sync server and this device step by step. It installs `kerstel-server` over SSH with your own SSH setup, gives you one command to run on the server yourself, or installs it on this machine, with Docker or as a service, and picks how your devices reach it. See [Sync](https://kerstel.dev/docs/sync).``
  - ```kerstel sync server` shows the server this device set up, and `update`, `address`, `manage`, `stop` and `remove` look after it. `kerstel update` offers to update an older server, and `doctor` warns about one.``
  - ``A device can hold several addresses for its server, such as a home box's `.local` name and its IP address, and uses the first that answers.``
  - ``kerstel-server creates its enroll token file when it doesn't exist, and `kerstel-server value` prints a server value for `kerstel sync setup --server-value -`.``
- [ ] **Step 4: Tick the #106 line** in `ROADMAP.md`.
- [ ] **Step 5: Run** `bun run --cwd apps/website build`, `bun run test` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** with the message `docs(sync): lead with the setup wizard`.
