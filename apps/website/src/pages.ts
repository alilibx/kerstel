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
 * The repo-root CHANGELOG.md, published as /changelog. It lives outside the
 * pages directory so GitHub renders it too, which is why it carries no front
 * matter and gets its meta here.
 */
export function changelogPage(file: string): Page {
  return {
    source: "changelog.md",
    outPath: "changelog.html",
    url: "/changelog",
    meta: { title: "Changelog", description: "Every Kerstel release and what changed in it." },
    body: readFileSync(file, "utf8"),
  };
}
