# Release Pipeline, Installer, and Uninstall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Kerstel 0.1.0: `kerstel --version`, a tag-triggered release workflow that builds and smoke-tests four binaries, a real `install.sh`, and `kerstel uninstall`.

**Architecture:** The CLI gains a build-time version constant and an `uninstall` command split into three units: file unwiring (`src/uninstall/unwire.ts`), a read-only planner (`src/uninstall/plan.ts`), and the command that shows, gates, and applies the plan (`src/commands/uninstall.ts`). The display masking `init` uses moves to `src/init/display.ts` so both commands share it. Release logic that can be unit-tested lives in `scripts/release-verify.ts`; the workflow itself is YAML that calls it. `install.sh` is a single bash function tested against a fake local release.

**Tech Stack:** Bun (runtime, test runner, `bun build --compile`), TypeScript (strict), bash, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-18-release-install-uninstall-design.md`. Read it before starting any task.

## Global Constraints

- Platforms in 0.1.0: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` (glibc). No Windows, no musl.
- Asset names: `kerstel-darwin-arm64`, `kerstel-darwin-x64`, `kerstel-linux-x64`, `kerstel-linux-arm64`, plus `SHA256SUMS` in `sha256sum` format (`<hash>  <asset>`).
- Install directory: `${KERSTEL_INSTALL_DIR:-$HOME/.local/bin}`. The installer never uses `sudo`, never edits a shell profile, and never reads or writes `~/.kerstel`.
- Installer environment variables: `KERSTEL_VERSION`, `KERSTEL_INSTALL_DIR`, `KERSTEL_DOWNLOAD_BASE`. No others.
- `kerstel --version` and `kerstel version` print the bare version (`0.1.0`) and nothing else.
- A final tag `vX.Y.Z` needs every workspace `package.json` at `X.Y.Z` and a `## X.Y.Z (YYYY-MM-DD)` changelog heading. A pre-release tag `vX.Y.Z-<pre>` needs the same versions and accepts `## X.Y.Z (unreleased)` too.
- `uninstall` prints no secret value, ever. Diffs of `.env` files go through `maskForDisplay` on both sides.
- `uninstall` restores from current vault values, never from backups.
- `uninstall` loss gate: any unreachable project, unresolvable reference, or unused secret stops a real run with exit 1 unless `--force`. `--yes` never implies `--force`. `--dry-run` always exits 0 and writes nothing.
- `uninstall` deletes nothing until every project file has been written.
- The binary deletes itself only when `isCompiledBinary()` is true.
- Copy rules from `AGENTS.md`: no "v1/v2" product labels, no mention of the old menu bar app, absolute URLs in `CHANGELOG.md` and `ROADMAP.md`.
- Tests never print a secret value and never leave files outside the per-run temp directory (the `scripts/test-tmpdir.ts` preload handles `os.tmpdir()`; do not hard-code `/tmp` in tests).
- Run all commands from the repo root unless a step says otherwise. `bun run test` builds the hook first; plain `bun test <path>` needs the hook built once (`bun run --cwd packages/hook build`).

## File map

| File | Responsibility |
| --- | --- |
| `packages/cli/src/init/display.ts` (new) | `describeValue`, `maskForDisplay`: value-free rendering of `.env` files. Moved out of `commands/init.ts`. |
| `packages/cli/src/init/wiring.ts` | Gains `GITIGNORE_NOTE` and `serializePackageJson`, shared by wiring and unwiring. |
| `packages/cli/src/version.ts` (new) | `VERSION` constant from `package.json`. |
| `packages/cli/src/uninstall/unwire.ts` (new) | `unwirePackageJson`, `restoreGitignore`. Pure string functions. |
| `packages/cli/src/uninstall/plan.ts` (new) | `planUninstall(vault)`: reads projects and files, computes rewrites and losses. Writes nothing. |
| `packages/cli/src/commands/uninstall.ts` (new) | Argument parsing, printing, loss gate, confirm, apply. |
| `scripts/release-verify.ts` (new) | Tag/version/changelog checks and release-notes extraction. |
| `.github/workflows/release.yml` (new) | Verify, build, smoke, publish, installer check. |
| `apps/website/src/static/install.sh` | The installer. |
| `apps/website/test/install.test.ts` (new) | Runs `install.sh` against a fake release. |

---

### Task 1: Move display masking into `src/init/display.ts`

A pure move so `uninstall` can reuse it. Behaviour must not change.

**Files:**
- Create: `packages/cli/src/init/display.ts`
- Modify: `packages/cli/src/commands/init.ts` (remove `describeValue`, `redact`, `UNPARSED_MASK`, `BLANK_OR_COMMENT`, `maskForDisplay`, and `GITIGNORE_NOTE`; import them instead)
- Modify: `packages/cli/src/init/wiring.ts` (add `GITIGNORE_NOTE`, `serializePackageJson`)
- Test: `packages/cli/test/init-display.test.ts`

**Interfaces:**
- Produces: `describeValue(value: string): string`, `maskForDisplay(source: string): string` from `src/init/display.ts`; `GITIGNORE_NOTE: string` and `serializePackageJson(parsed: unknown, source: string): string` from `src/init/wiring.ts`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/init-display.test.ts`:

```ts
import { expect, test } from "bun:test";
import { describeValue, maskForDisplay } from "../src/init/display";
import { GITIGNORE_NOTE, serializePackageJson } from "../src/init/wiring";

test("describeValue gives shape and size only", () => {
  expect(describeValue("")).toBe("empty");
  expect(describeValue("postgres://u:p@h/db")).toBe("19 chars, url");
  expect(describeValue("sk-abc")).toBe("6 chars, opaque");
});

test("maskForDisplay hides plaintext, keeps references, comments, and quoting", () => {
  const source = '# note\nA=secret-value\nB="quoted secret"\nC=kerstel://demo/C\n';
  const masked = maskForDisplay(source);
  expect(masked).not.toContain("secret-value");
  expect(masked).not.toContain("quoted secret");
  expect(masked).toContain("# note\n");
  expect(masked).toContain("A=«12-chars-opaque»\n");
  expect(masked).toContain('B="«13-chars-opaque»"\n');
  expect(masked).toContain("C=kerstel://demo/C\n");
});

test("serializePackageJson keeps indent, CRLF, and a missing final newline", () => {
  const crlf = '{\r\n    "name": "x"\r\n}\r\n';
  expect(serializePackageJson(JSON.parse(crlf), crlf)).toBe(crlf);
  const bare = '{\n  "name": "x"\n}';
  expect(serializePackageJson(JSON.parse(bare), bare)).toBe(bare);
});

