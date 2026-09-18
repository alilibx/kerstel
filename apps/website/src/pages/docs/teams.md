---
title: Working with a team
description: Commit references instead of values, and fill each teammate's local vault from the same file.
section: docs
order: 4
---
# Working with a team

<p class="lede">The committed <code>.env</code> is the contract. Each machine holds its own vault.</p>

## Commit the references

Once every value in `.env` is a reference, the file contains nothing sensitive. Commit it. It doubles as a living `.env.example` that can never drift from what the app reads, because it is what the app reads.

```bash
# .env, committed
DATABASE_URL=kerstel://myapp/DATABASE_URL
OPENAI_API_KEY=kerstel://global/OPENAI_API_KEY
STRIPE_SECRET_KEY=kerstel://myapp/STRIPE_SECRET_KEY
```

If `.env` is in `.gitignore`, remove it there only after every value is a reference. `git grep "=sk-"` and similar checks stay useful as a guard.

## Onboard a teammate

A new clone has the references but an empty vault for that project. The committed `.env` is already the list of what the project needs; each missing key is set once, piping the value on stdin so it never lands in shell history:

```bash
git clone git@github.com:acme/myapp.git && cd myapp
printf %s "$DATABASE_URL" | kerstel set myapp/DATABASE_URL
printf %s "$STRIPE_SECRET_KEY" | kerstel set myapp/STRIPE_SECRET_KEY
kerstel ls --scope myapp
kerstel run -- npm run dev
```

`kerstel ls --scope myapp` now shows what your vault already holds, which is a good way to confirm every key landed before you run the app. The vault stays on that machine. Kerstel has no sync, no shared account, and nothing to configure between teammates.

## Share values out of band

How the value reaches a teammate is up to you: a password manager share, a secure channel, or your cloud provider's console. Kerstel's job is that the value lands in a local vault and nowhere else in the repo.

## Rotate a secret

Rotation is a `set` on each machine:

```bash
printf %s "$NEW_KEY" | kerstel set myapp/STRIPE_SECRET_KEY
```

No project file changes, no commit, no redeploy of configuration. Restart the app so the hook's per-process memo refreshes.

## Coming later

The roadmap includes optional end-to-end encrypted sync and shared vaults, with keys that stay on your devices. Until then the workflow above needs nothing beyond git and the CLI.
