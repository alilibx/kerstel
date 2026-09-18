# Kerstel website (kerstel.dev) — design

**Date:** 2026-09-18
**Status:** approved in brainstorming, awaiting implementation plan (plan 4 of 5)
**Parent spec:** [2026-09-17-kerstel-secrets-manager-design.md](2026-09-17-kerstel-secrets-manager-design.md) §11

## 1. Problem

kerstel.dev still serves the landing page for the retired macOS menu bar app: system metrics, port management, AI usage tracking, a `v1.3.1` badge, and a changelog widget that lists v1.x menu-bar releases. The product is now a local-first secrets manager for Node and Bun projects. Anyone who follows the README link to kerstel.dev sees the wrong product.

## 2. Goals

- Replace the site with one that describes the secrets manager and nothing else.
- Put the install one-liner front and center. `curl -fsSL https://kerstel.dev/install.sh | bash` stays the canonical command. Until plan 5 ships binaries, `docs/install.sh` remains the stub that prints "not released yet" and exits 1, so the command is never misleading.
- Ship a security-model page and a small docs set sourced from the README and the parent spec.
- Keep deployment as it is: GitHub Pages, legacy build, source `main:/docs`, custom domain `kerstel.dev`.
- Make stale output impossible to merge.

## 3. Non-goals

- Search, sidebar navigation, per-command pages, troubleshooting guides.
- A changelog widget. GitHub releases are all v1.x menu-bar releases; the widget returns with plan 5 once a real release exists.
- Moving `docs/superpowers/` out of the Pages root. It is public today in a public repo; leave it.
- Switching Pages to an Actions deploy.
- Documenting `kerstel init` beyond one sentence. The wizard is plan 2 and not on `main`; plan 2 updates Getting Started when it lands.

## 4. Approach

A small Bun generator in a new workspace package renders Markdown pages through one HTML layout into `docs/`. Output is committed. CI rebuilds and fails on a dirty `docs/` diff.

Alternatives considered: hand-written HTML in `docs/` (no tooling, but six copies of header, footer, and nav that drift), and Astro with an Actions deploy (best authoring, but a framework dependency tree and a Pages source switch for six pages). The generator keeps the repo's Bun-first, near-zero-dependency character and matches the `apps/website` path the parent spec names.

## 5. Package layout

```
apps/website/
  package.json        name "@kerstel/website"; scripts: build, test, typecheck
  tsconfig.json       extends ../../tsconfig.base.json
  build.ts            the generator
  src/
    layout.html       single page shell with {{title}}, {{description}}, {{nav}}, {{content}} slots
    styles.css        one stylesheet, copied to docs/styles.css
    hero.js           landing-page hero animation, copied to docs/hero.js
    pages/
      index.md        landing page (front matter + mostly raw HTML)
      security.md
      docs/index.md
      docs/getting-started.md
      docs/cli.md
      docs/how-it-works.md
      docs/teams.md
    static/           copied verbatim: logo-dark.png, logo-white.png, icon-light.png,
                      icon-dark.png, favicon-32.png, apple-touch-icon.png, install.sh,
                      CNAME, .nojekyll
  test/
    build.test.ts
```

Root `package.json` `workspaces` becomes `["packages/*", "apps/*"]`. Root `typecheck` already runs `--filter '*'`, so the new package is included.

## 6. Generator (`build.ts`)

Input: every `*.md` under `src/pages`. Each file starts with a front-matter block:

```
---
title: Getting started
description: Install Kerstel, store a secret, run your app.
section: docs        # optional; pages with section "docs" appear in the docs nav
order: 1             # optional; sort key within a section
---
```

Front matter is parsed by hand: a `---` fence, `key: value` lines, no nesting. Body renders with `marked` with raw HTML allowed, so `index.md` can hold the hero and feature strip as HTML while sharing the layout. Output path mirrors the source path: `src/pages/docs/cli.md` → `docs/docs/cli.html`.