test("GITIGNORE_NOTE is the line init writes", () => {
  expect(GITIGNORE_NOTE).toBe("# Kerstel: .env files hold references, safe to commit");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/cli/test/init-display.test.ts`
Expected: FAIL, cannot resolve `../src/init/display`.

- [ ] **Step 3: Create `display.ts` by moving code**

Create `packages/cli/src/init/display.ts`. Cut these from `packages/cli/src/commands/init.ts` and paste them unchanged, adding `export` to `describeValue` and `maskForDisplay`: the `describeValue` function (with its `/** Shape and size only... */` comment), `redact`, `UNPARSED_MASK`, `BLANK_OR_COMMENT`, and `maskForDisplay` with its whole doc comment. Add at the top:

```ts
import { parseReference } from "../reference";
import { parseDotenv } from "./dotenv-file";
```

In `packages/cli/src/init/wiring.ts`, add after `EXEC_PREFIX`:

```ts
/** The line `init` leaves in .gitignore in place of the env-file lines it removes. */
export const GITIGNORE_NOTE = "# Kerstel: .env files hold references, safe to commit";
```

and replace the tail of `wirePackageJson` (from the `// Keep the file's own line endings` comment to the closing `};` of the return) with:

```ts
  return {
    changed: true,
    contents: serializePackageJson(parsed, source),
    rewrites,
    skipped,
  };
}

/**
 * JSON.stringify with the source file's own indent, line endings, and final
 * newline (or lack of one), so the only lines a rewrite changes are the ones
 * whose content changed.
 */
export function serializePackageJson(parsed: unknown, source: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const body = JSON.stringify(parsed, null, detectIndent(source)).replace(/\n/g, eol);
  const finalNewline = /\r?\n$/.test(source) ? eol : "";
  return body + finalNewline;
}
```

In `packages/cli/src/commands/init.ts`: delete the local `GITIGNORE_NOTE` constant, and add to the imports:

```ts
import { describeValue, maskForDisplay } from "../init/display";
```

and change the wiring import to:

```ts
import { GITIGNORE_NOTE, renderDiff, wirePackageJson } from "../init/wiring";
```

Remove `parseDotenv` from the `../init/dotenv-file` import only if the compiler reports it unused.

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test packages/cli/test/init-display.test.ts packages/cli/test/init.test.ts packages/cli/test/init-wiring.test.ts && bun run typecheck`
Expected: all PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/display.ts packages/cli/src/init/wiring.ts packages/cli/src/commands/init.ts packages/cli/test/init-display.test.ts
git commit -m "refactor(cli): move init's display masking into init/display.ts"
```

---

### Task 2: `kerstel --version`

**Files:**
- Modify: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/version.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/cli.test.ts`, `packages/cli/test/e2e.test.ts`

**Interfaces:**
- Produces: `VERSION: string` from `src/version.ts`. The release smoke test and `install.sh` rely on `kerstel --version` printing exactly this.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/cli.test.ts`:

```ts
test("--version and version print the bare package version", async () => {
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
  for (const flag of ["--version", "version"]) {
    capture();
    expect(await runCli([flag])).toBe(0);
    expect(captured.join("\n")).toBe(pkg.version);
  }
});
```

Append to `packages/cli/test/e2e.test.ts`:

```ts
test("the compiled binary reports its version", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-version-"));
  const pkg = (await Bun.file(join(REPO, "packages/cli/package.json")).json()) as { version: string };
  const result = await kerstel(["--version"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`${pkg.version}\n`);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd packages/hook build && bun test packages/cli/test/cli.test.ts -t "version"`
Expected: FAIL, `Unknown command "--version"`.

- [ ] **Step 3: Implement**

`packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "resolveJsonModule": true
  },
  "include": ["src", "test"]
}
```

`packages/cli/src/version.ts`:

```ts
import pkg from "../package.json";

/** Inlined at build time, so the compiled binary knows its own version. */
export const VERSION: string = pkg.version;
```

In `packages/cli/src/index.ts`, import it and handle it before the help check:

```ts
import { VERSION } from "./version";
```

```ts
  if (command === "--version" || command === "version") {
    console.log(VERSION);
    return 0;
  }
```

Add to `USAGE`, after the `doctor` line:

```
  kerstel --version                             Print the version
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/cli/test/cli.test.ts packages/cli/test/e2e.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/tsconfig.json packages/cli/src/version.ts packages/cli/src/index.ts packages/cli/test/cli.test.ts packages/cli/test/e2e.test.ts
git commit -m "feat(cli): add kerstel --version"
```

---

### Task 3: Release verification script

**Files:**
- Create: `scripts/release-verify.ts`
- Test: `scripts/release-verify.test.ts`

**Interfaces:**
- Produces: `parseTag(tag): { version: string; prerelease: boolean } | null`, `changelogSection(changelog, version): { heading: string; body: string } | null`, `verifyRelease(input: { tag: string; versions: Record<string, string>; changelog: string }): string[]` (error messages; empty means OK). CLI: `bun scripts/release-verify.ts <tag> [notes-file]` exits 1 on errors, writes the section body to `notes-file`, and appends `version=<X.Y.Z>` and `prerelease=<true|false>` to `$GITHUB_OUTPUT` when that variable is set. Task 4 calls this CLI.

- [ ] **Step 1: Write the failing tests**

`scripts/release-verify.test.ts`:

```ts
import { expect, test } from "bun:test";
import { changelogSection, parseTag, verifyRelease } from "./release-verify";

const VERSIONS = { "package.json": "0.1.0", "packages/cli/package.json": "0.1.0" };
const DATED = "# Changelog\n\n## 0.1.0 (2026-10-01)\n\n### Added\n\n- A thing.\n\n## 0.0.9 (2026-09-01)\n\n- Old.\n";
const UNRELEASED = DATED.replace("(2026-10-01)", "(unreleased)");

test("parseTag reads final and pre-release tags", () => {
  expect(parseTag("v0.1.0")).toEqual({ version: "0.1.0", prerelease: false });
  expect(parseTag("v0.1.0-rc.1")).toEqual({ version: "0.1.0", prerelease: true });
  expect(parseTag("0.1.0")).toBeNull();
  expect(parseTag("v0.1")).toBeNull();
});

test("changelogSection returns the heading and the body up to the next section", () => {
  expect(changelogSection(DATED, "0.1.0")).toEqual({
    heading: "## 0.1.0 (2026-10-01)",
    body: "### Added\n\n- A thing.",
  });
  expect(changelogSection(DATED, "0.2.0")).toBeNull();
});

test("a matching final tag with a dated section passes", () => {
  expect(verifyRelease({ tag: "v0.1.0", versions: VERSIONS, changelog: DATED })).toEqual([]);
});

test("a version mismatch names the file", () => {
  const errors = verifyRelease({
    tag: "v0.1.0",
    versions: { ...VERSIONS, "packages/cli/package.json": "0.0.9" },
    changelog: DATED,
  });
  expect(errors).toEqual(["packages/cli/package.json has version 0.0.9, but the tag is v0.1.0."]);
});

test("a final tag refuses an unreleased section", () => {
  const errors = verifyRelease({ tag: "v0.1.0", versions: VERSIONS, changelog: UNRELEASED });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("(unreleased)");
});

test("a pre-release tag accepts an unreleased section", () => {
  expect(verifyRelease({ tag: "v0.1.0-rc.1", versions: VERSIONS, changelog: UNRELEASED })).toEqual([]);
});

test("a missing section and a malformed tag are errors", () => {
  expect(verifyRelease({ tag: "v0.2.0", versions: { a: "0.2.0" }, changelog: DATED })).toEqual([
    'CHANGELOG.md has no "## 0.2.0 (...)" section.',
  ]);
  expect(verifyRelease({ tag: "release-1", versions: VERSIONS, changelog: DATED })[0]).toContain("release-1");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test scripts/release-verify.test.ts`
Expected: FAIL, cannot resolve `./release-verify`.

- [ ] **Step 3: Implement**

`scripts/release-verify.ts`:

```ts
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Pre-flight for .github/workflows/release.yml: a tag may only publish when
 * every workspace package.json and CHANGELOG.md agree with it. See the plan-5
 * spec §4.1. Pure functions first, so they can be unit-tested; the CLI at the
 * bottom is what the workflow runs.
 */

export interface TagInfo {
  /** The base version, without the `v` or any pre-release suffix. */
  version: string;
  prerelease: boolean;
}

export function parseTag(tag: string): TagInfo | null {
  const match = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/.exec(tag);
  if (!match) return null;
  return { version: match[1]!, prerelease: match[2] !== undefined };
}

export function changelogSection(
  changelog: string,
  version: string,
): { heading: string; body: string } | null {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## ${version} (`) && line.endsWith(")"));
  if (start === -1) return null;
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end === -1) end = lines.length;
  return { heading: lines[start]!, body: lines.slice(start + 1, end).join("\n").trim() };
}

const DATED_HEADING = /^## \S+ \(\d{4}-\d{2}-\d{2}\)$/;

export function verifyRelease(input: {
  tag: string;
  versions: Record<string, string>;
  changelog: string;
}): string[] {
  const info = parseTag(input.tag);
  if (!info) {
    return [`Tag "${input.tag}" is not vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-PRERELEASE.`];
  }

  const errors: string[] = [];
  for (const [file, version] of Object.entries(input.versions)) {
    if (version !== info.version) errors.push(`${file} has version ${version}, but the tag is ${input.tag}.`);
  }

  const section = changelogSection(input.changelog, info.version);
  if (!section) {
    errors.push(`CHANGELOG.md has no "## ${info.version} (...)" section.`);
  } else if (!info.prerelease && !DATED_HEADING.test(section.heading)) {
    errors.push(
      `CHANGELOG.md's ${info.version} section is "${section.heading}". ` +
        'Replace "(unreleased)" with the release date (YYYY-MM-DD) before tagging.',
    );
  }
  return errors;
}

/** Every workspace package.json, relative to the repo root. */
export const PACKAGE_FILES = [
  "package.json",
  "packages/cli/package.json",
  "packages/hook/package.json",
  "apps/website/package.json",
];

