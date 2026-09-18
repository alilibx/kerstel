# Roadmap

What Kerstel ships, in order. A box is ticked only once the feature is merged to `main`. The [changelog](https://kerstel.dev/changelog) lists what each release contains once it's out.

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

## 0.2.0: local portal

- [ ] `kerstel ui`: a local web portal on `127.0.0.1`, opened with a one-time token
- [ ] Manage global and project secrets, with masked values and audited reveal
- [ ] See which projects reference which keys
- [ ] Audit log view
- [ ] Lock and unlock the vault

## Next: access gating

- [ ] Approval prompt the first time an unknown process asks for a key
- [ ] Allowlists
- [ ] Touch ID or polkit for sensitive actions

## Later: sync and teams

- [ ] Windows binaries and a PowerShell installer
- [ ] Optional end-to-end encrypted sync, with keys that stay on your devices
- [ ] Environments (dev, staging, prod)
- [ ] Shared vaults
