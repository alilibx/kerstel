import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseFrontMatter, type FrontMatter } from "./frontmatter";

export interface Page {
  /** Path relative to the pages directory, POSIX separators, e.g. "docs/cli.md". */
  source: string;
  /** Output path relative to the output directory, e.g. "docs/cli.html". */
  outPath: string;
  /** Site URL, e.g. "/docs/cli" or "/". */
  url: string;
  meta: FrontMatter;
  body: string;
  /** Renders the body to HTML. Pages without one are rendered as plain Markdown. */
  renderBody?: (markdown: string) => string;
}

export function toOutPath(source: string): string {
  return source.replace(/\.md$/, ".html");
}

export function toUrl(source: string): string {
  const noExt = source.replace(/\.md$/, "");
  if (noExt === "index") return "/";
  if (noExt.endsWith("/index")) return "/" + noExt.slice(0, -"/index".length);
  return "/" + noExt;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

export function collectPages(pagesDir: string): Page[] {
  const sources = walk(pagesDir)
    .map((full) => relative(pagesDir, full).split(sep).join("/"))
    .sort();
  return sources.map((source) => {
    const { meta, body } = parseFrontMatter(readFileSync(join(pagesDir, source), "utf8"), source);
    return { source, outPath: toOutPath(source), url: toUrl(source), meta, body };
  });
}

/**
 * A Markdown file at the repo root, such as CHANGELOG.md, published as
 * /<slug>. These files live outside the pages directory so GitHub renders them
 * too, which is why they carry no front matter and get their meta here.
 */
export function rootPage(
  file: string,
  slug: string,
  meta: FrontMatter,
  renderBody?: (markdown: string) => string,
): Page {
  const page: Page = {
    source: `${slug}.md`,
    outPath: `${slug}.html`,
    url: `/${slug}`,
    meta,
    body: readFileSync(file, "utf8"),
  };
  if (renderBody) page.renderBody = renderBody;
  return page;
}
