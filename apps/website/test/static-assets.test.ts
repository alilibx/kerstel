import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");
const STATIC = join(SRC, "static");

/** Files build.ts copies next to the rendered pages from src/ itself. */
const COPIED_FROM_SRC = new Set(["/styles.css", "/hero.js"]);

/**
 * Every root-relative asset URL referenced from the layout or a page must
 * resolve to a real file, or the deployed site 404s it silently: nothing in
 * build or typecheck notices, and a broken og:image only shows up when
 * someone shares a link and the preview comes back blank.
 */
function localAssetUrls(html: string): string[] {
  const urls = new Set<string>();
  const attr = /(?:src|href|poster|content)="(?:https:\/\/kerstel\.dev)?(\/[^"]+)"/g;
  for (const match of html.matchAll(attr)) {
    const path = match[1];
    // Page routes (/docs, /security) have no extension; assets always do.
    if (!/\.[a-z0-9]+$/i.test(path)) continue;
    urls.add(path);
  }
  return [...urls];
}

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pageFiles(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

describe("static asset references", () => {
  const sources = [join(SRC, "layout.html"), ...pageFiles(join(SRC, "pages"))];

  for (const source of sources) {
    test(`every asset referenced by ${source.slice(SRC.length + 1)} exists`, () => {
      const html = readFileSync(source, "utf8");
      for (const url of localAssetUrls(html)) {
        if (COPIED_FROM_SRC.has(url)) {
          expect(existsSync(join(SRC, url.slice(1)))).toBe(true);
        } else {
          expect(existsSync(join(STATIC, url.slice(1)))).toBe(true);
        }
      }
    });
  }
});
