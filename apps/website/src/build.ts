import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { collectPages } from "./pages";
import { renderPage } from "./render";

export const SITE_URL = "https://kerstel.dev";

const SRC = resolve(import.meta.dir);

/** The GitHub Pages source directory at the repo root. */
export const DEFAULT_OUT = resolve(SRC, "../../../docs");

/** Top-level entries in the output directory the build never touches. */
const PRESERVE = new Set(["superpowers"]);

/** Files copied from src/ next to the rendered pages. */
const ASSETS = ["styles.css", "hero.js"];

export interface BuildOptions {
  outDir: string;
}

/** Removes everything in outDir except the preserved entries. Creates outDir if needed. */
export function cleanOutput(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const entry of readdirSync(outDir)) {
    if (PRESERVE.has(entry)) continue;
    rmSync(join(outDir, entry), { recursive: true, force: true });
  }
}

/** Renders every page and copies static files. Returns the page paths written, relative to outDir. */
export function build({ outDir }: BuildOptions): string[] {
  const layout = readFileSync(join(SRC, "layout.html"), "utf8");
  const pages = collectPages(join(SRC, "pages"));

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
