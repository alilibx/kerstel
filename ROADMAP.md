# Roadmap

What Kerstel ships, in order. A box is ticked only once the feature is merged to `main`. The [changelog](https://kerstel.dev/changelog) lists what each release contains once it's out. Each open item links to its GitHub issue, where you can follow progress, upvote, or offer to help.

## 0.1.0: first release

- [x] Encrypted local vault, with the data key in the OS credential store
- [x] `kerstel://` references, plus `set`, `get`, `ls`, and `rm`
- [x] `kerstel run` and `kerstel resolve`
- [x] Resolver daemon and runtime hook for Node and Bun
- [x] `kerstel doctor`
- [x] [kerstel.dev](https://kerstel.dev) with docs, changelog, and roadmap
- [x] Setup wizard: `kerstel init` and `kerstel exec`
- [x] Release binaries for macOS and Linux, with checksums
- [x] Working `install.sh`
- [x] `kerstel uninstall`, which restores plaintext `.env` files before removing Kerstel
- [x] `ks` shortcut, and a friendlier `init` and `doctor`

## 0.1.1: update in place

- [x] `kerstel update`, which installs the latest release over the running binary, with an update check in `--version` and `doctor`

## 0.1.3: scripts that survive deploy hosts

- [x] `Bun.env` returns the real value under the hook, not the literal reference ([#60](https://github.com/alilibx/kerstel/issues/60))
- [x] Wire every command of a compound script, after its leading `NAME=value` assignments, and report half-wired scripts in `doctor` ([#61](https://github.com/alilibx/kerstel/issues/61))
- [x] A committed launcher, `.kerstel/exec.cjs`, so wired scripts run unchanged on deploy hosts that have no Kerstel, plus a "Deploying" docs page ([#62](https://github.com/alilibx/kerstel/issues/62))

## 0.1.4: change your mind

- [x] `kerstel move`: move a key between the vault and plain text, or between this project and the shared scope, after `init` ([#71](https://github.com/alilibx/kerstel/issues/71))

## 0.1.5: one project, many checkouts

- [x] Track each checkout of a project separately, so two copies of one package (such as git worktrees) both work and both restore on `uninstall` ([#13](https://github.com/alilibx/kerstel/issues/13))

## 0.2.0: terminal UI and monorepos

- [x] `kerstel ui`: a full-screen view of the vault in the terminal, with no network listener ([#8](https://github.com/alilibx/kerstel/issues/8))
- [x] Manage global and project secrets in the UI, with masked values and audited reveal ([#9](https://github.com/alilibx/kerstel/issues/9))
- [x] See which project files reference which keys, in the UI and with `kerstel refs` ([#10](https://github.com/alilibx/kerstel/issues/10))
- [x] `kerstel init` at a monorepo root sets up every package with `.env` files in one run ([#34](https://github.com/alilibx/kerstel/issues/34))
- [x] Shorter references: `KEY=ks:<scope>` when the variable and the vault key share a name, `ks:<scope>/<KEY>` otherwise, with `kerstel://` still accepted ([#36](https://github.com/alilibx/kerstel/issues/36))
- [x] `kerstel scan`: find and classify every env file in a folder, a monorepo, or the whole machine, without printing a value ([#52](https://github.com/alilibx/kerstel/issues/52))

## 0.3.0: sync between your devices

- [x] Optional end-to-end encrypted sync of the vault between your own devices with `ks sync`, with keys that stay on your devices and conflicts asked about, never overwritten ([#18](https://github.com/alilibx/kerstel/issues/18))
- [x] `kerstel-server`: a self-hostable sync server, as a binary and a Docker image, that stores only ciphertext ([#81](https://github.com/alilibx/kerstel/issues/81))
- [x] Pair a new device with a one-time code confirmed on a device you already have, and remove a device, which replaces the sync key ([#82](https://github.com/alilibx/kerstel/issues/82))

## 0.4.0: easy sync

- [ ] Pull changes automatically, so `ks sync` is needed only to settle a conflict ([#105](https://github.com/alilibx/kerstel/issues/105))
- [ ] `ks sync server`: install and start `kerstel-server` with one command, with Docker or without it ([#106](https://github.com/alilibx/kerstel/issues/106))
- [ ] Put a sync server on HTTPS without configuring a reverse proxy by hand ([#107](https://github.com/alilibx/kerstel/issues/107))
- [ ] Pair a device by pasting one value instead of a URL and a code ([#108](https://github.com/alilibx/kerstel/issues/108))

## Next: access gating

- [x] Audit log of every resolve, run, reveal, set, and remove, with `kerstel audit` and an Audit screen in the UI ([#11](https://github.com/alilibx/kerstel/issues/11))
- [ ] Approval prompt the first time an unknown process asks for a key ([#14](https://github.com/alilibx/kerstel/issues/14))
- [ ] Allowlists ([#15](https://github.com/alilibx/kerstel/issues/15))
- [ ] Proof of user presence for sensitive actions: Touch ID with a password fallback on macOS, polkit or a fingerprint on Linux, and reveals denied by default where no prompt is possible ([#16](https://github.com/alilibx/kerstel/issues/16))
- [ ] Bind the vault data key to user presence through the Secure Enclave on macOS and the TPM on Windows, so bypassing the daemon there yields nothing ([#54](https://github.com/alilibx/kerstel/issues/54))
- [ ] Lock and unlock the vault, once unlock can ask for proof of presence ([#12](https://github.com/alilibx/kerstel/issues/12))

## Later: teams, environments, and Windows

- [ ] Windows binaries and a PowerShell installer ([#17](https://github.com/alilibx/kerstel/issues/17))
- [ ] Environments (dev, staging, prod) ([#19](https://github.com/alilibx/kerstel/issues/19))
- [ ] Shared vaults ([#20](https://github.com/alilibx/kerstel/issues/20))