if (import.meta.main) {
  const [tag, notesFile] = process.argv.slice(2);
  if (!tag) {
    console.error("usage: bun scripts/release-verify.ts <tag> [notes-file]");
    process.exit(2);
  }

  const root = resolve(import.meta.dir, "..");
  const versions: Record<string, string> = {};
  for (const file of PACKAGE_FILES) {
    versions[file] = (JSON.parse(readFileSync(join(root, file), "utf8")) as { version: string }).version;
  }
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

  const errors = verifyRelease({ tag, versions, changelog });
  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exit(1);
  }

  const info = parseTag(tag)!;
  if (notesFile) writeFileSync(notesFile, `${changelogSection(changelog, info.version)!.body}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${info.version}\nprerelease=${info.prerelease}\n`);
  }
  console.log(`${tag} is ready to release (${info.prerelease ? "pre-release" : "final"}).`);
}
```

- [ ] **Step 4: Run the tests, then the CLI against the real repo**

Run: `bun test scripts/release-verify.test.ts`
Expected: PASS (7 tests).

Run: `bun scripts/release-verify.ts v0.1.0-rc.1 /dev/null; echo "exit $?"`
Expected: `v0.1.0-rc.1 is ready to release (pre-release).` and `exit 0` (the changelog says `(unreleased)`).

Run: `bun scripts/release-verify.ts v0.1.0; echo "exit $?"`
Expected: an `::error::` line about `(unreleased)` and `exit 1`.

- [ ] **Step 5: Commit**

```bash
git add scripts/release-verify.ts scripts/release-verify.test.ts
git commit -m "feat(release): verify tag, package versions, and changelog before a release"
```

---

### Task 4: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `AGENTS.md` (add a "Releasing" section)

**Interfaces:**
- Consumes: `bun scripts/release-verify.ts <tag> <notes-file>` and its `version`/`prerelease` outputs (Task 3); `kerstel --version` (Task 2); `install.sh` honouring `KERSTEL_VERSION` and `KERSTEL_INSTALL_DIR` (Task 5, needed only by the `installer` job, which runs after publishing).

- [ ] **Step 1: Write the workflow**

`.github/workflows/release.yml`:

```yaml
name: Release
# Plan-5 spec §4. Push a v* tag to release. A pre-release tag (v0.1.0-rc.1)
# runs the same pipeline and publishes a GitHub pre-release.
on:
  push:
    tags: ["v*"]

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.verify.outputs.version }}
      prerelease: ${{ steps.verify.outputs.prerelease }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - id: verify
        run: bun scripts/release-verify.ts "$GITHUB_REF_NAME" release-notes.md
      - uses: actions/upload-artifact@v4
        with:
          name: release-notes
          path: release-notes.md

  build:
    needs: verify
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run --cwd packages/hook build
      - name: Cross-compile
        run: |
          mkdir -p release
          for target in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
            bun build packages/cli/src/index.ts --compile --target="bun-$target" --outfile "release/kerstel-$target"
          done
          cd release && sha256sum kerstel-* > SHA256SUMS && cat SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: binaries
          path: release/

  smoke:
    # No checkout: the binary must work with no source tree on the machine.
    needs: [verify, build]
    strategy:
      fail-fast: false
      matrix:
        include:
          - { runner: macos-14, asset: kerstel-darwin-arm64 }
          - { runner: macos-15-intel, asset: kerstel-darwin-x64 }
          - { runner: ubuntu-latest, asset: kerstel-linux-x64 }
          - { runner: ubuntu-24.04-arm, asset: kerstel-linux-arm64 }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: binaries
          path: ${{ runner.temp }}/release
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Smoke test ${{ matrix.asset }}
        env:
          EXPECTED_VERSION: ${{ needs.verify.outputs.version }}
        run: |
          set -euo pipefail
          work="$RUNNER_TEMP/smoke"
          mkdir -p "$work" && cd "$work"
          cp "$RUNNER_TEMP/release/${{ matrix.asset }}" ./kerstel
          chmod +x ./kerstel
          export KERSTEL_HOME="$work/home" KERSTEL_KEYCHAIN_BACKEND=file

          test "$(./kerstel --version)" = "$EXPECTED_VERSION"

          printf 'smoke-value' | ./kerstel set global/SMOKE_KEY
          test "$(./kerstel get global/SMOKE_KEY --reveal)" = "smoke-value"

          ./kerstel daemon start
          printf 'process.stdout.write(String(process.env.SMOKE_KEY))' > app.cjs
          out="$(SMOKE_KEY=kerstel://global/SMOKE_KEY ./kerstel exec -- node app.cjs)"
          ./kerstel daemon stop
          test "$out" = "smoke-value"

  publish:
    needs: [verify, smoke]
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: binaries
          path: release
      - uses: actions/download-artifact@v4
        with:
          name: release-notes
          path: notes
      - name: Create the GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
          PRERELEASE: ${{ needs.verify.outputs.prerelease }}
        run: |
          flag=""
          if [ "$PRERELEASE" = "true" ]; then flag="--prerelease"; fi
          gh release create "$GITHUB_REF_NAME" release/* \
            --repo "$GITHUB_REPOSITORY" \
            --title "Kerstel ${GITHUB_REF_NAME#v}" \
            --notes-file notes/release-notes.md \
            $flag

  installer:
    # The real one-liner against the release just published. Pinned to this
    # tag, because "latest" never points at a pre-release.
    needs: [verify, publish]
    strategy:
      fail-fast: false
      matrix:
        runner: [macos-14, macos-15-intel, ubuntu-latest, ubuntu-24.04-arm]
    runs-on: ${{ matrix.runner }}
    steps:
      - env:
          EXPECTED_VERSION: ${{ needs.verify.outputs.version }}
        run: |
          set -euo pipefail
          export KERSTEL_VERSION="${GITHUB_REF_NAME#v}" KERSTEL_INSTALL_DIR="$RUNNER_TEMP/bin"
          curl -fsSL https://kerstel.dev/install.sh | bash
          test "$("$KERSTEL_INSTALL_DIR/kerstel" --version)" = "$EXPECTED_VERSION"
```

- [ ] **Step 2: Lint the workflow**

Run: `bunx --bun js-yaml .github/workflows/release.yml > /dev/null && echo ok`
Expected: `ok` (the file parses). If `actionlint` is installed (`command -v actionlint`), also run `actionlint .github/workflows/release.yml` and expect no output.

- [ ] **Step 3: Document the release process in `AGENTS.md`**

In `AGENTS.md`, replace rule 6 of "Roadmap and changelog" with:

```markdown
6. **Only the maintainer cuts a release.** See "Releasing" below.
```

and add this section before "## Website":

```markdown
## Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`: it verifies the tag, cross-compiles the four binaries, smoke-tests each on its own OS with no source checkout, publishes the GitHub Release, and then installs it with the real `install.sh`.

1. In `CHANGELOG.md`, replace `(unreleased)` with today's date (`## 0.1.0 (2026-10-01)`) and add an empty `## 0.1.1 (unreleased)` section above it. Merge that to `main`.
2. Tag the merge commit and push the tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. To rehearse, push a pre-release tag first (`v0.1.0-rc.1`). It accepts an `(unreleased)` heading and publishes a GitHub pre-release. Delete it afterwards with `gh release delete v0.1.0-rc.1 --cleanup-tag --yes`.

`bun scripts/release-verify.ts <tag>` runs the same pre-flight check locally.
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml AGENTS.md
git commit -m "ci: build, smoke-test, and publish releases from v* tags"
```

---

### Task 5: `install.sh`

**Files:**
- Modify: `apps/website/src/static/install.sh` (full rewrite)
- Create: `apps/website/test/install.test.ts`
- Modify: `.github/workflows/ci.yml` (shellcheck in the `website` job)
- Modify: `apps/website/src/pages/index.md`, `apps/website/src/pages/docs/getting-started.md`
- Regenerate: `docs/` via `bun run --cwd apps/website build`

**Interfaces:**
- Consumes: the asset names and `SHA256SUMS` format from Global Constraints; `kerstel --version` (Task 2).
- Produces: the installer the Task 4 `installer` job runs.

- [ ] **Step 1: Write the failing tests**

`apps/website/test/install.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../src/static/install.sh");
const ASSETS = ["kerstel-darwin-arm64", "kerstel-darwin-x64", "kerstel-linux-x64", "kerstel-linux-arm64"];

let work: string;
let release: string;
let shims: string;
let installDir: string;

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** A stub binary that names its own asset, so a test can tell which one was installed. */
function fakeBinary(asset: string): string {
  return `#!/bin/sh\n# ${asset}\necho 0.1.0\n`;
}

function writeRelease(overrides: Record<string, string> = {}): void {
  let sums = "";
  for (const asset of ASSETS) {
    const body = fakeBinary(asset);
    writeFileSync(join(release, asset), body);
    sums += `${overrides[asset] ?? sha256(body)}  ${asset}\n`;
  }
  writeFileSync(join(release, "SHA256SUMS"), sums);
}

function shim(name: string, body: string): void {
  const path = join(shims, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

async function install(env: Record<string, string>, pathPrefix = "") {
  const proc = Bun.spawn(["bash", SCRIPT], {
    env: {
      HOME: work,
      SHELL: "/bin/zsh",
      PATH: `${pathPrefix}${shims}:/usr/bin:/bin`,
      KERSTEL_INSTALL_DIR: installDir,
      KERSTEL_DOWNLOAD_BASE: `file://${release}`,
      FAKE_OS: "Darwin",
      FAKE_ARCH: "arm64",
      FAKE_TRANSLATED: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "kerstel-install-"));
  release = join(work, "release");
  shims = join(work, "shims");
  installDir = join(work, "bin");
  mkdirSync(release);
  mkdirSync(shims);
  shim("uname", 'case "$1" in -s) echo "$FAKE_OS" ;; -m) echo "$FAKE_ARCH" ;; esac');
  shim("sysctl", 'echo "$FAKE_TRANSLATED"');
  shim("ldd", 'echo "ldd (GNU libc) 2.39"');
  writeRelease();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

test("installs the matching binary and reports its version", async () => {
  const result = await install({});
  expect(result.code).toBe(0);
  expect(readFileSync(join(installDir, "kerstel"), "utf8")).toBe(fakeBinary("kerstel-darwin-arm64"));
  expect(result.stdout).toContain(`Installed kerstel 0.1.0 to ${installDir}/kerstel`);
});

test("maps Linux x86_64 to linux-x64", async () => {
  const result = await install({ FAKE_OS: "Linux", FAKE_ARCH: "x86_64" });
  expect(result.code).toBe(0);
  expect(readFileSync(join(installDir, "kerstel"), "utf8")).toBe(fakeBinary("kerstel-linux-x64"));
});

test("a shell under Rosetta gets the arm64 binary", async () => {
  const result = await install({ FAKE_ARCH: "x86_64", FAKE_TRANSLATED: "1" });
  expect(result.code).toBe(0);
  expect(readFileSync(join(installDir, "kerstel"), "utf8")).toBe(fakeBinary("kerstel-darwin-arm64"));
});

test("re-running upgrades an existing copy in place", async () => {
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, "kerstel"), "old");
  const result = await install({});
  expect(result.code).toBe(0);
  expect(readFileSync(join(installDir, "kerstel"), "utf8")).toBe(fakeBinary("kerstel-darwin-arm64"));
});

test("a checksum mismatch installs nothing", async () => {
  writeRelease({ "kerstel-darwin-arm64": "0".repeat(64) });
  const result = await install({});
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("checksum mismatch");
  expect(existsSync(join(installDir, "kerstel"))).toBe(false);
});

test("an unsupported platform is refused with a build-from-source link", async () => {
  const result = await install({ FAKE_OS: "FreeBSD", FAKE_ARCH: "amd64" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("not supported yet");
  expect(result.stderr).toContain("#build-from-source");
  expect(existsSync(join(installDir, "kerstel"))).toBe(false);
});

test("prints a PATH hint only when the install directory is not on PATH", async () => {
  const missing = await install({});
  expect(missing.stdout).toContain("is not on your PATH");
  expect(missing.stdout).toContain(".zshrc");

  const present = await install({}, `${installDir}:`);
  expect(present.stdout).not.toContain("is not on your PATH");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/website/test/install.test.ts`
Expected: FAIL (the stub prints "no published release" and exits 1).

- [ ] **Step 3: Write the installer**

Replace `apps/website/src/static/install.sh` entirely:

```bash
#!/usr/bin/env bash
# Kerstel installer. https://kerstel.dev
#
#   curl -fsSL https://kerstel.dev/install.sh | bash
#
# Environment:
#   KERSTEL_VERSION        install this version (e.g. 0.1.0) instead of the latest
#   KERSTEL_INSTALL_DIR    install here instead of ~/.local/bin
#   KERSTEL_DOWNLOAD_BASE  download from here instead of GitHub Releases
#
# Everything is inside main(), called on the last line, so a download cut off
# halfway cannot run half a script. It never uses sudo, never edits a shell
# profile, and never touches ~/.kerstel.
set -euo pipefail

REPO_URL="https://github.com/alilibx/kerstel"
TMP_DIR=""

say() { printf '%s\n' "$*"; }
die() {
  printf 'kerstel install: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}

unsupported() {
  die "$1 is not supported yet. Build from source instead: ${REPO_URL}#build-from-source"
}

detect_asset() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os="darwin" ;;
    Linux)
      os="linux"
      if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
        unsupported "musl-based Linux (such as Alpine)"
      fi
      ;;
    *) unsupported "$os" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) unsupported "$os on $arch" ;;
  esac
  # A shell running under Rosetta reports x86_64 on Apple silicon.
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    arch="arm64"
  fi
  printf 'kerstel-%s-%s' "$os" "$arch"
}

download_base() {
  if [ -n "${KERSTEL_DOWNLOAD_BASE:-}" ]; then
    printf '%s' "${KERSTEL_DOWNLOAD_BASE%/}"
  elif [ -n "${KERSTEL_VERSION:-}" ]; then
    printf '%s/releases/download/v%s' "$REPO_URL" "${KERSTEL_VERSION#v}"
  else
    printf '%s/releases/latest/download' "$REPO_URL"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "needs sha256sum or shasum to verify the download"
  fi
}

path_hint() {
  local dir="$1"
  case ":${PATH}:" in
    *":${dir}:"*) return 0 ;;
  esac
  say ""
  say "${dir} is not on your PATH. Add it with:"
  case "${SHELL:-}" in
    */zsh) say "  echo 'export PATH=\"${dir}:\$PATH\"' >> ~/.zshrc" ;;
    */fish) say "  fish_add_path ${dir}" ;;
    *) say "  echo 'export PATH=\"${dir}:\$PATH\"' >> ~/.bashrc" ;;
  esac
  say "Then open a new terminal."
}

