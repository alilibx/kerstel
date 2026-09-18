import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { DEFAULT_OUT, REPO_ROOT, assertSafeOutDir, build, cleanOutput } from "../src/build";

/** Every page the site must ship. Later tasks append to this list. */
const EXPECTED_PAGES = [
  "index.html",
  "security.html",
  "docs/index.html",
  "docs/getting-started.html",
  "docs/cli.html",
  "docs/how-it-works.html",
  "docs/teams.html",
  "changelog.html",
];

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
        else if (!extname(path)) path = existsSync(join(out, `${path}.html`)) ? `${path}.html` : `${path}/index.html`;
        expect(existsSync(join(out, path)), `${file} links to ${url} but ${path} does not exist`).toBe(true);
      }
    }
  });

  test("docs pages share the docs navigation in a fixed order", () => {
    const expectedOrder = ["/docs/getting-started", "/docs/cli", "/docs/how-it-works", "/docs/teams"];
    for (const file of ["docs/getting-started.html", "docs/cli.html", "docs/how-it-works.html", "docs/teams.html"]) {
      const html = readFileSync(join(out, file), "utf8");
      const hrefs = [...html.matchAll(/<nav class="docs-nav"[\s\S]*?<\/nav>/g)][0]?.[0] ?? "";
      const order = [...hrefs.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(order, file).toEqual(expectedOrder);
      expect(hrefs, file).toContain('aria-current="page"');
    }
    const index = readFileSync(join(out, "docs/index.html"), "utf8");
    expect(index).not.toContain('class="docs-nav"');
  });

  test("landing page carries the hero, install command, and section links", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain('id="hero-val"');
    expect(html).toContain("curl -fsSL https://kerstel.dev/install.sh | bash");
    expect(html).toContain('href="/security"');
    expect(html).toContain('href="/docs/getting-started"');
    expect(html).not.toContain("version-badge");
    expect(html).not.toContain("api.github.com");
  });

  test("changelog page renders the repo-root CHANGELOG.md and is linked from every page", () => {
    const changelog = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const version = changelog.match(/^## (\d+\.\d+\.\d+)/m)?.[1];
    expect(version).toBeDefined();
    const html = readFileSync(join(out, "changelog.html"), "utf8");
    expect(html).toContain(`<h2>${version}`);
    for (const file of htmlFiles) {
      expect(readFileSync(join(out, file), "utf8"), file).toContain('href="/changelog"');
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

  test("cleanOutput refuses a directory that contains a package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "kerstel-guard-"));
    writeFileSync(join(dir, "package.json"), "{}");
    expect(() => cleanOutput(dir)).toThrow(/package\.json/);
  });

  test("assertSafeOutDir accepts the real docs/ output directory", () => {
    expect(() => assertSafeOutDir(DEFAULT_OUT)).not.toThrow();
  });

  test("assertSafeOutDir refuses an in-repo ancestor of src, like packages/cli/src", () => {
    const target = resolve(REPO_ROOT, "packages", "cli", "src");
    expect(() => assertSafeOutDir(target)).toThrow(/inside the repository/);
  });

  test("assertSafeOutDir refuses an in-repo descendant of src, like src/pages", () => {
    const target = resolve(import.meta.dir, "..", "src", "pages");
    expect(() => assertSafeOutDir(target)).toThrow(/inside the repository/);
  });

  test("assertSafeOutDir accepts a tmp directory outside the repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "kerstel-outdir-"));
    expect(() => assertSafeOutDir(dir)).not.toThrow();
  });

  test("cleanOutput refuses a directory that is this package's own src tree", () => {
    const websiteDir = resolve(import.meta.dir, "..");
    // websiteDir also has its own package.json, so either guard is enough to
    // refuse it; what matters is that it refuses, never that it deletes.
    expect(() => cleanOutput(websiteDir)).toThrow(/source tree/);
  });
});
