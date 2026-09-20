import { marked, type Token, type Tokens } from "marked";
import { escapeHtml } from "./render";

/**
 * A release video published on the changelog page. The newest released
 * version that has one is shown above the timeline; the files live in
 * `src/static/` and are copied to the site root by the build.
 */
export interface ReleaseMedia {
  version: string;
  /** Site-root path of the MP4, e.g. "/release-0.1.0.mp4". */
  video: string;
  /** Site-root path of the poster frame, e.g. "/release-0.1.0.jpg". */
  poster: string;
  /** One line shown under the video. */
  caption: string;
}

export const RELEASE_MEDIA: ReleaseMedia[] = [
  {
    version: "0.1.0",
    video: "/release-0.1.0.mp4",
    poster: "/release-0.1.0.jpg",
    caption: "The first release, in 22 seconds.",
  },
];

export interface ReleaseHeading {
  version: string;
  /** ISO date, or null for an unreleased section. */
  date: string | null;
}

/**
 * "0.1.0 (2026-09-19)", "0.1.1 (unreleased)", or a pre-release such as
 * "0.2.0-rc.1 (2026-10-01)". Kept at least as permissive as the version match
 * in scripts/release-verify.ts, so a heading that passes release verification
 * never fails the site build.
 */
const HEADING = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)\s+\((unreleased|\d{4}-\d{2}-\d{2})\)$/;

/** Parses a release heading. Null for anything else. */
export function parseReleaseHeading(text: string): ReleaseHeading | null {
  const m = HEADING.exec(text.trim());
  if (!m) return null;
  const [, version, when] = m;
  return { version: version!, date: when === "unreleased" ? null : when! };
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-09-19" → "19 September 2026". No locale, so the build is byte-stable everywhere. */
export function formatReleaseDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const month = m === undefined ? undefined : MONTHS[m - 1];
  if (y === undefined || d === undefined || !month || d < 1 || d > 31) {
    throw new Error(`CHANGELOG.md: "${iso}" is not a date like 2026-09-19`);
  }
  return `${d} ${month} ${y}`;
}

interface Release extends ReleaseHeading {
  /** Tokens between this release heading and the next. */
  tokens: Token[];
}

function render(tokens: Token[]): string {
  return marked.parser(tokens).trim();
}

/** Splits the changelog into the intro (everything before the first h2) and one entry per h2. */
function splitReleases(markdown: string): { intro: Token[]; releases: Release[] } {
  const tokens = marked.lexer(markdown);
  const intro: Token[] = [];
  const releases: Release[] = [];
  let current: Release | null = null;
  for (const token of tokens) {
    if (token.type === "heading" && (token as Tokens.Heading).depth === 2) {
      const text = (token as Tokens.Heading).text;
      const heading = parseReleaseHeading(text);
      if (!heading) throw new Error(`CHANGELOG.md: "${text}" is not a release heading like "0.1.0 (2026-09-19)"`);
      current = { ...heading, tokens: [] };
      releases.push(current);
    } else if (current) {
      current.tokens.push(token);
    } else {
      intro.push(token);
    }
  }
  return { intro, releases };
}

/**
 * Renders a release body, wrapping each "### Added" style group in a section
 * classed by type so the stylesheet can colour the marker.
 */
function renderBody(release: Release): string {
  if (release.tokens.every((t) => t.type === "space")) {
    return '<p class="release-empty">Nothing yet. The <a href="/roadmap">roadmap</a> lists what is coming next.</p>';
  }
  const parts: string[] = [];
  let group: { type: string; tokens: Token[] } | null = null;
  const flush = () => {
    if (!group) return;
    const slug = group.type.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    parts.push(
      `<section class="change-group change-${slug}"><h3 class="change-type">${escapeHtml(group.type)}</h3>${render(group.tokens)}</section>`,
    );
    group = null;
  };
  const loose: Token[] = [];
  for (const token of release.tokens) {
    if (token.type === "heading" && (token as Tokens.Heading).depth === 3) {
      if (loose.length) {
        parts.push(render(loose));
        loose.length = 0;
      }
      flush();
      group = { type: (token as Tokens.Heading).text, tokens: [] };
    } else if (group) {
      group.tokens.push(token);
    } else {
      loose.push(token);
    }
  }
  if (loose.length) parts.push(render(loose));
  flush();
  return parts.filter(Boolean).join("\n");
}

function renderVideo(release: Release, media: ReleaseMedia): string {
  return [
    '<figure class="release-video">',
    `<video controls playsinline preload="metadata" poster="${escapeHtml(media.poster)}" width="1920" height="1080" aria-label="Kerstel ${escapeHtml(release.version)} release video">`,
    `<source src="${escapeHtml(media.video)}" type="video/mp4">`,
    "</video>",
    "<figcaption>",
    `<span class="release-pill">${escapeHtml(release.version)}</span>`,
    `<span>${escapeHtml(media.caption)}</span>`,
    `<a href="#${escapeHtml(release.version)}">Read the notes</a>`,
    "</figcaption>",
    "</figure>",
  ].join("\n");
}

/** Counts the changes in a release: one per list item, across every group. */
function countChanges(release: Release): number {
  let count = 0;
  for (const token of release.tokens) {
    if (token.type === "list") count += (token as Tokens.List).items.length;
  }
  return count;
}

function renderRelease(release: Release, latest: boolean): string {
  const id = escapeHtml(release.version);
  const empty = release.tokens.every((t) => t.type === "space");
  const when = release.date
    ? `<time class="release-date" datetime="${release.date}">${formatReleaseDate(release.date)}</time>`
    : '<span class="release-date release-unreleased">In development</span>';
  const body = `<div class="release-body">\n${renderBody(release)}\n</div>`;

  // An unreleased section with content collapses behind a disclosure, so the
  // draft never outranks the release people can install. The heading stays
  // outside the <summary>: a summary exposes as a button, which would strip
  // the version from the heading outline.
  let bodyHtml = body;
  if (!release.date && !empty) {
    const changes = countChanges(release);
    const label = changes > 0 ? `${changes} ${changes === 1 ? "change" : "changes"}` : "Show the notes";
    bodyHtml = [
      '<details class="release-details">',
      `<summary><span class="release-count">${label}</span></summary>`,
      body,
      "</details>",
    ].join("\n");
  }

  return [
    `<li class="release${release.date ? "" : " is-unreleased"}" id="${id}">`,
    '<span class="release-marker" aria-hidden="true"></span>',
    '<div class="release-head">',
    `<h2 class="release-version"><a href="#${id}">${id}</a></h2>`,
    latest ? '<span class="release-pill release-latest">Latest</span>' : "",
    when,
    "</div>",
    bodyHtml,
    "</li>",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Renders CHANGELOG.md as a timeline: the page head, then the newest released
 * version's video (if it has one), then one entry per release, newest first,
 * in the order the file lists them.
 */
export function renderChangelog(markdown: string, media: ReleaseMedia[] = RELEASE_MEDIA): string {
  const { intro, releases } = splitReleases(markdown);

  const head = render(intro);

  const featured = releases.find((r) => r.date !== null && media.some((m) => m.version === r.version));
  const video = featured ? renderVideo(featured, media.find((m) => m.version === featured.version)!) : "";

  const latest = releases.find((r) => r.date !== null);
  return [
    `<header class="page-head">\n${head}\n</header>`,
    video,
    `<ol class="timeline">\n${releases.map((r) => renderRelease(r, r === latest)).join("\n")}\n</ol>`,
  ]
    .filter(Boolean)
    .join("\n");
}