main() {
  command -v curl >/dev/null 2>&1 || die "needs curl"

  local asset base dir expected actual version staged
  asset="$(detect_asset)"
  base="$(download_base)"
  dir="${KERSTEL_INSTALL_DIR:-$HOME/.local/bin}"
  if [ -n "${KERSTEL_DOWNLOAD_BASE:-}" ]; then say "Downloading from ${base}"; fi

  TMP_DIR="$(mktemp -d)"
  trap cleanup EXIT

  say "Downloading ${asset}..."
  curl -fsSL "${base}/${asset}" -o "${TMP_DIR}/kerstel" || die "could not download ${base}/${asset}"
  curl -fsSL "${base}/SHA256SUMS" -o "${TMP_DIR}/SHA256SUMS" || die "could not download ${base}/SHA256SUMS"

  expected="$(awk -v name="$asset" '$2 == name {print $1}' "${TMP_DIR}/SHA256SUMS")"
  [ -n "$expected" ] || die "SHA256SUMS has no entry for ${asset}; nothing was installed"
  actual="$(sha256_of "${TMP_DIR}/kerstel")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for ${asset}; nothing was installed"

  # Stage next to the destination, then rename: an upgrade swaps the file in
  # one step, even when the temp directory is on another filesystem.
  mkdir -p "$dir"
  staged="${dir}/.kerstel-install.$$"
  cp "${TMP_DIR}/kerstel" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "${dir}/kerstel"

  version="$("${dir}/kerstel" --version)" || die "installed ${dir}/kerstel, but it did not run"
  say "Installed kerstel ${version} to ${dir}/kerstel"
  path_hint "$dir"
  say ""
  say "Next: run 'kerstel doctor', then 'kerstel init' inside a project."
}

main "$@"
```

- [ ] **Step 4: Run the tests and shellcheck**

Run: `bun test apps/website/test/install.test.ts`
Expected: PASS (7 tests).

Run: `command -v shellcheck && shellcheck apps/website/src/static/install.sh`
Expected: no output (skip if shellcheck is not installed locally; CI runs it).

- [ ] **Step 5: Add shellcheck to CI**

In `.github/workflows/ci.yml`, in the `website` job, add before `- run: bun test apps/website`:

```yaml
      - run: shellcheck apps/website/src/static/install.sh
```

- [ ] **Step 6: Update the site copy**

In `apps/website/src/pages/index.md`, replace the `install-note` paragraph with:

```html
<p class="install-note">macOS and Linux. No account, no cloud, no telemetry.</p>
```

In `apps/website/src/pages/docs/getting-started.md`, replace everything from `## 1. Install` up to (not including) `## 2. Store a secret` with:

````markdown
## 1. Install

```bash
curl -fsSL https://kerstel.dev/install.sh | bash
```

