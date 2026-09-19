# Contributor and agent rules

These rules apply to everyone who changes this repo, human or coding agent. `CLAUDE.md` imports this file; other agents read it directly.

## What Kerstel is

Kerstel is a local-first secrets manager for Node and Bun projects. It is a new product that replaced an unrelated macOS menu bar app of the same name, not a second version of it.

- Versions follow [Semantic Versioning](https://semver.org) and start at 0.1.0.
- Never call Kerstel "v2", and never label product stages "v1", "v2", or "v3". Say "0.1.0", "0.2.0", "next", or "later", matching `ROADMAP.md`.
- Never mention the old menu bar app in user-facing copy: the README, the website, CLI output, or release notes.

## Roadmap and changelog

`ROADMAP.md` tracks features. `CHANGELOG.md` tracks releases. The website publishes both, at `/roadmap` and `/changelog`.

1. **If a PR adds, changes, fixes, or removes user-visible behaviour,** add a line to the top `(unreleased)` section of `CHANGELOG.md`, under `Added`, `Changed`, `Fixed`, `Removed`, or `Security`. Describe the effect for users, not the implementation. CI fails a PR that changes `packages/*/src` without touching `CHANGELOG.md`, unless the PR has the `skip-changelog` label (for refactors and internal-only changes).
2. **If a PR completes a roadmap item,** tick its box (`- [x]`) in the same PR. Tick only items that the PR finishes on merge, never ones still in progress or in another open PR.
3. **If a PR ships a feature that is not on the roadmap,** add it under the release it ships in, already ticked.
4. **If a plan or spec moves a feature to another release,** move its line in `ROADMAP.md` in the same PR.
5. **Never tick a box, add a changelog line, or move a feature for work that isn't in the PR.**
6. **Every open roadmap item has a GitHub issue,** labelled `roadmap` and in the milestone named after its section (`0.2.0`, `Next`, `Later`), and the roadmap line links to it. When you add an item, open its issue and link it in the same PR. When you move an item, move its issue to the new milestone.
7. **A PR that finishes a roadmap item says `Closes #N`** in its description, so merging closes the issue as the box is ticked. Designs stay in `docs/superpowers/`; an issue links to its spec rather than copying it.
8. **Only the maintainer cuts a release.** See "Releasing" below.

## Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`: it verifies the tag, cross-compiles the four binaries, smoke-tests each on its own OS with no source checkout, publishes the GitHub Release, and then installs it with the real `install.sh`.

1. In `CHANGELOG.md`, replace `(unreleased)` with today's date (`## 0.1.0 (2026-10-01)`) and add an empty `## 0.1.1 (unreleased)` section above it. Merge that to `main`.
2. Tag the merge commit and push the tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. To rehearse, push a pre-release tag first (`v0.1.0-rc.1`). It accepts an `(unreleased)` heading and publishes a GitHub pre-release. Delete it afterwards with `gh release delete v0.1.0-rc.1 --cleanup-tag --yes`.

`bun scripts/release-verify.ts <tag>` runs the same pre-flight check locally.

### Release videos

Every minor and major release (`0.2.0`, `1.0.0`) gets a short release video at the top of the changelog page. Patch releases (`0.1.1`) do not.

1. Make it with `/brag` in the release PR (the one that dates the changelog section). Polished tone, landscape, 15-25 seconds, in the site's own look: the version tag, what shipped in that release, the install line, and the mark. Use the release's changelog lines as the copy.
2. Bake the poster as frame 0, then copy the web encode and poster to `apps/website/src/static/release-X.Y.Z.mp4` and `release-X.Y.Z.jpg`. Keep the MP4 to a few MB.
3. Register it in `RELEASE_MEDIA` in `apps/website/src/changelog.ts`. The newest released version with an entry is the one shown above the timeline, so the previous video stays reachable only through git. A test fails if a registered file is missing.
4. Rebuild `docs/` and commit the result, as for any website change.

The `brag-output/` directory is gitignored, so the composition source is not kept. Keep the plan in the PR description if the video will need re-rendering.

## Website

- `docs/` is generated output. Edit `apps/website/src/`, the root `CHANGELOG.md`, or `ROADMAP.md`, then run `bun run --cwd apps/website build` and commit the result. CI fails if `docs/` is stale.
- `CHANGELOG.md` and `ROADMAP.md` render on both GitHub and the website, so links in them must be absolute URLs (`https://kerstel.dev/...`). A relative `.md` link breaks on the site, and a test fails the build.
- **If a PR changes CLI behaviour,** update the matching pages in `apps/website/src/pages/` and the README in the same PR. Check every command, flag, and message in the copy against the CLI source.

## Git

- Never commit to `main`. Branch with `feat/`, `fix/`, `docs/`, or `chore/`.
- Use [Conventional Commits](https://www.conventionalcommits.org) for commit messages and PR titles.
- Keep each PR to one feature or fix.

## Build and test

```bash
bun install
bun run typecheck
bun run test          # builds the hook first, then runs every suite
bun run --cwd packages/cli build   # compiled binary at dist/kerstel
```

- CI and release builds use the Bun version pinned in `.github/workflows/` (1.4.2), and the release binaries embed it. Develop on the same version, and bump every pin together.
- The macOS Keychain tests touch the real login Keychain. They run only with `KERSTEL_ALLOW_REAL_KEYCHAIN_TESTS=1`.
- Tests must never print a secret value, and temporary vaults and homes must be cleaned up.

## Specs and plans

Design specs live in `docs/superpowers/specs/`, implementation plans in `docs/superpowers/plans/`. Read the relevant spec before changing behaviour it covers. If you change that behaviour, update the spec in the same PR.
