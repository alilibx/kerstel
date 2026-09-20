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

## 0.2.0: local portal

- [ ] `kerstel ui`: a local web portal on `127.0.0.1`, opened with a one-time token ([#8](https://github.com/alilibx/kerstel/issues/8))
- [ ] Manage global and project secrets, with masked values and audited reveal ([#9](https://github.com/alilibx/kerstel/issues/9))
- [ ] See which projects reference which keys ([#10](https://github.com/alilibx/kerstel/issues/10))
- [ ] Audit log view ([#11](https://github.com/alilibx/kerstel/issues/11))
- [ ] Lock and unlock the vault ([#12](https://github.com/alilibx/kerstel/issues/12))
- [ ] Track each checkout of a project separately, so two copies of one package (such as git worktrees) both work and both restore on `uninstall` ([#13](https://github.com/alilibx/kerstel/issues/13))
- [ ] Shorter references: `KEY=ks:<scope>` when the variable and the vault key share a name, `ks:<scope>/<KEY>` otherwise, with `kerstel://` still accepted ([#36](https://github.com/alilibx/kerstel/issues/36))
- [ ] `kerstel scan`: find and classify every env file in a folder, a monorepo, or the whole machine, without printing a value ([#52](https://github.com/alilibx/kerstel/issues/52))

## Next: access gating

- [ ] Approval prompt the first time an unknown process asks for a key ([#14](https://github.com/alilibx/kerstel/issues/14))
- [ ] Allowlists ([#15](https://github.com/alilibx/kerstel/issues/15))
- [ ] Proof of user presence for sensitive actions: Touch ID with a password fallback on macOS, polkit or a fingerprint on Linux, and reveals denied by default where no prompt is possible ([#16](https://github.com/alilibx/kerstel/issues/16))
- [ ] Bind the vault data key to user presence through the Secure Enclave on macOS and the TPM on Windows, so bypassing the daemon there yields nothing ([#54](https://github.com/alilibx/kerstel/issues/54))

## Later: sync and teams

- [ ] Windows binaries and a PowerShell installer ([#17](https://github.com/alilibx/kerstel/issues/17))
- [ ] Optional end-to-end encrypted sync, with keys that stay on your devices ([#18](https://github.com/alilibx/kerstel/issues/18))
- [ ] Environments (dev, staging, prod) ([#19](https://github.com/alilibx/kerstel/issues/19))
- [ ] Shared vaults ([#20](https://github.com/alilibx/kerstel/issues/20))