Layout slots: `{{title}}`, `{{description}}`, `{{content}}`, `{{nav}}`, `{{canonical}}`. Nav is built from the page list and marks the current page. Links inside the site use extension-less paths (`/docs/cli`), which Pages resolves to `.html`.

Output step, in order:

1. Delete everything in `docs/` except the `superpowers/` directory. `CNAME` is regenerated from `static/`, so a build into a temp directory is complete on its own.
2. Write rendered pages.
3. Copy `src/static/*` into `docs/`.
4. Copy `styles.css` and `hero.js`.

The build takes an optional `--out <dir>` so tests render into a temp directory. Running it twice yields a byte-identical `docs/`.

Dependencies: `marked` only.

## 7. Pages

### 7.1 Landing (`/`)

Order of sections:

1. **Hero.** Logo, `Kerstel`, "Local-first secrets for Node and Bun projects", and a terminal card. The card types `OPENAI_API_KEY=sk-live-4f9…` then morphs the value into `kerstel://global/OPENAI_API_KEY`, holds, and loops. Plain CSS transitions and a small script; no library. Under `prefers-reduced-motion: reduce` the card shows the final state with no animation.
2. **Install.** The curl one-liner in a code box with a copy button. One line under it: "macOS, Linux, and Windows binaries. No account, no cloud, no telemetry."
3. **The problem.** Two sentences from the README.
4. **How it works.** Three-step strip: Vault (encrypted at rest, key in the OS credential store), Daemon (unlocks once, serves resolutions over a local socket), Hook (your code reads `process.env`, the file on disk never holds a value).
5. **Security model.** Three claims linking to `/security`.
6. **Footer.** GitHub, Security, Docs, License. No version badge.

### 7.2 Security (`/security`)

Prose from parent spec §3 and the README security section: what is protected, AES-256-GCM with one nonce per value, where the data key lives, the process boundary drawn today (code running in the project can read resolved values), and what v2 access gating adds. Ends with a link to the parent spec on GitHub.

### 7.3 Docs

- `/docs` — one paragraph and links to the four pages.
- `/docs/getting-started` — install, `kerstel set global/OPENAI_API_KEY`, replace the value in `.env` with the reference, run with `kerstel run -- <command>`. One sentence: `kerstel init` will do this for a whole project; it is in progress.
- `/docs/cli` — command table sourced from the README usage block: `set`, `get`, `ls`, `rm`, `run`, `resolve`, `daemon`, `doctor`.
- `/docs/how-it-works` — reference syntax, scopes with no fallback chain, the daemon and its socket, the runtime hook versus `kerstel run`, and the known edge cases the parent spec lists in §6.3.
- `/docs/teams` — committed references as a living `.env.example`, and how a teammate fills their local vault.

Content is rewritten for the web, not pasted. Every page must be free of "menu bar", "macOS 14", "AI usage", "ports", and "system metrics".

## 8. Visual direction

Continue the current brand: dark background `#202124`, surfaces `#292a2d`, green accent `#4ade80`, system sans for prose, mono for references and commands. Add a faint grid behind the hero, a mono display treatment for `kerstel://` references, and one max-width column around 680px. Mobile first: 16px gutters, no horizontal scroll at 375px. Colors defined as CSS variables on `:root`.

## 9. CI

`ci.yml` gains a `website` job on `ubuntu-latest`:

```
bun install --frozen-lockfile
bun run --cwd apps/website build
git diff --exit-code -- docs/
bun test apps/website
```

A page edit without a rebuild fails the job.

## 10. Testing

`apps/website/test/build.test.ts` runs the generator into a temp directory and asserts:

- every page in §7 exists at its expected path;
- every internal `href` that starts with `/` resolves to a file in the output (with `.html` appended when there is no extension), or is `/install.sh`;
- no output page contains any string from the §7.3 forbidden list;
- `CNAME` and `.nojekyll` are present;
- building twice produces identical file sets and contents.

## 11. Rollout

The branch replaces `docs/` in one PR. Merging to `main` deploys. Nothing to flip when plan 5 lands except replacing `docs/install.sh` via `apps/website/src/static/install.sh`.
