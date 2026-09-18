import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { build } from "../src/build";

/** Every page the site must ship. Later tasks append to this list. */
const EXPECTED_PAGES = ["index.html"];

const FORBIDDEN = [/menu bar/i, /macOS 14/i, /AI usage/i, /system metrics/i, /\bports\b/i];

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

let out: string;
let htmlFiles: string[];

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "kerstel-site-"));
  build({ outDir: out });
  htmlFiles = listFiles(out).filter((f) => f.endsWith(".html"));
});

describe("build output", () => {
  test("writes every expected page", () => {
    for (const p of EXPECTED_PAGES) {
      expect(existsSync(join(out, p)), `${p} missing`).toBe(true);
    }
  });

  test("ships CNAME, .nojekyll, the stylesheet, the hero script, and install.sh", () => {
    for (const f of ["CNAME", ".nojekyll", "styles.css", "hero.js", "install.sh", "favicon-32.png"]) {
      expect(existsSync(join(out, f)), `${f} missing`).toBe(true);
    }
    expect(readFileSync(join(out, "CNAME"), "utf8").trim()).toBe("kerstel.dev");
  });

  test("every internal link and asset reference resolves to an output file", () => {
    const LINK = /\b(?:href|src)="(\/[^"#?]*)/g;
    for (const file of htmlFiles) {
      const html = readFileSync(join(out, file), "utf8");
      for (const m of html.matchAll(LINK)) {
        const url = m[1]!;
        let path = url === "/" ? "index.html" : url.slice(1);
        if (path.endsWith("/")) path += "index.html";
        else if (!extname(path)) path += ".html";
        expect(existsSync(join(out, path)), `${file} links to ${url} but ${path} does not exist`).toBe(true);
      }
    }
  });

  test("no page mentions the retired product", () => {
    for (const file of htmlFiles) {
      const html = readFileSync(join(out, file), "utf8");
      for (const re of FORBIDDEN) {
        expect(re.test(html), `${file} matches ${re}`).toBe(false);
      }
    }
  });

  test("every page has a title, description, canonical, and stylesheet", () => {
    for (const file of htmlFiles) {
      const html = readFileSync(join(out, file), "utf8");
      expect(html, file).toMatch(/<title>[^<]+<\/title>/);
      expect(html, file).toMatch(/<meta name="description" content="[^"]+">/);
      expect(html, file).toMatch(/<link rel="canonical" href="https:\/\/kerstel\.dev\/[^"]*">/);
      expect(html, file).toContain('<link rel="stylesheet" href="/styles.css">');
    }
  });

  test("building twice is byte-identical", () => {
    const again = mkdtempSync(join(tmpdir(), "kerstel-site-"));
    build({ outDir: again });
    const a = listFiles(out);
    expect(listFiles(again)).toEqual(a);
    for (const f of a) {
      expect(readFileSync(join(again, f)).equals(readFileSync(join(out, f))), `${f} differs between builds`).toBe(true);
    }
  });

  test("cleaning preserves the superpowers directory and removes everything else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kerstel-clean-"));
    await Bun.write(join(dir, "superpowers", "keep.md"), "keep");
    await Bun.write(join(dir, "stale.html"), "old");
    await Bun.write(join(dir, "old", "deep.txt"), "old");
    build({ outDir: dir });
    expect(existsSync(join(dir, "superpowers", "keep.md"))).toBe(true);
    expect(existsSync(join(dir, "stale.html"))).toBe(false);
    expect(existsSync(join(dir, "old"))).toBe(false);
    expect(existsSync(join(dir, "index.html"))).toBe(true);
  });
});
