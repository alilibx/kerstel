import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { renderChangelog } from "./changelog";
import { collectPages, rootPage, type Page } from "./pages";
import { renderPage } from "./render";

export const SITE_URL = "https://kerstel.dev";

const SRC = resolve(import.meta.dir);

/** The GitHub Pages source directory at the repo root. */
export const DEFAULT_OUT = resolve(SRC, "../../../docs");

/** Root of the whole repository, computed the same way DEFAULT_OUT is. */
export const REPO_ROOT = resolve(SRC, "../../..");

/** Top-level entries in the output directory the build never touches. */
const PRESERVE = new Set(["superpowers"]);

/** Files copied from src/ next to the rendered pages. */
const ASSETS = ["styles.css", "hero.js"];

export interface BuildOptions {
  outDir: string;
}

/**
 * Decides whether outDir is safe to clean, without touching the filesystem
 * beyond the package.json check. A separate, exported, pure-ish predicate so
 * it can be unit-tested against every boundary case directly, including
 * DEFAULT_OUT itself, without actually deleting anything.
 *
 * Refuses two shapes of bad `--out` value: a directory that holds a
 * `package.json` (looks like a source tree, in or out of this repo), and any
 * directory that is inside this repository but is not `docs/` -- that covers
 * both an ancestor of `src` (`packages/cli/src`) and a descendant of it
 * (`src/pages`), which a plain ancestor-of-SRC check would miss.
 */
export function assertSafeOutDir(outDir: string): void {
  if (existsSync(join(outDir, "package.json"))) {
    throw new Error(`refusing to clean ${outDir}: it contains a package.json, which looks like a source tree`);
  }
  const resolved = resolve(outDir);
  const rel = relative(REPO_ROOT, resolved);
  const insideRepo = rel === "" || !rel.startsWith("..");
  if (insideRepo && resolved !== DEFAULT_OUT) {
    throw new Error(`refusing to clean ${outDir}: inside the repository but not docs/`);
  }
}

/**
 * Removes everything in outDir except the preserved entries. Creates outDir
 * if needed.
 */
export function cleanOutput(outDir: string): void {
  assertSafeOutDir(outDir);

  mkdirSync(outDir, { recursive: true });
  for (const entry of readdirSync(outDir)) {
    if (PRESERVE.has(entry)) continue;
    rmSync(join(outDir, entry), { recursive: true, force: true });
  }
}

/** Repo-root Markdown files published as site pages. */
function rootPages(): Page[] {
  return [
    rootPage(
      join(REPO_ROOT, "CHANGELOG.md"),
      "changelog",
      { title: "Changelog", description: "Every Kerstel release and what changed in it." },
      renderChangelog,
    ),
    rootPage(join(REPO_ROOT, "ROADMAP.md"), "roadmap", {
      title: "Roadmap",
      description: "What Kerstel ships next, release by release.",
    }),
  ];
}

/** Renders every page and copies static files. Returns the page paths written, relative to outDir. */
export function build({ outDir }: BuildOptions): string[] {
  const layout = readFileSync(join(SRC, "layout.html"), "utf8");
  const pages = [...collectPages(join(SRC, "pages")), ...rootPages()];

  cleanOutput(outDir);

  const written: string[] = [];
  for (const page of pages) {
    const html = renderPage({ page, pages, layout, siteUrl: SITE_URL });
    const target = join(outDir, page.outPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html);
    written.push(page.outPath);
  }

  cpSync(join(SRC, "static"), outDir, { recursive: true });
  for (const asset of ASSETS) {
    cpSync(join(SRC, asset), join(outDir, asset));
  }
  return written;
}
