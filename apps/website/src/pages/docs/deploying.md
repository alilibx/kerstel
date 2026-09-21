---
title: Deploying
description: Deploy hosts do not need Kerstel. What the launcher does there, where the values come from, and the one mistake to avoid.
section: docs
order: 5
---
# Deploying

<p class="lede">Your deploy host never runs Kerstel. The scripts <code>init</code> wired still work there, and the values come from the host's own secret store.</p>

## What the launcher does on a host

`kerstel init` wires each command in your `package.json` scripts as `node .kerstel/exec.cjs -- <command>`, and writes that launcher into the repo for you to commit. The launcher looks for `kerstel` on `PATH`. On your machine it finds it and runs `kerstel exec`, so the runtime hook loads and references resolve from your vault. On Vercel, Netlify, Railway, Fly, Heroku, Google Cloud, Azure, DigitalOcean, a GitHub Actions job, or inside a Docker build, there is no `kerstel`, so it prints one line to stderr and runs the command exactly as written:

```
kerstel: not installed here, running without it: next build
```

That is the whole story. Do not install Kerstel on a host: it would create a vault there for nothing, and the host already has the values.

## Where the values come from

Set every key your app reads in the host's own environment settings: the project's environment variables on Vercel or Netlify, service variables on Railway, secrets on Fly, config vars on Heroku, build and runtime env on the others. The app reads `process.env` as it always did, and nothing on the host knows a vault ever existed.

Then decide what to do with `.env`:

- **Keep it out of git.** Most hosts read only their own settings, and a gitignored `.env` never reaches them. This is the safe default.
- **Or commit it, and set every key on the host.** Once every value is a reference, `.env` holds nothing sensitive and doubles as the list of keys the host needs. Check that first: `init` lets you leave a value in plaintext, and names every plaintext key it leaves behind, so a file with a plaintext secret in it is still a secret. Commit only when `init` reports no plaintext, or when what is left is meant to be public. The frameworks we checked (Next.js, Nuxt, the Vite-based ones, Expo, NestJS config) do not overwrite a variable the environment already sets when they load `.env`, so a key set on the host wins.

The mistake to avoid is a committed `.env` reaching a host where one key is **not** set. The framework loads the file, nothing overrides that line, and the app gets the literal reference:

```
Error: Publishable key not valid: kerstel://myapp/CLERK_PUBLISHABLE_KEY
```

If a value on a host looks like `kerstel://…`, that key is missing from the host's settings. Add it there; there is nothing to fix in the repo.

## What each host runs on its own

A host runs some scripts without being asked, which is why they are wired through the launcher rather than left alone. Overriding the build or start command in the host's settings changes nothing about Kerstel; the launcher steps aside either way.

| Host | Runs `build` | Runs `start` | Also looks for |
| --- | --- | --- | --- |
| Vercel | `vercel-build`, `now-build`, then `build` | never | |
| Netlify | `build`, or any script whose text contains the framework's build command | never | |
| Cloudflare Pages | via its framework presets | never | |
| Railway, Coolify | `build` when present | `start`, else `main`, else `index.js` | a `Procfile` |
| Fly.io | `build` when present | `start` when present | |
| Heroku, Dokku, DigitalOcean | `heroku-postbuild`, else `build` | `start` unless a `Procfile` says otherwise | `heroku-prebuild`, `heroku-cleanup` |
| Google Cloud Run, App Engine | the first of `apphosting:build`, the `GOOGLE_NODE_RUN_SCRIPTS` list, `gcp-build`, `build` | `start`, else `main`, else `index.js` | a `Procfile` |
| Azure App Service, Static Web Apps | `build`, then `build:azure` | `start`, else `main`, else `server.js` and friends | |
| AWS Amplify | `build` from its generated `amplify.yml` | never; runs `node <entrypoint>` | |
| AWS Elastic Beanstalk | none documented | `Procfile`, else `start`, else `app.js` | |
| Render | only what you type | only what you type | |
| GitHub Actions | only what the workflow runs | | |
| Expo EAS Build | neither | neither | the `eas-build-*` hooks |

Amplify reads the text of your `build` script to tell a static Next app from a server-rendered one. Whether it still recognises `next build` behind the launcher is unverified; if Amplify classifies your app wrongly after wiring, set the build settings by hand in `amplify.yml`.

Official Docker images mostly build through `npm run build`, where the launcher steps aside, and start with `node <file>`, which never touches a script:

| Framework | Build | Start |
| --- | --- | --- |
| Next.js (`output: 'standalone'`) | `npm run build` | `node server.js` |
| Nuxt | `npm run build` | `node .output/server/index.mjs` |
| SvelteKit (`adapter-node`) | `npm run build` | `node build` |
| Astro (`@astrojs/node`) | `npm run build` | `node ./dist/server/entry.mjs` |
| React Router | `npm run build` | `npm run start` |
| NestJS | `npm run build` | `node dist/main` |
| Bun | `bun run build` when present | `bun run index.ts` |

## Turborepo

Turborepo's strict environment mode, the default, hands a task only the variables it knows about. `NODE_OPTIONS` is on its built-in list, so the hook still loads, but the three variables the hook needs to reach the daemon are not. Add them once, at the root:

```json
{
  "globalPassThroughEnv": ["KERSTEL_SOCKET", "KERSTEL_TOKEN_FILE", "KERSTEL_HOOK_DIR"]
}
```

Without this, a task under `turbo run dev` on your machine loads the hook but the hook finds no socket to talk to, so it stands down and the app reads the literal `kerstel://` reference, the same failure as a key missing on a host. If that happens on your own machine in a Turborepo, this list is the fix, not the host's settings. Nx does no filtering and needs nothing.

## Bun

On your machine, under Bun, the hook resolves every reference in the environment when the process starts, so `Bun.env.KEY` and `process.env.KEY` both hold the value. A reference assigned later, by a dotenv library for example, resolves through `process.env` but not through `Bun.env`. Read late-assigned values through `process.env`. On a host none of this applies: there is no hook, and `Bun.env` holds whatever the host set.

## Checklist

1. Commit `.kerstel/exec.cjs` with your `package.json`. `kerstel init` warns if `.gitignore` hides it.
2. Set every key on the host.
3. Keep `.env` out of git, or commit it knowing that a key missing on the host shows up as a literal `kerstel://` value.
4. In a Turborepo, add the three `KERSTEL_*` variables to `globalPassThroughEnv`.
5. Do not install Kerstel on the host.
