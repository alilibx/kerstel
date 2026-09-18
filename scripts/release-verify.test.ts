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