The installer downloads the binary for your Mac or Linux machine, checks it against the SHA-256 checksum published with the release, and puts it at `~/.local/bin/kerstel`. It never uses `sudo` and never touches your vault. If `~/.local/bin` is not on your `PATH`, it prints the line to add.

Run the same command again to upgrade. To install a specific version, set `KERSTEL_VERSION`:

```bash
curl -fsSL https://kerstel.dev/install.sh | KERSTEL_VERSION=0.1.0 bash
```

Windows is not supported yet. Run `kerstel doctor` afterwards to confirm the vault and credential store are reachable.

Prefer to build it yourself? The [README](https://github.com/alilibx/kerstel#build-from-source) covers building from source with Bun.

````

- [ ] **Step 7: Rebuild the site and run its tests**

Run: `bun run --cwd apps/website build && bun test apps/website`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/website docs .github/workflows/ci.yml
git commit -m "feat(install): download, verify, and install the release binary"
```

---

### Task 6: Unwiring helpers

**Files:**
- Create: `packages/cli/src/uninstall/unwire.ts`
- Test: `packages/cli/test/uninstall-unwire.test.ts`

**Interfaces:**
- Consumes: `EXEC_PREFIX`, `GITIGNORE_NOTE`, `serializePackageJson` from `src/init/wiring.ts` (Task 1).
- Produces: `unwirePackageJson(source: string): { changed: boolean; contents: string; unwrapped: string[] }` (throws `SyntaxError` on invalid JSON) and `restoreGitignore(source: string): { changed: boolean; contents: string }`. Task 7 uses both.

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/uninstall-unwire.test.ts`:

```ts
import { expect, test } from "bun:test";
import { restoreGitignore, unwirePackageJson } from "../src/uninstall/unwire";
import { wirePackageJson } from "../src/init/wiring";

const ORIGINAL = `{
  "name": "demo",
  "scripts": {
    "dev": "next dev",
    "postinstall": "patch-package",
    "mine": "kerstel run -- node x.js"
  }
}
`;

test("unwiring reverses wiring byte for byte", () => {
  const wired = wirePackageJson(ORIGINAL).contents;
  const result = unwirePackageJson(wired);
  expect(result.changed).toBe(true);
  expect(result.unwrapped).toEqual(["dev"]);
  expect(result.contents).toBe(ORIGINAL);
});

test("a script the user wrote that calls kerstel is left alone", () => {
  const result = unwirePackageJson(ORIGINAL);
  expect(result.changed).toBe(false);
  expect(result.contents).toBe(ORIGINAL);
});

test("CRLF and a missing final newline survive unwiring", () => {
  const crlf = wirePackageJson(ORIGINAL.replace(/\n/g, "\r\n")).contents;
  expect(unwirePackageJson(crlf).contents).toBe(ORIGINAL.replace(/\n/g, "\r\n"));
  const bare = wirePackageJson(ORIGINAL.trimEnd()).contents;
  expect(unwirePackageJson(bare).contents).toBe(ORIGINAL.trimEnd());
});

test("invalid JSON throws", () => {
  expect(() => unwirePackageJson("{ nope")).toThrow();
});

test("restoreGitignore swaps init's note for env-file lines", () => {
  const source = "node_modules\n# Kerstel: .env files hold references, safe to commit\ndist\n";
  expect(restoreGitignore(source)).toEqual({
    changed: true,
    contents: "node_modules\n.env\n.env.*\ndist\n",
  });
  expect(restoreGitignore("a\r\n# Kerstel: .env files hold references, safe to commit\r\n").contents).toBe(
    "a\r\n.env\r\n.env.*\r\n",
  );
  expect(restoreGitignore("node_modules\n")).toEqual({ changed: false, contents: "node_modules\n" });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/test/uninstall-unwire.test.ts`
Expected: FAIL, cannot resolve `../src/uninstall/unwire`.

- [ ] **Step 3: Implement**

`packages/cli/src/uninstall/unwire.ts`:

```ts
import { EXEC_PREFIX, GITIGNORE_NOTE, serializePackageJson } from "../init/wiring";

/**
 * The inverse of init's wiring. Only what `init` wrote is undone: a script
 * that starts with exactly EXEC_PREFIX loses it, and every other script,
 * including one the user wrote that calls `kerstel` themselves, is untouched.
 */
export function unwirePackageJson(source: string): { changed: boolean; contents: string; unwrapped: string[] } {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const unwrapped: string[] = [];

  const scripts = parsed.scripts;
  if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
    const table = scripts as Record<string, unknown>;
    for (const [name, value] of Object.entries(table)) {
      if (typeof value !== "string" || !value.startsWith(EXEC_PREFIX)) continue;
      table[name] = value.slice(EXEC_PREFIX.length);
      unwrapped.push(name);
    }
  }

  if (unwrapped.length === 0) return { changed: false, contents: source, unwrapped };
  return { changed: true, contents: serializePackageJson(parsed, source), unwrapped };
}

/**
 * `init` replaced the lines that hid .env files with GITIGNORE_NOTE. Once the
 * files hold plaintext again they must be hidden again, so the note becomes
 * `.env` and `.env.*`, keeping the file's line ending.
 */
export function restoreGitignore(source: string): { changed: boolean; contents: string } {
  const parts = source.split(/(\r\n|\n)/);
  let changed = false;
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    const eol = parts[i + 1] ?? "";
    if (text.trim() === GITIGNORE_NOTE) {
      const lineEnd = eol === "" ? "\n" : eol;
      out += `.env${lineEnd}.env.*${eol}`;
      changed = true;
    } else {
      out += text + eol;
    }
  }
  return { changed, contents: changed ? out : source };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/cli/test/uninstall-unwire.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/uninstall/unwire.ts packages/cli/test/uninstall-unwire.test.ts
git commit -m "feat(cli): add package.json and .gitignore unwiring for uninstall"
```

---

### Task 7: Uninstall planner

**Files:**
- Create: `packages/cli/src/uninstall/plan.ts`
- Test: `packages/cli/test/uninstall-plan.test.ts`

**Interfaces:**
- Consumes: `unwirePackageJson`, `restoreGitignore` (Task 6); `maskForDisplay` (Task 1); `detectProject` (`src/init/detect.ts`); `loadEnvFiles` (`src/init/collect.ts`); `parseDotenv`, `entries`, `setValue`, `serializeDotenv` (`src/init/dotenv-file.ts`); `parseReference`, `formatReference` (`src/reference.ts`); `Vault`, `ProjectRecord` (`src/vault/store.ts`).
- Produces (Task 8 relies on these exact names):

```ts
export interface PlannedFile {
  path: string;
  /** Shown above the diff, e.g. "demo-app: .env". */
  label: string;
  after: string;
  diffBefore: string;
  diffAfter: string;
}
export interface UnreachableProject {
  name: string;
  rootPath: string;
  reason: string;
}
export interface UnresolvableReference {
  project: string;
  file: string;
  reference: string;
}
export interface UninstallPlan {
  files: PlannedFile[];
  restored: { name: string; rootPath: string }[];
  unreachable: UnreachableProject[];
  unresolvable: UnresolvableReference[];
  /** kerstel:// references for vault secrets no reachable project uses. */
  unused: string[];
}
export function planUninstall(vault: Vault): UninstallPlan;
export function hasLoss(plan: UninstallPlan): boolean;
```

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/uninstall-plan.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasLoss, planUninstall } from "../src/uninstall/plan";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type Vault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

const dirs: string[] = [];
let vault: Vault | null = null;

afterEach(() => {
  vault?.close();
  vault = null;
  restoreEnv();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function freshVault(): Promise<Vault> {
  dirs.push(isolateEnv({ prefix: "uninstall-plan" }));
  const { key } = await loadOrCreateDataKey();
  vault = openVault(key);
  return vault;
}

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kerstel-uninstall-project-"));
  dirs.push(root);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  return root;
}

const WIRED = '{\n  "name": "demo-app",\n  "scripts": {\n    "dev": "kerstel exec -- next dev"\n  }\n}\n';

test("rewrites references to vault values and never puts a value in the diff", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "demo-app", key: "API_KEY" }, "sk-live-value");
  const root = project({
    "package.json": WIRED,
    ".env": "# keep me\r\nAPI_KEY=kerstel://demo-app/API_KEY\r\nPORT=3000\r\n",
  });
  v.registerProject("demo-app", root);

  const plan = planUninstall(v);
  const env = plan.files.find((f) => f.path === join(root, ".env"))!;
  expect(env.after).toBe("# keep me\r\nAPI_KEY=sk-live-value\r\nPORT=3000\r\n");
  expect(env.diffBefore + env.diffAfter).not.toContain("sk-live-value");
  expect(env.label).toBe("demo-app: .env");

  const pkg = plan.files.find((f) => f.path === join(root, "package.json"))!;
  expect(pkg.after).toContain('"dev": "next dev"');
  expect(plan.restored).toEqual([{ name: "demo-app", rootPath: root }]);
  expect(hasLoss(plan)).toBe(false);
});

