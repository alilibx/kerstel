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
