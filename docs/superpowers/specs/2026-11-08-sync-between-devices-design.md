# Sync between your devices

- **Status:** draft for review, 2026-11-08
- **Release:** 0.3.0, after 0.2.0 and before access gating (Next)
- **Issues:** [#18](https://github.com/alilibx/kerstel/issues/18) sync, [#81](https://github.com/alilibx/kerstel/issues/81) the server, [#82](https://github.com/alilibx/kerstel/issues/82) devices
- **Builds on:** the product spec (`2026-09-17-kerstel-secrets-manager-design.md`, §3 threat model, §5 vault, §7 daemon)
- **Later work it must not block:** shared vaults (#20), proof of presence (#16), binding the data key to the Secure Enclave or TPM (#54)

## 1. Problem

A Kerstel vault lives on one machine. A developer with a laptop and a desktop has to set every secret twice, and a fresh machine starts empty: after `git clone`, `kerstel init` lists each key the vault lacks and asks for its value. The values then travel the way Kerstel exists to stop, through notes, chat, or a password manager's clipboard.

Sync keeps one vault on all of a user's devices. A value set on the laptop resolves on the desktop, and a clone on a new machine runs as soon as the machine is paired.

## 2. Goals and non-goals

**Goals**

- **Opt-in.** Nothing leaves the machine until the user runs `kerstel sync setup`. A vault that never syncs behaves exactly as it does in 0.2.0.
- **End-to-end encrypted.** The server stores ciphertext and the smallest amount of metadata that sync needs (§4). It never sees a scope name, a key name, a value, a project path, or a hostname.
- **Self-hostable.** The server is a separate binary and a Docker image, with SQLite storage and no other services.
- **Offline-first.** Every command works with the server unreachable. Sync failures never fail `run`, `exec`, `resolve`, or the hook.
- **No accounts.** A device proves who it is with a signing key, not an email and password.
- **Never lose a value silently.** A conflicting edit is asked about, and the value that loses goes into the encrypted backup, as with `init` and `ks move`.

**Non-goals for 0.3.0**

- Sharing with other people. That is shared vaults (#20). The record format (§6) leaves room for it.
- A hosted server run by the Kerstel project. See §13.
- Syncing anything other than secrets (§5.3).
- Real-time push. Devices pull when Kerstel runs (§8).

## 3. Placement: why 0.3.0, before access gating

Sync does not need access gating, and gating does not need sync:

- The server holds only ciphertext, so the daemon's approval gate is not part of the server's protection.
- Pairing a device needs a confirmation on a device the user already has (§7.1). That works without #16. Once #16 ships, the confirmation also asks for Touch ID or polkit.
- §5.1 keeps the local data key out of sync. Each device keeps its own data key, so #54 can later bind that key to the Secure Enclave or TPM without changing the sync protocol.

Shipping sync first also gives the Next release's audit log (#11) a clear rule: audit rows are local to the device and never sync (§5.3).

The alternative was to keep sync in Later with shared vaults. It moved because single-user sync is a large, self-contained piece of work that users ask for on its own. Shared vaults build on it.

## 4. What the server can and cannot see

| The server sees | The server never sees |
|---|---|
| A random vault ID | Scope names, key names, values |
| Each device's random ID and public keys | Device names and hostnames (sealed, §7) |
| How many records a vault holds, their sizes, and when they change | Project paths, `.env` contents, backups |
| Opaque record IDs, stable for one key epoch (§6.1), and which of them are deletions | Which record is which key |
| The IP address of each request | The sync key or any data key |

**What a hostile server can do,** and what stops it:

| Attack | Result |
|---|---|
| Read or change a record | Fails. Records are AES-256-GCM with the vault ID, record ID and epoch as associated data (§6.2). A changed or moved blob fails to decrypt and is reported. |
| Swap two records' blobs | Fails, for the same reason. This is why §6.2 binds the record ID, unlike the local vault, which seals values without associated data. |
| Add a device of its own | Fails. Adding a device takes a signature from an existing device, and the sync key is sealed only to devices a user confirmed (§7.1). |
| List a key of its own for a device, so a key rotation seals the new sync key to the server | Fails. A device's name is sealed with the sync key together with the public keys it was added with, and a rotation seals the new key only to a device whose listed keys match its sealed name. The server holds no sync key, so it can neither change a name nor make one for a device it invents. `ks sync devices` marks a device whose keys don't match. |
| Serve an old copy of the vault (rollback) | Partly detected. Each device stores the highest vault revision it has seen and refuses a lower one. The server assigns revisions, though, and nothing in a payload binds one, so it can resend an older blob for a record under a new, higher revision. That blob still decrypts and replaces a clean local value, with the old one kept in the sync backup (§8.5). Signed device logs would close this; they are later work. |
| Withhold changes from one device, or show two devices different histories | Not prevented. Sync stops making progress, and `doctor` shows when each device last synced. A fix needs signed device logs; it is later work. |
| Delete the vault | Possible. Every device still has its full local vault, so nothing is lost. `kerstel sync setup` can upload it again to a new server. |

## 5. Keys and what syncs

### 5.1 Keys

| Key | Where it lives | What it does |
|---|---|---|
| **Data key** (exists today) | OS credential store, one per device | Encrypts `vault.db` on that device. Never synced. A device's data key can differ from every other device's. |
| **Sync key** (new, 256-bit, one per epoch) | `vault_meta`, sealed with the data key | Encrypts records on the server. Every device in the vault has it. Replaced on each device removal (§7.3). |
| **Device encryption key** (new, X25519) | `vault_meta`, private half sealed with the data key | Receives the sync key, sealed to it by another device. |
| **Device signing key** (new, Ed25519) | `vault_meta`, private half sealed with the data key | Signs every request to the server, and signs new devices into the vault. |

All four use `node:crypto`. Bun 1.4.2 supports X25519, Ed25519, HKDF and AES-256-GCM, so the binary takes no new dependency.

### 5.2 Sealing the sync key to a device

`seal(syncKey, devicePublicKey)`: generate an ephemeral X25519 key, compute the shared secret with the device's public key, derive a 256-bit key with HKDF-SHA256 (info `kerstel sync-key v1`, salt = the vault ID), and encrypt the sync key with AES-256-GCM. The associated data is the vault ID, the device ID and the epoch. The server stores one sealed copy per device per epoch.

### 5.3 What syncs and what stays local

| Syncs | Stays on the device |
|---|---|
| Every secret, in every scope, including `global` | `projects` rows: checkout paths are machine-specific |
| Deletions, as tombstones | `audit_log` |
| | Backups in `~/.kerstel/backups/`, which hold original plaintext files |
| | `vault_meta` rows such as `keychain_backend` |

Excluding a scope from sync is an open question (§13).

## 6. Records

### 6.1 Record IDs

A record ID is `HMAC-SHA256(idKey, scope || 0x00 || key)`, truncated to 16 bytes and encoded as base64url. `idKey` is derived from the epoch's sync key with HKDF (info `kerstel record-id v1`). The ID is stable for one key, so the server can do compare-and-swap on it, and it reveals nothing about the name. A new epoch gives every record a new ID.

### 6.2 The encrypted payload

```json
{ "v": 1, "scope": "myapp", "key": "STRIPE_SECRET_KEY", "value": "…",
  "deleted": false, "updatedAt": 1762560000000, "device": "<device id>" }
```

The JSON is padded to a multiple of 256 bytes, so the server cannot tell a short value from a long one within that bucket. It is encrypted with AES-256-GCM under the epoch's sync key, with a random 96-bit nonce. The associated data is `vaultId || recordId || epoch`.

A deletion is pushed as a record with no blob (a tombstone), so the server can drop it later. The server learns that some record was deleted, not which key. It drops tombstones after 90 days and raises the vault's pruned revision to the newest one it dropped. A device whose cursor is below that revision gets `full_pull_required` and pulls the whole vault with `full=1` (§8.3).

The `deleted` field stays in the payload format for a later case: a deletion that must carry data, such as which device made it.

### 6.3 Local sync state

Schema 4 adds one table and no columns to `secrets`, so a vault that never syncs is unchanged:

```sql
CREATE TABLE sync_state (
  scope      TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  base_rev   INTEGER NOT NULL,      -- server revision this copy is based on, 0 if never pushed
  dirty      INTEGER NOT NULL,      -- 1 when changed here and not yet accepted by the server
  change     INTEGER NOT NULL,      -- local write counter, raised by every set or remove of this key
  conflict   BLOB,                  -- the other device's sealed payload while a conflict is open
  PRIMARY KEY (scope, key)
);
```

`setSecret` and `removeSecret` mark the row dirty and raise `change` in the same transaction as the write. Vault-level state (vault ID, server URL, device IDs, highest revision seen, last sync time and result) goes in `vault_meta`.

## 7. Devices

### 7.1 Setting up and pairing

**First device:**

```
$ ks sync setup https://sync.example.com
Kerstel sync, end-to-end encrypted. The server stores ciphertext only.
  Vault        new, 214 secrets in 6 scopes
  This device  ali-mbp (the name is sealed; the server never sees it)
Upload the vault? (Y/n)
✓ Synced 214 secrets. Add another device with: ks sync add-device
```

`setup` creates the vault ID, the device keys and the first sync key, registers with the server, and pushes every secret. A server started with an enroll token gets it from `KERSTEL_SYNC_ENROLL_TOKEN`. Without a terminal, `setup` needs `--yes` to upload. A server URL must be `https://`, except for `127.0.0.1` and `localhost`, the same rule as `KERSTEL_RELEASES_URL`.

**Adding a device.** On a device that is already in the vault:

```
$ ks sync add-device
On the new device, run:

  ks sync join https://sync.example.com KS-7Q2M-XR4P-9DKT-BW3H-6YFN-CJ8A

The code works once and expires in 10 minutes. Waiting for the new device…
```

`add-device` first opens a pairing slot on the server under a fresh pairing ID. The slot lasts 10 minutes, and a vault can have at most three open.

On the new device, `ks sync join <url> <code>` creates its device keys and posts its public keys, name and platform to that slot. The server accepts one answer per slot, so a second device cannot replace the first one's keys. The code is a 120-bit secret in 24 base32 characters, which the server never sees. The pairing ID, which it does see, is derived from the secret with HKDF (info `kerstel pairing-id v1`), so the code needs nothing else. The answer is sealed with AES-256-GCM under a key derived from the secret (info `kerstel pairing v1`, the pairing ID as associated data) and padded like a record: the server cannot read the name, and the first device refuses an answer that does not open, so one the server wrote itself is caught before anyone is asked. Both devices show the new device's key fingerprint, so the person pairing can compare them.

Back on the first device:

```
New device: ali-desktop (Linux), key fingerprint 4F2A 91C0 7B3E
Add it? It will be able to read every secret in this vault. (y/N)
```

On yes, the first device checks the HMAC, seals the sync key to the new device, and registers the new device's signing key with the server, signed by itself and naming the pairing slot. The server marks the slot accepted. On no, the first device deletes the slot, and the new device's poll gets 404. The first device polls every 2 seconds and the new device every 3, which keeps the new device's unauthenticated polls under the server's limit of 30 a minute per address. The default answer is no, and `--yes` is refused for this question.

The new device must also know that the sealed key came from the first device and not the server, which can seal a key of its own choosing to any public key. So with the registration, the first device stores a confirmation on the pairing slot: `HMAC(pairingSecret, "kerstel pairing-confirm v1" ‖ vaultId ‖ newDeviceId ‖ epoch ‖ sealedKey)`. The new device, polling the slot, gets the vault ID and the confirmation once the slot is accepted. It fetches its sealed key, checks the confirmation against it, and refuses to join if it doesn't match. Only then does it pull the vault, and only then does it merge and push any secrets it already held (§10). Without this check, a hostile server could hand a joining device a key it chose and an empty vault, and read the secrets the device uploads.

The secret is long because the server could otherwise guess it offline from the pairing post. A short code would need a PAKE such as SPAKE2, which `node:crypto` does not provide. See §13.

### 7.2 Listing devices

`ks sync devices` lists each device's name, platform, fingerprint, when it was added, and when it last synced. Names are decrypted locally.

### 7.3 Removing a device

`ks sync remove-device <name>`:

1. Pulls first, so names sealed under a key another device rotated to can be read. Generates a new sync key (a new epoch), seals it to every remaining device, and seals every remaining device's name again under it: names are sealed with the sync key, so a device paired after the rotation could not read the old ones. A name holds the device's public keys too, and the new key is sealed only to keys that match their device's sealed name; if any listed device fails that check, the rotation stops and changes nothing.
2. Pulls, then re-encrypts every record under the new epoch and uploads them with the sealed keys and the removal, as one atomic request. The request names the vault revision it was prepared from. The server rejects it if the vault has moved past that revision, because another device pushed in the meantime and its change would be lost. The client then pulls and prepares the rotation again. Otherwise the server switches the vault to the new epoch in a single transaction and drops the removed device's signing key.
3. Prints a reminder: the removed device already had every value, so rotate any secret it should no longer hold. Kerstel cannot do that for the user.

`kerstel uninstall` on a synced device removes that device from the vault first. If it is the last device, it asks whether to delete the vault on the server too. The default is no.

## 8. Sync

### 8.1 When it runs

- `ks sync` runs a pull and then a push in the foreground, and reports what changed.
- After any command that writes the vault (`set`, `rm`, `init`, `move`, `ui`) and leaves changes to push, Kerstel starts a detached `kerstel sync --background`: a pull and a push, in its own session so closing the terminal does not end it.
- `run` and `exec` start the same background sync when no sync has finished, successfully or not, in the last five minutes. Counting failures too keeps an unreachable server from costing a process on every run. It also pushes whatever an earlier offline write left pending. The command never waits for it, so a value pulled after the app starts reaches the next run.
- A background sync prints nothing. It records its result in `vault_meta` for `ks sync status` and `doctor`, and keeps a conflict open rather than choosing (§8.4).
- Its environment is the daemon's allowlist plus proxy and CA settings (`HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` and the like). Like the daemon, it never inherits `BUN_OPTIONS`, `NODE_OPTIONS`, or values an outer `exec` resolved.
- One lock file, `~/.kerstel/sync.lock`, beside the vault, keeps syncs from overlapping. The lock is an exclusive SQLite transaction on that file, so the operating system holds it and frees it when the process ends, however it ends; nothing ever judges a lock stale and takes it over. A background sync that finds it held waits up to two minutes, because the holder may have collected its changes before the write that started this one. Once it has the lock, it exits if a sync finished after it started and left nothing to push. Pairing (`add-device`, `join`) can hold the lock for longer than that, so when it finishes it starts a background sync of its own if changes wait to be pushed. A sync you start waits up to 30 seconds. Every request times out after 60 seconds, so no sync holds the lock for long.

The daemon does not sync and opens no network connection. It reads `vault.db` on each resolve, but a running app keeps the values it already has: the hook caches each resolved value for the life of the process, and under Bun it writes every value into `Bun.env` at startup. A pulled value reaches an app when the app restarts, or when it reads a key it hasn't read yet. This keeps network code out of the process that holds the data key for every running app.

### 8.2 Push

For each dirty row, the client sends `(recordId, baseRev, sealedPayload)`. The server accepts a record when its current revision equals `baseRev`, or when `baseRev` is 0 and the record is new. Each accepted record gets the vault's next revision number. The client stores the new `base_rev`, and clears `dirty` only if `change` still equals the value it read when it built the push. That check and the write happen in one statement. If the key changed while the request was in flight, the row stays dirty, now based on the new revision, and the next push sends the newer value.

### 8.3 Pull

The client asks for every record with a revision higher than the highest it has seen. For each record:

| Local row | Action |
|---|---|
| Any, when the record's revision is at or below the local copy's base revision | Nothing: it is this device's own push coming back, or a record already seen. |
| Clean, or missing | Apply the remote value or deletion. A local value that a remote deletion or change replaces is saved in a sync backup first (§8.5). |
| Dirty, same value as remote | Adopt the remote revision and clear `dirty`. |
| Dirty, different value | A conflict (§8.4). |

A device whose last pull is older than the tombstone window pulls the whole vault and reconciles row by row, using the same table. A key the server held for a local copy and no longer holds at all was deleted elsewhere: a clean copy follows the deletion, and a copy changed here, or already in conflict, becomes a conflict with that deletion, so the user chooses whether the key stays. The server's copy returned for a stale push is handled the same way, whatever its revision.

After a rotation on another device, a pull sees the new epoch, fetches its sealed copy of the new key, and does a full pull. Base revisions are kept: the server gives the re-uploaded records revisions above every earlier one, and the old base revision is what marks a key that existed before the rotation, so a deletion made just before it is still applied. Open conflicts are sealed again under the new key. The new key, the epoch and a full-pull flag are written in one transaction, and the flag is cleared only when the full pull finishes, so a crash in between is finished on the next sync.

### 8.4 Conflicts

A background sync never chooses between two values. It keeps this device's value, stores the other device's payload in `sync_state.conflict`, and stops pushing that key. Every command then prints one line on stderr:

```
kerstel: 1 sync conflict. Run `ks sync` to choose which value stays.
```

`ks sync` in a terminal asks for each conflict, naming the other device and the time of its change. Neither value is printed; each is shown as its length, and `--reveal` shows both:

```
STRIPE_SECRET_KEY (myapp) was changed on two devices.
  ● This device   changed 2 Nov, 14:03   (107 characters)
  ○ ali-desktop   changed 2 Nov, 14:10   (107 characters)
Which value stays?
```

The value that loses is saved in the sync backup. Without a terminal, `ks sync` lists the conflicts and exits 1. `ks sync --keep local|remote` settles them in scripts.

### 8.5 The sync backup

A value that a pull replaces or deletes, and the losing side of a conflict, go to `~/.kerstel/backups/_sync/<timestamp>/` (a leading `_` is never a scope name, so it cannot share a folder with a project's backups), encrypted with the data key in the same format as `init` backups. `uninstall`'s loss check reads these backups too, so it names any value that exists only there before deleting it.

## 9. The server

### 9.1 Shape

- A new package, `packages/server`, compiled with `bun build --compile` to `kerstel-server`. It is a separate binary, so the CLI that runs on developer machines still contains no listening code.
- Released alongside the CLI, from the same tag and with the same version: binaries for Linux and macOS (x64 and arm64) in the GitHub Release, checked by the same `SHA256SUMS`, plus a `linux/amd64` and `linux/arm64` image at `ghcr.io/alilibx/kerstel-server`, tagged with the version (`0.3.0`), the minor version (`0.3`) and `latest`. A pre-release tag pushes only its own image tag.
- Storage is one SQLite file, mode `0600`. Settings: `--db` (`KERSTEL_SERVER_DB`), `--listen` (`KERSTEL_SERVER_LISTEN`, default `127.0.0.1:8787`), `--trust-proxy` to rate limit by `X-Forwarded-For`, and an optional enroll token that `sync setup` must present to create a vault. The token comes from `--enroll-token-file` or `KERSTEL_SERVER_ENROLL_TOKEN`, never from a command-line value, where `ps` would show it. Without a token, anyone who can reach the server can create a vault. That is fine on a private network and documented as unsafe on a public one, and the server says so on start.
- The binary is compiled with `--no-compile-autoload-dotenv`, so a `.env` in its working directory cannot change its settings.
- The log has one line per request: method, the route as a fixed label with every ID as `:id` (`(unknown)` for a path the server does not answer, so no text a caller puts in a path is logged), status and duration. No IDs, addresses or bodies.
- Before 0.3.0, the server was published only on a nightly channel (a rolling `nightly` pre-release and `ghcr.io/alilibx/kerstel-server:nightly`). The 0.3.0 release PR moved it into `release.yml` and deleted the nightly workflow.
- The image is `distroless/base` with no shell. It runs as a non-root user, keeps its database in the `/data` volume, and listens on `0.0.0.0:8787` inside the container.
- TLS is left to a reverse proxy (Caddy, nginx, or a platform's load balancer). The docs give a Caddy example.

### 9.2 API

JSON over HTTPS, versioned under `/v1`. Every request to `/v1/vaults/...` carries `Kerstel-Device`, `Kerstel-Timestamp` and `Kerstel-Signature`, an Ed25519 signature over the method, the path with its query string, the timestamp and the SHA-256 of the body. The server rejects a timestamp more than five minutes off and a repeated signature. A signature must be in canonical base64url, since 64 bytes leave unused bits in the last character and a re-encoded spelling would otherwise pass as new. It is spent only once the request passes the rate limit, so a refused request writes nothing. An unknown vault and an unknown device both answer 401, so IDs cannot be probed. Creating a vault is signed by the key it registers, which proves the caller holds it. The wire types live in `packages/server/src/protocol.ts`, which the client imports. The client never follows a redirect: it would carry the enroll token and a signed request to wherever it points.

| Method and path | Purpose |
|---|---|
| `POST /v1/vaults` | Create a vault with its first device and sealed sync key |
| `GET /v1/health` | Version and protocol, unauthenticated |
| `GET /v1/vaults/:id/records?since=<rev>[&full=1][&limit=<n>]` | Records newer than a revision, 500 a page by default, with `more` when another page follows. `full=1` marks a full pull, which skips the `full_pull_required` check. |
| `POST /v1/vaults/:id/records` | Push a batch with compare-and-swap. Returns accepted revisions and conflicts. |
| `GET /v1/vaults/:id/keys` | This device's sealed sync key for the current epoch |
| `GET /v1/vaults/:id/devices` | Devices, with sealed names |
| `POST /v1/vaults/:id/devices` | Add a device (signed by an existing device), naming the pairing slot it answered and carrying the pairing confirmation of §7.1 |
| `DELETE /v1/vaults/:id/devices/:deviceId` | A device removes itself (`ks sync off`). Not the last one, and never another device, which needs a rotation. |
| `POST /v1/vaults/:id/epochs` | Rotate: new sealed keys, re-encrypted records, re-sealed device names, removed device, in one transaction. Rejected if the vault has moved past the revision the request names. |
| `POST /v1/vaults/:id/pairings` | Open a pairing slot for 10 minutes |
| `GET` and `DELETE /v1/vaults/:id/pairings/:pairingId` | Read the new device's answer, or decline it |
| `PUT /v1/pairings/:pairingId` | The new device answers, once. Unauthenticated. |
| `GET /v1/pairings/:pairingId` | The new device polls: `waiting`, or `accepted` with the vault ID and the pairing confirmation. Unauthenticated. |
| `DELETE /v1/vaults/:id` | Delete the vault, signed by a device in it |

Limits: 10,000 records, 64 KB per record and 8 MB in total per vault; 32 devices per vault; 12 MB per request, so a rotation can re-upload a full vault; 60 requests a minute per device; 10 new vaults an hour and 30 pairing requests a minute per address. A push or rotation that would break a limit changes nothing.

## 10. Commands

| Command | Does |
|---|---|
| `ks sync setup <url>` | Turn sync on for this vault and upload it |
| `ks sync add-device` | Show a one-time code and confirm the new device |
| `ks sync join <url> <code>` | Join a synced vault from a new device |
| `ks sync` | Pull, push, and settle conflicts |
| `ks sync status` | Server, devices, last sync, pending changes, open conflicts |
| `ks sync devices` | List devices |
| `ks sync remove-device <name>` | Remove a device and rotate the sync key |
| `ks sync off` | Stop syncing this device (removes it from the vault) |

**`join` on a device whose vault already holds secrets.** The two vaults merge. Keys only one side has are added. A key both sides hold with different values is a conflict (§8.4). Nothing is overwritten without asking.

`kerstel doctor` gains a Sync row: off; or the server, last successful sync, pending pushes, open conflicts, and a warning when the last sync is more than seven days old.

## 11. Effects on existing copy

When 0.3.0 ships, the following change in the same PR:

- The product spec §2 and the README: "offline apart from the update check" becomes "offline apart from the update check, and sync if you turn it on".
- The website security page gains a "Sync" section with the table in §4.
- `docs/teams.md` stops saying Kerstel has no sync. It explains that sync is for one person's devices, and that teams still use the workflow on that page until shared vaults ship.
- A new docs page, "Sync", covers setup, pairing, conflicts, and self-hosting the server.

## 12. Testing

- Crypto: sealing round trips; a changed or moved blob fails to decrypt; a record ID is stable within an epoch and changes across epochs.
- Server: compare-and-swap, epoch rotation in one transaction, signature and timestamp checks, replay rejection, limits, and an expired or reused pairing slot.
- Client against an in-process server: setup, join, push, pull, every row of the §8.3 table, conflicts in a terminal and without one, removal and rotation, a rotation rejected because another device pushed first, a key changed while its push is in flight, a join refused when the pairing confirmation doesn't match the sealed key, a lower vault revision refused, and the full pull after the tombstone window.
- Offline: with the server unreachable, `set`, `run`, `exec`, `resolve` and the hook work and print no sync error, and `doctor` shows the failure.
- No test prints a value, and every temporary home and server database is removed.

## 13. Open questions

1. **A hosted server.** Should the project run one, such as `sync.kerstel.dev`? The protocol needs no accounts, so a hosted server would need abuse limits instead: a cap on vault creation per IP, quotas, and a privacy policy. Recommendation: ship self-hosting in 0.3.0 and decide on hosting separately. "No account, no cloud" stays true either way.
2. **Short pairing codes.** A PAKE would allow a code of 6–8 characters. It needs an implementation outside `node:crypto`. Recommendation: ship the long code and revisit if users find it awkward.
3. **Excluding scopes.** Should `ks sync setup` let a user leave a scope, such as a work project, off the server? It is simple to add to `sync_state` but changes the conflict and join rules.
4. **Windows.** The server needs no Windows build. The client follows the CLI's Windows work (#17).

Follow-up: 0.4.0 (easy sync) takes up the setup friction 0.3.0 left: automatic pulls (#105), a command that installs and starts `kerstel-server` (#106), HTTPS without a hand-configured proxy, which decides question 1 (#107), and pairing with one pasted value, which revisits question 2 (#108). Each change updates the section of this spec it touches.