test("swaps the .gitignore note back", async () => {
  const v = await freshVault();
  const root = project({
    "package.json": WIRED,
    ".gitignore": "node_modules\n# Kerstel: .env files hold references, safe to commit\n",
  });
  v.registerProject("demo-app", root);

  const plan = planUninstall(v);
  expect(plan.files.find((f) => f.path === join(root, ".gitignore"))?.after).toBe("node_modules\n.env\n.env.*\n");
});

test("records an unreachable project, an unresolvable reference, and an unused secret", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "global", key: "ORPHAN" }, "x");
  const gone = join(tmpdir(), "kerstel-uninstall-gone-project");
  v.registerProject("gone", gone);
  const noPkg = project({});
  v.registerProject("no-pkg", noPkg);
  const root = project({ "package.json": WIRED, ".env": "MISSING=kerstel://demo-app/MISSING\n" });
  v.registerProject("demo-app", root);

  const plan = planUninstall(v);
  expect(plan.unreachable).toEqual([
    { name: "gone", rootPath: gone, reason: "the folder no longer exists" },
    { name: "no-pkg", rootPath: noPkg, reason: "it has no package.json" },
  ]);
  expect(plan.unresolvable).toEqual([
    { project: "demo-app", file: join(root, ".env"), reference: "kerstel://demo-app/MISSING" },
  ]);
  expect(plan.unused).toEqual(["kerstel://global/ORPHAN"]);
  expect(hasLoss(plan)).toBe(true);
});

test("a malformed package.json makes the project unreachable", async () => {
  const v = await freshVault();
  const root = project({ "package.json": "{ nope" });
  v.registerProject("bad-json", root);
  expect(planUninstall(v).unreachable[0]?.reason).toBe("its package.json is not valid JSON");
});

test("a secret used only through a global reference in a project is not unused", async () => {
  const v = await freshVault();
  v.setSecret({ scope: "global", key: "SHARED" }, "shared-value");
  const root = project({ "package.json": WIRED, ".env": "SHARED=kerstel://global/SHARED\n" });
  mkdirSync(join(root, "sub"));
  v.registerProject("demo-app", root);
  expect(planUninstall(v).unused).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/test/uninstall-plan.test.ts`
Expected: FAIL, cannot resolve `../src/uninstall/plan`.

- [ ] **Step 3: Implement**

`packages/cli/src/uninstall/plan.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFiles } from "../init/collect";
import { detectProject } from "../init/detect";
import { maskForDisplay } from "../init/display";
import { entries, parseDotenv, serializeDotenv, setValue } from "../init/dotenv-file";
import { formatReference, parseReference } from "../reference";
import type { Vault } from "../vault/store";
import { restoreGitignore, unwirePackageJson } from "./unwire";

export interface PlannedFile {
  path: string;
  /** Shown above the diff, e.g. "demo-app: .env". */
  label: string;
  after: string;
  diffBefore: string;
  diffAfter: string;
}

export interface UnreachableProject {
  name: string;
  rootPath: string;
  reason: string;
}

export interface UnresolvableReference {
  project: string;
  file: string;
  reference: string;
}

export interface UninstallPlan {
  files: PlannedFile[];
  restored: { name: string; rootPath: string }[];
  unreachable: UnreachableProject[];
  unresolvable: UnresolvableReference[];
  /** kerstel:// references for vault secrets no reachable project uses. */
  unused: string[];
}

/**
 * Plan-5 spec §6.1. Reads the vault and every registered project and works
 * out what uninstall would write and what it would lose. Writes nothing.
 *
 * Values come from the vault, not from the encrypted backups: a backup holds
 * what the files said when `init` ran, and restoring it would silently undo
 * every rotation since.
 */
export function planUninstall(vault: Vault): UninstallPlan {
  const plan: UninstallPlan = { files: [], restored: [], unreachable: [], unresolvable: [], unused: [] };
  const used = new Set<string>();

  for (const project of vault.listProjects()) {
    const root = project.rootPath;
    const unreachable = (reason: string) => plan.unreachable.push({ name: project.name, rootPath: root, reason });

    if (!existsSync(root)) {
      unreachable("the folder no longer exists");
      continue;
    }
    const packagePath = join(root, "package.json");
    if (!existsSync(packagePath)) {
      unreachable("it has no package.json");
      continue;
    }
    const packageSource = readFileSync(packagePath, "utf8");
    let unwired: ReturnType<typeof unwirePackageJson>;
    try {
      unwired = unwirePackageJson(packageSource);
    } catch {
      unreachable("its package.json is not valid JSON");
      continue;
    }

    for (const loaded of loadEnvFiles(detectProject(root).envFiles)) {
      const copy = parseDotenv(loaded.original);
      for (const pair of entries(loaded.file)) {
        const ref = parseReference(pair.value);
        if (!ref) continue;
        const reference = formatReference(ref.scope, ref.key);
        const value = vault.getSecret(ref);
        if (value === null) {
          plan.unresolvable.push({ project: project.name, file: loaded.info.path, reference });
          continue;
        }
        used.add(reference);
        setValue(copy, pair.key, value);
      }
      const after = serializeDotenv(copy);
      if (after === loaded.original) continue;
      plan.files.push({
        path: loaded.info.path,
        label: `${project.name}: ${loaded.info.name}`,
        after,
        diffBefore: maskForDisplay(loaded.original),
        diffAfter: maskForDisplay(after),
      });
    }

    // package.json and .gitignore hold no secrets, so their diffs are shown as they are.
    if (unwired.changed) {
      plan.files.push({
        path: packagePath,
        label: `${project.name}: package.json`,
        after: unwired.contents,
        diffBefore: packageSource,
        diffAfter: unwired.contents,
      });
    }

    const gitignorePath = join(root, ".gitignore");
    if (existsSync(gitignorePath)) {
      const source = readFileSync(gitignorePath, "utf8");
      const restored = restoreGitignore(source);
      if (restored.changed) {
        plan.files.push({
          path: gitignorePath,
          label: `${project.name}: .gitignore`,
          after: restored.contents,
          diffBefore: source,
          diffAfter: restored.contents,
        });
      }
    }

    plan.restored.push({ name: project.name, rootPath: root });
  }

  plan.unused = vault
    .listSecrets()
    .map((secret) => formatReference(secret.scope, secret.key))
    .filter((reference) => !used.has(reference));

  return plan;
}

/** True when applying the plan would lose a secret. See the loss gate in spec §6.2. */
export function hasLoss(plan: UninstallPlan): boolean {
  return plan.unreachable.length + plan.unresolvable.length + plan.unused.length > 0;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/cli/test/uninstall-plan.test.ts && bun run typecheck`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/uninstall/plan.ts packages/cli/test/uninstall-plan.test.ts
git commit -m "feat(cli): plan an uninstall from current vault values"
```

---

### Task 8: `kerstel uninstall` command

**Files:**
- Create: `packages/cli/src/commands/uninstall.ts`
- Modify: `packages/cli/src/index.ts` (dispatch and `USAGE`)
- Test: `packages/cli/test/uninstall.test.ts`

**Interfaces:**
- Consumes: `planUninstall`, `hasLoss`, `UninstallPlan` (Task 7); `renderDiff` (`src/init/wiring.ts`); `openContext` (`src/context.ts`); `selectBackend` (`src/vault/keychain`); `isDaemonRunning`, `connectDaemon` (`src/daemon/client.ts`); `isCompiledBinary` (`src/daemon/spawn.ts`); `kerstelHome` (`src/paths.ts`); `Prompter`, `TtyPrompter` (`src/init/prompts.ts`).
- Produces: `parseUninstallArgs(args: string[]): UninstallOptions | { error: string }`, `uninstallCommand(args: string[], prompterOverride?: Prompter, binary?: { path: string; compiled: boolean }): Promise<number>`. Task 9 runs it through the compiled binary.

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/uninstall.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUninstallArgs, uninstallCommand } from "../src/commands/uninstall";
import { ScriptedPrompter } from "../src/init/prompts";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault } from "../src/vault/store";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

const dirs: string[] = [];
const realLog = console.log;
let output: string[] = [];

