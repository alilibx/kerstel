import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { RELEASE_MEDIA, formatReleaseDate, parseReleaseHeading, renderChangelog } from "../src/changelog";

const STATIC = resolve(import.meta.dir, "../src/static");

const sample = [
  "# Changelog",
  "",
  "All notable changes to Kerstel are listed here. Versions follow [Semantic Versioning](https://semver.org).",
  "",
  "## 0.1.1 (unreleased)",
  "",
  "## 0.1.0 (2026-09-19)",
  "",
  "The first release: a local-first secrets manager.",
  "",
  "### Added",
  "",
  "- Encrypted local vault at `~/.kerstel/vault.db`.",
  "- `kerstel set`, `get`, `ls`, and `rm`.",
  "",
  "### Fixed",
  "",
  "- Something that was broken.",
  "",
].join("\n");

const media = [{ version: "0.1.0", video: "/release-0.1.0.mp4", poster: "/release-0.1.0.jpg", caption: "The first release, in 22 seconds." }];

describe("parseReleaseHeading", () => {
  test("splits a released version from its date", () => {
    expect(parseReleaseHeading("0.1.0 (2026-09-19)")).toEqual({ version: "0.1.0", date: "2026-09-19" });
  });
  test("marks an unreleased version", () => {
    expect(parseReleaseHeading("0.1.1 (unreleased)")).toEqual({ version: "0.1.1", date: null });
  });
  test("returns null for a heading that is not a release", () => {
    expect(parseReleaseHeading("Something else")).toBeNull();
  });
});

describe("formatReleaseDate", () => {
  test("spells the month out, without depending on the locale", () => {
    expect(formatReleaseDate("2026-09-19")).toBe("19 September 2026");
    expect(formatReleaseDate("2027-01-02")).toBe("2 January 2027");
  });
});

describe("renderChangelog", () => {
  const html = renderChangelog(sample, media);

  test("keeps the page title and intro above the timeline, with the intro as the lede", () => {
    expect(html).toContain('<header class="page-head">');
    expect(html).toContain("<h1>Changelog</h1>");
    expect(html).toContain('<p class="lede">All notable changes to Kerstel are listed here.');
    expect(html.indexOf("<h1>")).toBeLessThan(html.indexOf('<ol class="timeline">'));
  });

  test("puts the latest release video above the timeline, with its poster and caption", () => {
    const figure = html.indexOf('<figure class="release-video">');
    expect(figure).toBeGreaterThan(-1);
    expect(figure).toBeLessThan(html.indexOf('<ol class="timeline">'));
    expect(html).toContain('poster="/release-0.1.0.jpg"');
    expect(html).toContain('<source src="/release-0.1.0.mp4" type="video/mp4">');
    expect(html).toContain("The first release, in 22 seconds.");
    expect(html).toContain('href="#0.1.0"');
  });

  test("renders every release as a timeline entry with an anchor, version, and date", () => {
    expect(html).toContain('<li class="release is-unreleased" id="0.1.1">');
    expect(html).toContain('<li class="release" id="0.1.0">');
    expect(html).toContain('<h2 class="release-version"><a href="#0.1.0">0.1.0</a></h2>');
    expect(html).toContain('<time class="release-date" datetime="2026-09-19">19 September 2026</time>');
    expect(html).toContain('<span class="release-date release-unreleased">Unreleased</span>');
  });

  test("lists releases newest first, as the changelog does", () => {
    expect(html.indexOf('id="0.1.1"')).toBeLessThan(html.indexOf('id="0.1.0"'));
  });

  test("groups changes by type with a class per type", () => {
    expect(html).toContain('<section class="change-group change-added"><h3 class="change-type">Added</h3>');
    expect(html).toContain('<section class="change-group change-fixed"><h3 class="change-type">Fixed</h3>');
    expect(html).toContain("<li>Encrypted local vault at <code>~/.kerstel/vault.db</code>.</li>");
  });

  test("keeps the release summary paragraph inside its entry", () => {
    const entry = html.slice(html.indexOf('id="0.1.0"'));
    expect(entry).toContain("<p>The first release: a local-first secrets manager.</p>");
  });

  test("says when an unreleased version has nothing yet and points at the roadmap", () => {
    const entry = html.slice(html.indexOf('id="0.1.1"'), html.indexOf('id="0.1.0"'));
    expect(entry).toContain('<p class="release-empty">Nothing yet. The <a href="/roadmap">roadmap</a> lists what is coming next.</p>');
  });

  test("renders no video when no release has media", () => {
    const bare = renderChangelog(sample, []);
    expect(bare).not.toContain("release-video");
    expect(bare).toContain('<ol class="timeline">');
  });

  test("attaches the video to the newest release that has media, not to an unreleased one", () => {
    const later = [{ version: "0.1.1", video: "/x.mp4", poster: "/x.jpg", caption: "Later" }, ...media];
    const out = renderChangelog(sample, later);
    // 0.1.1 is unreleased, so its media must not be promoted to the top of the page.
    expect(out).toContain('poster="/release-0.1.0.jpg"');
    expect(out).not.toContain('poster="/x.jpg"');
  });

  test("rejects a changelog whose sections are not release headings", () => {
    expect(() => renderChangelog("# Changelog\n\n## Not a version\n", [])).toThrow(/Not a version/);
  });
});

describe("RELEASE_MEDIA", () => {
  test("every referenced video and poster ships in static/", () => {
    expect(RELEASE_MEDIA.length).toBeGreaterThan(0);
    for (const m of RELEASE_MEDIA) {
      expect(existsSync(join(STATIC, m.video.slice(1))), `${m.video} missing`).toBe(true);
      expect(existsSync(join(STATIC, m.poster.slice(1))), `${m.poster} missing`).toBe(true);
      expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