afterEach(() => {
  console.log = realLog;
  restoreEnv();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function capture(): void {
  output = [];
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
}

const WIRED = '{\n  "name": "demo-app",\n  "scripts": {\n    "dev": "kerstel exec -- next dev"\n  }\n}\n';
const NO_BINARY = { path: "/usr/local/bin/bun", compiled: false };

/** A home with one secret and one registered, wired project that uses it. */
async function setup(extra: { unusedSecret?: boolean } = {}): Promise<{ home: string; root: string }> {
  const home = isolateEnv({ prefix: "uninstall" });
  dirs.push(home);
  const root = mkdtempSync(join(tmpdir(), "kerstel-uninstall-app-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), WIRED);
  writeFileSync(join(root, ".env"), "API_KEY=kerstel://demo-app/API_KEY\n");

  const { key } = await loadOrCreateDataKey();
  const vault = openVault(key);
  vault.setSecret({ scope: "demo-app", key: "API_KEY" }, "sk-restored");
  if (extra.unusedSecret) vault.setSecret({ scope: "global", key: "ORPHAN" }, "orphan-value");
  vault.registerProject("demo-app", root);
  vault.close();
  return { home, root };
}

test("parseUninstallArgs reads the three flags and rejects others", () => {
  expect(parseUninstallArgs(["--dry-run", "--yes", "--force"])).toEqual({ dryRun: true, yes: true, force: true });
  expect(parseUninstallArgs(["--nope"])).toEqual({ error: expect.stringContaining("--nope") as unknown as string });
});

test("--yes restores the project and deletes all Kerstel data", async () => {
  const { home, root } = await setup();
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(0);

  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_KEY=sk-restored\n");
  expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"dev": "next dev"');
  expect(existsSync(home)).toBe(false);
  expect(output.join("\n")).not.toContain("sk-restored");
});

test("an interactive yes applies; the default no changes nothing", async () => {
  const { home, root } = await setup();
  capture();
  expect(await uninstallCommand([], new ScriptedPrompter([false]), NO_BINARY)).toBe(0);
  expect(existsSync(home)).toBe(true);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_KEY=kerstel://demo-app/API_KEY\n");

  expect(await uninstallCommand([], new ScriptedPrompter([true]), NO_BINARY)).toBe(0);
  expect(existsSync(home)).toBe(false);
});

test("--dry-run writes nothing and exits 0 even when something would be lost", async () => {
  const { home, root } = await setup({ unusedSecret: true });
  capture();
  expect(await uninstallCommand(["--dry-run"], undefined, NO_BINARY)).toBe(0);
  expect(existsSync(home)).toBe(true);
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_KEY=kerstel://demo-app/API_KEY\n");
  expect(output.join("\n")).toContain("kerstel://global/ORPHAN");
});

test("a possible loss refuses without --force, even with --yes", async () => {
  const { home } = await setup({ unusedSecret: true });
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(1);
  expect(existsSync(home)).toBe(true);
  const text = output.join("\n");
  expect(text).toContain("kerstel://global/ORPHAN");
  expect(text).toContain("--reveal");
  expect(text).not.toContain("orphan-value");

  expect(await uninstallCommand(["--yes", "--force"], undefined, NO_BINARY)).toBe(0);
  expect(existsSync(home)).toBe(false);
});

test("without a terminal and without --yes it exits 2", async () => {
  const { home } = await setup();
  capture();
  expect(await uninstallCommand([], undefined, NO_BINARY)).toBe(2);
  expect(existsSync(home)).toBe(true);
});

test("a failed write deletes nothing", async () => {
  const { home, root } = await setup();
  // A read-only file refuses the write; its folder stays writable, so cleanup can still remove it.
  chmodSync(join(root, ".env"), 0o444);
  capture();
  expect(await uninstallCommand(["--yes"], undefined, NO_BINARY)).toBe(1);
  expect(existsSync(home)).toBe(true);
  expect(output.join("\n")).toContain(join(root, ".env"));
});

test("the compiled binary removes itself; a source run leaves the runtime alone", async () => {
  const { home } = await setup();
  const fake = join(home, "..", `kerstel-fake-bin-${Date.now()}`);
  writeFileSync(fake, "binary");
  dirs.push(fake);
  capture();
  expect(await uninstallCommand(["--yes"], undefined, { path: fake, compiled: true })).toBe(0);
  expect(existsSync(fake)).toBe(false);

  const again = await setup();
  const runtime = join(again.home, "..", `kerstel-fake-bun-${Date.now()}`);
  writeFileSync(runtime, "bun");
  dirs.push(runtime);
  expect(await uninstallCommand(["--yes"], undefined, { path: runtime, compiled: false })).toBe(0);
  expect(existsSync(runtime)).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/test/uninstall.test.ts`
Expected: FAIL, cannot resolve `../src/commands/uninstall`.

- [ ] **Step 3: Implement**

`packages/cli/src/commands/uninstall.ts`:

```ts
import { rmSync, writeFileSync } from "node:fs";
import { openContext } from "../context";
import { connectDaemon, isDaemonRunning } from "../daemon/client";
import { isCompiledBinary } from "../daemon/spawn";
import { TtyPrompter, type Prompter } from "../init/prompts";
import { renderDiff } from "../init/wiring";
import { bold, fail, info, ok, yellow } from "../output";
import { kerstelHome } from "../paths";
import { hasLoss, planUninstall, type UninstallPlan } from "../uninstall/plan";
import { selectBackend } from "../vault/keychain";

/**
 * Plan-5 spec §6. Three phases: plan (read only), show and gate, then apply:
 * every project file first, and only once all of them are written, the
 * daemon, the data key, ~/.kerstel, and the binary.
 */

export interface UninstallOptions {
  dryRun: boolean;
  yes: boolean;
  force: boolean;
}

export function parseUninstallArgs(args: string[]): UninstallOptions | { error: string } {
  const options: UninstallOptions = { dryRun: false, yes: false, force: false };
  for (const arg of args) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--force") options.force = true;
    else return { error: `Unknown option "${arg}". kerstel uninstall accepts: --dry-run, --yes, --force.` };
  }
  return options;
}

function printPlan(plan: UninstallPlan): void {
  console.log(bold("kerstel uninstall"));
  if (plan.files.length === 0) info("No project files need restoring.");
  for (const file of plan.files) {
    console.log("");
    console.log(renderDiff(file.label, file.diffBefore, file.diffAfter));
  }

  // Names and references only. Values never reach the terminal.
  if (plan.unreachable.length > 0) {
    console.log("");
    console.log(yellow("!  Projects Kerstel cannot reach, whose references stay as they are:"));
    for (const p of plan.unreachable) info(`${p.name} at ${p.rootPath}: ${p.reason}`);
  }
  if (plan.unresolvable.length > 0) {
    console.log("");
    console.log(yellow("!  References the vault cannot resolve, which stay as they are:"));
    for (const r of plan.unresolvable) info(`${r.reference} in ${r.file}`);
  }
  if (plan.unused.length > 0) {
    console.log("");
    console.log(yellow("!  Secrets no reachable project uses, which would be deleted with the vault:"));
    for (const reference of plan.unused) info(reference);
  }
}

async function stopDaemonIfRunning(): Promise<void> {
  if (!(await isDaemonRunning())) return;
  const client = await connectDaemon();
  await client.shutdown();
  client.close();
  ok("Stopped the Kerstel daemon.");
}

export async function uninstallCommand(
  args: string[],
  prompterOverride?: Prompter,
  binary: { path: string; compiled: boolean } = { path: process.execPath, compiled: isCompiledBinary() },
): Promise<number> {
  const options = parseUninstallArgs(args);
  if ("error" in options) {
    fail(options.error);
    return 2;
  }

  const ctx = await openContext();
  let plan: UninstallPlan;
  try {
    plan = planUninstall(ctx.vault);
  } finally {
    ctx.vault.close();
  }

  printPlan(plan);
  console.log("");

  if (options.dryRun) {
    info("--dry-run: nothing was written or deleted.");
    return 0;
  }

  if (hasLoss(plan) && !options.force) {
    fail(
      "Uninstalling now would lose the secrets listed above. Save each one first with " +
        "`kerstel get <scope>/<KEY> --reveal`, then re-run with --force.",
    );
    return 1;
  }

  if (!options.yes) {
    const prompter = prompterOverride ?? (process.stdin.isTTY === true ? new TtyPrompter() : null);
    if (!prompter) {
      fail("kerstel uninstall asks for confirmation, and this is not a terminal. Re-run with --yes.");
      return 2;
    }
    try {
      const go = await prompter.confirm("Restore these files and delete Kerstel from this machine?", false);
      if (!go) {
        info("Nothing was changed.");
        return 0;
      }
    } finally {
      if (prompter !== prompterOverride && prompter instanceof TtyPrompter) prompter.close();
    }
  }

  // Phase 1: project files. Nothing below runs unless every one is written.
  const written: string[] = [];
  for (const file of plan.files) {
    try {
      writeFileSync(file.path, file.after);
      written.push(file.path);
    } catch (error) {
      fail(
        `Could not write ${file.path} (${(error as Error).message}). Kerstel is still installed and ` +
          "nothing was deleted. Fix the file's permissions and re-run.",
      );
      if (written.length > 0) info(`Already restored: ${written.join(", ")}`);
      return 1;
    }
  }

  // Phase 2: Kerstel itself.
  await stopDaemonIfRunning();
  const backend = await selectBackend();
  await backend.delete();
  ok(`Deleted the vault key from the ${backend.name} credential store.`);
  const home = kerstelHome();
  rmSync(home, { recursive: true, force: true });
  ok(`Deleted ${home}.`);

  if (binary.compiled) {
    rmSync(binary.path, { force: true });
    ok(`Removed ${binary.path}.`);
  } else {
    info(`Running from source, so ${binary.path} was left in place.`);
  }

  console.log("");
  for (const project of plan.restored) ok(`Restored ${project.name} (${project.rootPath}).`);
  if (plan.restored.length > 0) {
    console.log(
      yellow("!  Those .env files hold plaintext secrets again. Keep them out of git: check your .gitignore."),
    );
  }
  return 0;
}
```

In `packages/cli/src/index.ts`, import it and dispatch it:

```ts
import { uninstallCommand } from "./commands/uninstall";
```

```ts
      case "uninstall":
        return await uninstallCommand(args);
```

and add to `USAGE`, after the `doctor` line:

```
  kerstel uninstall [--dry-run] [--yes] [--force]
                                                Restore every project and remove Kerstel
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/cli/test/uninstall.test.ts && bun run typecheck`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the full suite**

Run: `bun run test`
Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/uninstall.ts packages/cli/src/index.ts packages/cli/test/uninstall.test.ts
git commit -m "feat(cli): add kerstel uninstall"
```

---

### Task 9: End-to-end `init` then `uninstall` on the compiled binary

**Files:**
- Test: `packages/cli/test/e2e.test.ts`

**Interfaces:**
- Consumes: the compiled binary built by the suite's `beforeAll`, `uninstall --yes` (Task 8).

The binary deletes itself, so this test runs a COPY of `dist/kerstel` from a scratch directory. Running `dist/kerstel` directly would delete the build output every other e2e test uses.

- [ ] **Step 1: Write the test**

Append to `packages/cli/test/e2e.test.ts` (add `copyFileSync` and `chmodSync` to the `node:fs` import):

```ts
test("the binary uninstalls: the project gets its values back and Kerstel is gone", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-uninstall-"));
  const binDir = mkdtempSync(join(tmpdir(), "kerstel-e2e-uninstall-bin-"));
  const copy = join(binDir, "kerstel");
  copyFileSync(BINARY, copy);
  chmodSync(copy, 0o755);

  const project = mkdtempSync(join(tmpdir(), "kerstel-e2e-uninstall-project-"));
  const originalEnv = "# local secrets\nAPP_KEY=super-secret-uninstall\nPORT=3000\n";
  const originalPkg = `${JSON.stringify({ name: "e2e-uninstall", scripts: { start: "node app.js" } }, null, 2)}\n`;
  await Bun.write(join(project, "package.json"), originalPkg);
  await Bun.write(join(project, "package-lock.json"), "{}\n");
  await Bun.write(join(project, ".env"), originalEnv);

  const run = async (args: string[]) => {
    const proc = Bun.spawn([copy, ...args], { cwd: project, env: env(), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) console.error(stdout + stderr);
    return { stdout, code };
  };

  expect((await run(["init", "--yes", "--non-interactive", "--keep", "PORT"])).code).toBe(0);
  expect(await Bun.file(join(project, ".env")).text()).toContain("kerstel://e2e-uninstall/APP_KEY");

  const result = await run(["uninstall", "--yes"]);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("super-secret-uninstall");

  expect(await Bun.file(join(project, ".env")).text()).toBe(originalEnv);
  expect(await Bun.file(join(project, "package.json")).text()).toBe(originalPkg);
  expect(existsSync(home)).toBe(false);
  expect(existsSync(copy)).toBe(false);
});
```

The suite's `afterEach` runs `kerstel daemon stop` with `KERSTEL_HOME` pointing at a deleted home; that is harmless (it reports the daemon is not running).

- [ ] **Step 2: Run it**

Run: `bun test packages/cli/test/e2e.test.ts`
Expected: PASS. If it fails, the failure is a real bug in Tasks 6-8: fix it there, not in the test.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/e2e.test.ts
git commit -m "test(e2e): init then uninstall round-trips a project on the compiled binary"
```

---

### Task 10: Docs, changelog, and roadmap

**Files:**
- Modify: `README.md`, `apps/website/src/pages/docs/cli.md`, `CHANGELOG.md`, `ROADMAP.md`
- Regenerate: `docs/`

- [ ] **Step 1: README**

In `README.md`, in the Usage code block, add after the `kerstel doctor` line:

```
kerstel uninstall [--dry-run] [--yes]         # Restore every project, then remove Kerstel
kerstel --version                             # Print the version
```

Add a section right after "## Usage"'s closing paragraph and before "## Set up a project":

````markdown
## Install

```bash
curl -fsSL https://kerstel.dev/install.sh | bash
```

macOS and Linux, x64 and arm64. The installer verifies the release checksum and puts the binary at `~/.local/bin/kerstel`, without `sudo`. Re-run it to upgrade, or set `KERSTEL_VERSION=0.1.0` to pin a version.

To remove Kerstel, run `kerstel uninstall`. It rewrites every project's references back to their values, unwraps your scripts, and then deletes the vault, the key, and the binary. It refuses if a secret would be lost, and names it.
````

- [ ] **Step 2: CLI docs page**

In `apps/website/src/pages/docs/cli.md`, add rows to the "Daemon and diagnostics" table after the `kerstel doctor` row:

```markdown
| `kerstel --version` | Print the version, such as `0.1.0`. |
| `kerstel uninstall` | Remove Kerstel from this machine. For every project `init` set up, it rewrites each `kerstel://` reference to the value in the vault, unwraps the `package.json` scripts, and turns the `.gitignore` note back into `.env` and `.env.*` lines. Then it stops the daemon and deletes the vault key, `~/.kerstel`, and the binary. It shows every diff with values masked and asks once, defaulting to no. It refuses if a project folder is gone, a reference cannot be resolved, or a secret is used by no project, and names each one; save those with `get --reveal`, then pass `--force`. `--dry-run` prints the plan and changes nothing; `--yes` skips the question but never implies `--force`. |
```

- [ ] **Step 3: Changelog and roadmap**

In `CHANGELOG.md`, add to the 0.1.0 `### Added` list:

```markdown
- `kerstel --version`.
- `kerstel uninstall`, which restores every project's `.env` values, package scripts, and `.gitignore`, then removes the vault, the key, and the binary. It refuses, naming each one, if any secret would be lost.
- Release binaries for macOS and Linux (x64 and arm64), with SHA-256 checksums.
- `curl -fsSL https://kerstel.dev/install.sh | bash`, which verifies the checksum and installs to `~/.local/bin` without `sudo`.
```

In `ROADMAP.md`, tick `Release binaries for macOS and Linux, with checksums`, `Working install.sh`, and `kerstel uninstall...` in the 0.1.0 section.

- [ ] **Step 4: Rebuild and verify**

Run: `bun run --cwd apps/website build && bun run typecheck && bun run test`
Expected: 0 fail.

- [ ] **Step 5: Commit**

```bash
git add README.md apps/website CHANGELOG.md ROADMAP.md docs
git commit -m "docs: document install, --version, and uninstall for 0.1.0"
```

---

### Task 11: Rehearse the release (maintainer, after merge)

Not code. Done once the PR with Tasks 1-10 is merged and kerstel.dev serves the new `install.sh`.

- [ ] Push a pre-release tag: `git tag v0.1.0-rc.1 origin/main && git push origin v0.1.0-rc.1`.
- [ ] Watch `gh run watch` for the Release workflow. All jobs, including `installer`, must pass.
- [ ] On your own Mac: `curl -fsSL https://kerstel.dev/install.sh | KERSTEL_VERSION=0.1.0-rc.1 bash`, then `kerstel --version`.
- [ ] Delete the rehearsal: `gh release delete v0.1.0-rc.1 --cleanup-tag --yes`.
- [ ] Release for real, following `AGENTS.md` → "Releasing".
