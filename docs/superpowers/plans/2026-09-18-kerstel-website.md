# Kerstel Website (kerstel.dev) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stale menu-bar landing page at kerstel.dev with a six-page static site for the secrets manager, generated from Markdown by a small Bun script into `docs/`, with CI refusing stale output.

**Architecture:** A new workspace package `apps/website` holds one HTML layout, one stylesheet, one hero script, Markdown pages with front matter, and static assets. `build.ts` renders every page through the layout with `marked` and writes the result into `docs/`, which remains the GitHub Pages source (`main:/docs`, custom domain `kerstel.dev`). Output is committed. A CI job rebuilds and fails on a dirty `docs/` diff.

**Tech Stack:** TypeScript on Bun 1.3, `marked` (only dependency), `bun:test`, plain CSS and a dependency-free hero script. GitHub Pages legacy build, unchanged.

**Spec:** [`docs/superpowers/specs/2026-09-18-kerstel-website-design.md`](../specs/2026-09-18-kerstel-website-design.md)

**Scope:** Plan 4 of 5. Implements the website spec in full. Out of scope: real binaries and a working `install.sh` (plan 5), `kerstel init` docs beyond one sentence (plan 2 updates Getting Started when it lands), a changelog widget (returns with plan 5).

## Global Constraints

- **Toolchain:** Bun 1.3.10 is the only tool. No bundler, no framework. `marked` is the single dependency of `apps/website`.
- **Output location:** the generator writes to `docs/`. It deletes everything in `docs/` except the `superpowers/` directory before writing. `CNAME` and `.nojekyll` are regenerated from `apps/website/src/static/`.
- **Idempotence:** building twice yields byte-identical output. No timestamps, no random IDs in output.
- **URLs:** internal links are extension-less absolute paths (`/docs/cli`, `/security`). GitHub Pages resolves `/docs/cli` to `docs/cli.html` and `/docs` to `docs/index.html`.
- **Install command:** `curl -fsSL https://kerstel.dev/install.sh | bash`, verbatim. `install.sh` stays the stub that prints "Kerstel is being rebuilt as a local-first secrets manager." and exits 1 until plan 5.
- **Forbidden copy:** no output page may contain `menu bar`, `macOS 14`, `AI usage`, `system metrics`, or the standalone word `ports` (case-insensitive). The test enforces this.
- **Brand:** background `#202124`, surface `#292a2d`, surface border `#35363a`, text `#ececef`, secondary text `#8b8b8e`, accent `#4ade80`. System sans for prose, mono for commands and references. Colors live as CSS variables on `:root`.
- **Motion:** the hero animation is disabled under `prefers-reduced-motion: reduce`; the card then shows the final `kerstel://` state.
- **Mobile:** 16px gutters, no horizontal scroll at 375px wide.
- **Copy style:** rewritten for the web, not pasted from the README. Present tense, second person, no em dashes.
- **Commits:** Conventional Commits, one per task, on the current branch (never on `main`).

---

### Task 1: Workspace scaffold and front matter parser

**Files:**
- Create: `apps/website/package.json`
- Create: `apps/website/tsconfig.json`
- Create: `apps/website/src/frontmatter.ts`
- Create: `apps/website/test/frontmatter.test.ts`
- Modify: `package.json` (root) — `workspaces`
- Modify: `bun.lock` (via `bun install`)

**Interfaces:**
- Produces: `parseFrontMatter(source: string, file: string): ParsedPage` where `ParsedPage = { meta: FrontMatter; body: string }` and `FrontMatter = { title: string; description: string; section?: string; order?: number }`. Throws `Error` with the file name on a missing fence, a missing `title` or `description`, a line without `:`, or a non-integer `order`.

- [ ] **Step 1: Create the package**

`apps/website/package.json`:

```json
{
  "name": "@kerstel/website",
  "version": "0.0.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "scripts": {
    "build": "bun run build.ts",
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

`apps/website/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["build.ts", "src", "test"]
}
```

- [ ] **Step 2: Register the workspace and add `marked`**

In the root `package.json`, change `"workspaces": ["packages/*"]` to `"workspaces": ["packages/*", "apps/*"]`.

Run from the repo root:

```bash
bun install
bun add --cwd apps/website marked
```

Expected: `apps/website/package.json` gains a `dependencies.marked` entry and `bun.lock` changes. Confirm with `git status --short`; both files are modified.

- [ ] **Step 3: Write the failing front matter tests**

`apps/website/test/frontmatter.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseFrontMatter } from "../src/frontmatter";

const doc = [
  "---",
  "title: Getting started",
  "description: Install Kerstel, store a secret, run your app.",
  "section: docs",
  "order: 1",
  "---",
  "",
  "# Getting started",
  "",
  "Body text with a colon: still body.",
].join("\n");

describe("parseFrontMatter", () => {
  test("splits meta from body", () => {
    const { meta, body } = parseFrontMatter(doc, "docs/getting-started.md");
    expect(meta).toEqual({
      title: "Getting started",
      description: "Install Kerstel, store a secret, run your app.",
      section: "docs",
      order: 1,
    });
    expect(body).toBe("\n# Getting started\n\nBody text with a colon: still body.");
  });

  test("section and order are optional", () => {
    const { meta } = parseFrontMatter("---\ntitle: T\ndescription: D\n---\nbody", "x.md");
    expect(meta).toEqual({ title: "T", description: "D" });
  });

  test("accepts CRLF line endings", () => {
    const { meta, body } = parseFrontMatter("---\r\ntitle: T\r\ndescription: D\r\n---\r\nbody", "x.md");
    expect(meta.title).toBe("T");
    expect(body).toBe("body");
  });

  test("rejects a file without a fence", () => {
    expect(() => parseFrontMatter("# no fence", "bad.md")).toThrow("bad.md: missing front matter fence");
  });

  test("rejects an unclosed fence", () => {
    expect(() => parseFrontMatter("---\ntitle: T\n", "bad.md")).toThrow("bad.md: front matter never closed");
  });

  test("rejects a missing title or description", () => {
    expect(() => parseFrontMatter("---\ndescription: D\n---\n", "bad.md")).toThrow("bad.md: front matter needs a title");
    expect(() => parseFrontMatter("---\ntitle: T\n---\n", "bad.md")).toThrow("bad.md: front matter needs a description");
  });

  test("rejects a non-integer order", () => {
    expect(() => parseFrontMatter("---\ntitle: T\ndescription: D\norder: first\n---\n", "bad.md")).toThrow(
      'bad.md: order must be an integer, got "first"',
    );
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
bun test apps/website/test/frontmatter.test.ts
```

Expected: FAIL, `Cannot find module "../src/frontmatter"`.

- [ ] **Step 5: Implement the parser**

`apps/website/src/frontmatter.ts`:

```ts
export interface FrontMatter {
  title: string;
  description: string;
  /** Pages with section "docs" appear in the docs sub-navigation. */
  section?: string;
  /** Sort key within a section. */
  order?: number;
}

export interface ParsedPage {
  meta: FrontMatter;
  body: string;
}

const FENCE = "---";

/**
 * Splits a Markdown page into front matter and body.
 * Front matter is a `---` fenced block of flat `key: value` lines. No nesting,
 * no quoting, no YAML. `file` is used only for error messages.
 */
export function parseFrontMatter(source: string, file: string): ParsedPage {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== FENCE) {
    throw new Error(`${file}: missing front matter fence on line 1`);
  }
  const end = lines.indexOf(FENCE, 1);
  if (end === -1) {
    throw new Error(`${file}: front matter never closed`);
  }

  const raw: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) throw new Error(`${file}: bad front matter line "${line}"`);
    raw[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const { title, description, section, order } = raw;
  if (!title) throw new Error(`${file}: front matter needs a title`);
  if (!description) throw new Error(`${file}: front matter needs a description`);

  const meta: FrontMatter = { title, description };
  if (section) meta.section = section;
  if (order !== undefined) {
    const n = Number(order);
    if (!Number.isInteger(n)) throw new Error(`${file}: order must be an integer, got "${order}"`);
    meta.order = n;
  }

  return { meta, body: lines.slice(end + 1).join("\n") };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
bun test apps/website/test/frontmatter.test.ts
```

Expected: 7 pass, 0 fail.

- [ ] **Step 7: Typecheck the new package**

```bash
bun run --cwd apps/website typecheck
```

Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock apps/website
git commit -m "feat(website): scaffold apps/website workspace with front matter parser"
```

---

### Task 2: Page discovery and URL mapping

**Files:**
- Create: `apps/website/src/pages.ts`
- Create: `apps/website/test/pages.test.ts`

**Interfaces:**
- Consumes: `parseFrontMatter` from Task 1.
- Produces: `interface Page { source: string; outPath: string; url: string; meta: FrontMatter; body: string }`, `toOutPath(source: string): string`, `toUrl(source: string): string`, `collectPages(pagesDir: string): Page[]` (sorted by `source`).

- [ ] **Step 1: Write the failing tests**

`apps/website/test/pages.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPages, toOutPath, toUrl } from "../src/pages";

describe("toUrl", () => {
  test("maps index files to directory URLs", () => {
    expect(toUrl("index.md")).toBe("/");
    expect(toUrl("docs/index.md")).toBe("/docs");
  });
  test("maps other files to extension-less paths", () => {
    expect(toUrl("security.md")).toBe("/security");
    expect(toUrl("docs/cli.md")).toBe("/docs/cli");
  });
});

describe("toOutPath", () => {
  test("swaps .md for .html and keeps the directory", () => {
    expect(toOutPath("index.md")).toBe("index.html");
    expect(toOutPath("docs/cli.md")).toBe("docs/cli.html");
  });
});

describe("collectPages", () => {
  test("walks nested directories, parses each page, sorts by source", () => {
    const dir = mkdtempSync(join(tmpdir(), "kerstel-pages-"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "index.md"), "---\ntitle: Home\ndescription: H\n---\nhome");
    writeFileSync(join(dir, "docs", "cli.md"), "---\ntitle: CLI\ndescription: C\nsection: docs\norder: 2\n---\ncli");
    writeFileSync(join(dir, "docs", "notes.txt"), "ignored");

    const pages = collectPages(dir);
    expect(pages.map((p) => p.source)).toEqual(["docs/cli.md", "index.md"]);
    expect(pages[0]).toMatchObject({ url: "/docs/cli", outPath: "docs/cli.html", body: "cli" });
    expect(pages[0]?.meta).toEqual({ title: "CLI", description: "C", section: "docs", order: 2 });
    expect(pages[1]).toMatchObject({ url: "/", outPath: "index.html" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test apps/website/test/pages.test.ts
```

Expected: FAIL, `Cannot find module "../src/pages"`.

- [ ] **Step 3: Implement page discovery**

`apps/website/src/pages.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test apps/website/test/pages.test.ts
```

Expected: 4 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add apps/website/src/pages.ts apps/website/test/pages.test.ts
git commit -m "feat(website): discover Markdown pages and map them to URLs"
```

---

### Task 3: Renderer with layout slots and docs navigation

**Files:**
- Create: `apps/website/src/render.ts`
- Create: `apps/website/test/render.test.ts`

**Interfaces:**
- Consumes: `Page` from Task 2.
- Produces: `escapeHtml(s: string): string`, `docsNav(pages: Page[], current: Page): string` (empty string unless `current.meta.section === "docs"`), `renderPage(input: { page: Page; pages: Page[]; layout: string; siteUrl: string }): string`. Layout slots: `{{title}}`, `{{description}}`, `{{canonical}}`, `{{nav}}`, `{{content}}`. An unknown slot throws.

- [ ] **Step 1: Write the failing tests**

`apps/website/test/render.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Page } from "../src/pages";
import { docsNav, escapeHtml, renderPage } from "../src/render";

function page(overrides: Partial<Page> & Pick<Page, "url">): Page {
  return {
    source: "x.md",
    outPath: "x.html",
    meta: { title: "X", description: "D" },
    body: "",
    ...overrides,
  };
}

const home = page({ url: "/", source: "index.md", outPath: "index.html", meta: { title: "Kerstel", description: "Home" } });
const cli = page({ url: "/docs/cli", meta: { title: "CLI reference", description: "C", section: "docs", order: 2 } });
const start = page({ url: "/docs/getting-started", meta: { title: "Getting started", description: "G", section: "docs", order: 1 } });
const security = page({ url: "/security", meta: { title: "Security model", description: "S" } });
const all = [home, cli, start, security];

const layout = "<title>{{title}}</title><meta content=\"{{description}}\"><link href=\"{{canonical}}\">{{nav}}<main>{{content}}</main>";

describe("escapeHtml", () => {
  test("escapes the four characters that matter in attributes and text", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

describe("docsNav", () => {
  test("is empty outside the docs section", () => {
    expect(docsNav(all, home)).toBe("");
    expect(docsNav(all, security)).toBe("");
  });
  test("lists docs pages by order and marks the current one", () => {
    const nav = docsNav(all, cli);
    expect(nav).toBe(
      '<nav class="docs-nav" aria-label="Docs"><ul>' +
        '<li><a href="/docs/getting-started">Getting started</a></li>' +
        '<li><a href="/docs/cli" aria-current="page">CLI reference</a></li>' +
        "</ul></nav>",
    );
  });
});

describe("renderPage", () => {
  test("fills every slot and renders Markdown", () => {
    const html = renderPage({
      page: { ...cli, body: "# CLI\n\nRun `kerstel ls`." },
      pages: all,
      layout,
      siteUrl: "https://kerstel.dev",
    });
    expect(html).toContain("<title>CLI reference · Kerstel</title>");
    expect(html).toContain('<meta content="C">');
    expect(html).toContain('<link href="https://kerstel.dev/docs/cli">');
    expect(html).toContain('aria-current="page">CLI reference</a>');
    expect(html).toContain("<h1>CLI</h1>");
    expect(html).toContain("<code>kerstel ls</code>");
  });

  test("home page uses its own title and a trailing-slash canonical", () => {
    const html = renderPage({ page: home, pages: all, layout, siteUrl: "https://kerstel.dev" });
    expect(html).toContain("<title>Kerstel</title>");
    expect(html).toContain('<link href="https://kerstel.dev/">');
  });

  test("passes raw HTML blocks through untouched", () => {
    const html = renderPage({
      page: { ...home, body: '<section class="hero">\n<h1>Kerstel</h1>\n</section>' },
      pages: all,
      layout,
      siteUrl: "https://kerstel.dev",
    });
    expect(html).toContain('<section class="hero">\n<h1>Kerstel</h1>\n</section>');
  });

  test("escapes title and description", () => {
    const html = renderPage({
      page: { ...security, meta: { title: "A & B", description: '"quoted"' } },
      pages: all,
      layout,
      siteUrl: "https://kerstel.dev",
    });
    expect(html).toContain("<title>A &amp; B · Kerstel</title>");
    expect(html).toContain('<meta content="&quot;quoted&quot;">');
  });

  test("throws on an unknown slot", () => {
    expect(() => renderPage({ page: home, pages: all, layout: "{{bogus}}", siteUrl: "https://kerstel.dev" })).toThrow(
      "layout uses unknown slot {{bogus}}",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test apps/website/test/render.test.ts
```

Expected: FAIL, `Cannot find module "../src/render"`.

- [ ] **Step 3: Implement the renderer**

`apps/website/src/render.ts`:

```ts
import { marked } from "marked";
import type { Page } from "./pages";

export interface RenderInput {
  page: Page;
  pages: Page[];
  layout: string;
  siteUrl: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Sub-navigation for the docs section. Empty for every other page. */
export function docsNav(pages: Page[], current: Page): string {
  if (current.meta.section !== "docs") return "";
  const docs = pages
    .filter((p) => p.meta.section === "docs")
    .sort((a, b) => (a.meta.order ?? 0) - (b.meta.order ?? 0));
  const items = docs
    .map((p) => {
      const cur = p.url === current.url ? ' aria-current="page"' : "";
      return `<li><a href="${p.url}"${cur}>${escapeHtml(p.meta.title)}</a></li>`;
    })
    .join("");
  return `<nav class="docs-nav" aria-label="Docs"><ul>${items}</ul></nav>`;
}

export function renderPage({ page, pages, layout, siteUrl }: RenderInput): string {
  const content = marked.parse(page.body, { async: false, gfm: true });
  const isHome = page.url === "/";
  const slots: Record<string, string> = {
    title: escapeHtml(isHome ? page.meta.title : `${page.meta.title} · Kerstel`),
    description: escapeHtml(page.meta.description),
    canonical: isHome ? `${siteUrl}/` : `${siteUrl}${page.url}`,
    nav: docsNav(pages, page),
    content,
  };
  return layout.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = slots[key];
    if (value === undefined) throw new Error(`layout uses unknown slot {{${key}}}`);
    return value;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test apps/website/test/render.test.ts
```

Expected: 8 pass, 0 fail. If `marked.parse` is typed as `string | Promise<string>` and `tsc` complains, cast: `const content = marked.parse(page.body, { async: false, gfm: true }) as string;`.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run --cwd apps/website typecheck
git add apps/website/src/render.ts apps/website/test/render.test.ts
git commit -m "feat(website): render pages through a layout with docs navigation"
```

---

### Task 4: Build orchestrator, layout, stylesheet, static assets, and the build test

**Files:**
- Create: `apps/website/src/build.ts`
- Create: `apps/website/build.ts`
- Create: `apps/website/src/layout.html`
- Create: `apps/website/src/styles.css`
- Create: `apps/website/src/hero.js` (no-op stub here; Task 5 fills it)
- Create: `apps/website/src/pages/index.md` (minimal; Task 5 replaces it)
- Create: `apps/website/src/static/.nojekyll`
- Move: `docs/CNAME`, `docs/install.sh`, `docs/apple-touch-icon.png`, `docs/favicon-32.png`, `docs/icon-dark.png`, `docs/icon-light.png`, `docs/logo-dark.png`, `docs/logo-white.png` → `apps/website/src/static/`
- Create: `apps/website/test/build.test.ts`

**Interfaces:**
- Consumes: `collectPages` (Task 2), `renderPage` (Task 3).
- Produces: `build({ outDir }: { outDir: string }): string[]` returning written page paths; `cleanOutput(outDir: string): void`; constants `SITE_URL = "https://kerstel.dev"` and `DEFAULT_OUT` (absolute path of repo `docs/`). CLI: `bun run build.ts [--out <dir>]`.

- [ ] **Step 1: Move the static assets out of `docs/`**

```bash
mkdir -p apps/website/src/static
git mv docs/CNAME docs/install.sh docs/apple-touch-icon.png docs/favicon-32.png docs/icon-dark.png docs/icon-light.png docs/logo-dark.png docs/logo-white.png apps/website/src/static/
touch apps/website/src/static/.nojekyll
ls -A apps/website/src/static
```

Expected listing: `.nojekyll CNAME apple-touch-icon.png favicon-32.png icon-dark.png icon-light.png install.sh logo-dark.png logo-white.png`. `docs/` now holds only `index.html`, `changelog.html`, and `superpowers/`. The live site is unaffected until this branch merges; Task 9 regenerates `docs/`.

- [ ] **Step 2: Write the failing build test**

`apps/website/test/build.test.ts`:

```ts
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

  test("cleaning preserves the superpowers directory and removes everything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "kerstel-clean-"));
    Bun.write(join(dir, "superpowers", "keep.md"), "keep");
    Bun.write(join(dir, "stale.html"), "old");
    Bun.write(join(dir, "old", "deep.txt"), "old");
    build({ outDir: dir });
    expect(existsSync(join(dir, "superpowers", "keep.md"))).toBe(true);
    expect(existsSync(join(dir, "stale.html"))).toBe(false);
    expect(existsSync(join(dir, "old"))).toBe(false);
    expect(existsSync(join(dir, "index.html"))).toBe(true);
  });
});
```

Note: `Bun.write` is async but creates parent directories; awaiting is not needed for correctness here because `build` runs after the promises are scheduled and Bun flushes small writes synchronously enough for this test. If the clean test flakes, change the three `Bun.write` calls to `await Bun.write(...)` and make the test callback `async`.

- [ ] **Step 3: Run the test to verify it fails**

```bash
bun test apps/website/test/build.test.ts
```

Expected: FAIL, `Cannot find module "../src/build"`.

- [ ] **Step 4: Write the layout**

`apps/website/src/layout.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{title}}</title>
<meta name="description" content="{{description}}">
<link rel="canonical" href="{{canonical}}">
<meta property="og:title" content="{{title}}">
<meta property="og:description" content="{{description}}">
<meta property="og:url" content="{{canonical}}">
<meta property="og:image" content="https://kerstel.dev/logo-white.png">
<meta name="twitter:card" content="summary">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="site-header">
<div class="wrap">
<a class="brand" href="/"><img src="/icon-light.png" alt="" width="28" height="28">Kerstel</a>
<nav class="site-nav" aria-label="Site">
<a href="/docs">Docs</a>
<a href="/security">Security</a>
<a href="https://github.com/alilibx/kerstel">GitHub</a>
</nav>
</div>
</header>
{{nav}}
<main class="wrap">
{{content}}
</main>
<footer class="site-footer">
<div class="wrap">
<span>Kerstel · MIT License</span>
<nav aria-label="Footer">
<a href="https://github.com/alilibx/kerstel">GitHub</a>
<a href="/security">Security</a>
<a href="/docs">Docs</a>
<a href="https://github.com/alilibx/kerstel/blob/main/LICENSE">License</a>
</nav>
</div>
</footer>
<script src="/hero.js" defer></script>
</body>
</html>
```

- [ ] **Step 5: Write the stylesheet**

`apps/website/src/styles.css`:

```css
:root {
  --bg: #202124;
  --surface: #292a2d;
  --surface-border: #35363a;
  --surface-hover: #313236;
  --text: #ececef;
  --text-secondary: #8b8b8e;
  --text-tertiary: #55555a;
  --accent: #4ade80;
  --accent-dim: rgba(74, 222, 128, 0.1);
  --accent-border: rgba(74, 222, 128, 0.25);
  --danger: #f87171;
  --mono: "SF Mono", "Fira Code", "JetBrains Mono", Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, "Helvetica Neue", sans-serif;
  --wrap: 680px;
  --gutter: 16px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html { color-scheme: dark; }

body {
  font-family: var(--sans);
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}

.wrap {
  width: 100%;
  max-width: var(--wrap);
  margin: 0 auto;
  padding-left: var(--gutter);
  padding-right: var(--gutter);
}

main.wrap { flex: 1; padding-bottom: 64px; }

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

code, pre, kbd {
  font-family: var(--mono);
  font-size: 0.92em;
}

code {
  background: var(--surface);
  border: 1px solid var(--surface-border);
  border-radius: 4px;
  padding: 1px 6px;
}

pre {
  background: var(--surface);
  border: 1px solid var(--surface-border);
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  margin: 16px 0;
  line-height: 1.5;
}

pre code { background: none; border: 0; padding: 0; font-size: 13.5px; }

.ref { color: var(--accent); }

/* Header & footer */

.site-header {
  border-bottom: 1px solid var(--surface-border);
  background: rgba(32, 33, 36, 0.85);
  backdrop-filter: blur(8px);
  position: sticky;
  top: 0;
  z-index: 10;
}

.site-header .wrap,
.site-footer .wrap {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 56px;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: #fff;
  font-weight: 600;
  letter-spacing: -0.3px;
}
.brand:hover { text-decoration: none; }
.brand img { border-radius: 6px; }

.site-nav, .site-footer nav { display: flex; gap: 18px; }
.site-nav a, .site-footer nav a { color: var(--text-secondary); font-size: 14px; }
.site-nav a:hover, .site-footer nav a:hover { color: var(--text); text-decoration: none; }

.site-footer {
  border-top: 1px solid var(--surface-border);
  color: var(--text-tertiary);
  font-size: 13px;
}

/* Docs sub-navigation */

.docs-nav {
  border-bottom: 1px solid var(--surface-border);
  background: var(--surface);
}
.docs-nav ul {
  list-style: none;
  display: flex;
  gap: 4px;
  max-width: var(--wrap);
  margin: 0 auto;
  padding: 0 var(--gutter);
  overflow-x: auto;
}
.docs-nav a {
  display: block;
  padding: 10px 12px;
  color: var(--text-secondary);
  font-size: 14px;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
}
.docs-nav a:hover { color: var(--text); text-decoration: none; }
.docs-nav a[aria-current="page"] { color: var(--text); border-bottom-color: var(--accent); }

/* Prose */

main h1 { font-size: 36px; letter-spacing: -1px; line-height: 1.15; margin: 48px 0 12px; color: #fff; }
main h2 { font-size: 22px; letter-spacing: -0.4px; margin: 40px 0 10px; color: #fff; }
main h3 { font-size: 17px; margin: 28px 0 8px; color: #fff; }
main p, main ul, main ol { margin: 0 0 14px; color: var(--text); }
main ul, main ol { padding-left: 22px; }
main li + li { margin-top: 4px; }
main .lede { font-size: 18px; color: var(--text-secondary); }
main hr { border: 0; border-top: 1px solid var(--surface-border); margin: 32px 0; }

main table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14.5px; }
main th, main td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--surface-border); vertical-align: top; }
main th { color: var(--text-secondary); font-weight: 500; }
main td code { white-space: nowrap; }

/* Landing: hero */

.hero {
  position: relative;
  text-align: center;
  padding: 72px 0 40px;
}
.hero::before {
  content: "";
  position: absolute;
  inset: -56px -100vw 0;
  background-image:
    linear-gradient(var(--surface-border) 1px, transparent 1px),
    linear-gradient(90deg, var(--surface-border) 1px, transparent 1px);
  background-size: 40px 40px;
  mask-image: radial-gradient(ellipse 60% 70% at 50% 30%, #000 30%, transparent 100%);
  -webkit-mask-image: radial-gradient(ellipse 60% 70% at 50% 30%, #000 30%, transparent 100%);
  opacity: 0.45;
  pointer-events: none;
  z-index: -1;
}
.hero-logo { width: 84px; height: 84px; margin: 0 auto 24px; }
.hero-logo img { width: 100%; height: 100%; object-fit: contain; }
.hero h1 { font-size: 52px; letter-spacing: -2px; line-height: 1; margin: 0 0 12px; }
.hero .tagline { font-size: 20px; color: var(--text-secondary); margin: 0 auto 36px; max-width: 520px; }

.terminal {
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--surface-border);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
  transition: border-color 0.4s ease;
}
.terminal.is-ref { border-color: var(--accent-border); }
.terminal-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--surface-border);
  color: var(--text-tertiary);
  font-size: 12px;
  font-family: var(--mono);
}
.terminal-bar i { width: 10px; height: 10px; border-radius: 50%; background: var(--surface-border); display: inline-block; }
.terminal-bar span { margin-left: 8px; }
.terminal-body {
  padding: 18px 16px;
  font-family: var(--mono);
  font-size: 14.5px;
  line-height: 1.7;
  white-space: nowrap;
  overflow-x: auto;
}
.terminal-body .comment { color: var(--text-tertiary); }
.terminal-body .key { color: var(--text); }
.terminal-body .val { color: var(--danger); transition: color 0.4s ease; }
.terminal.is-swapping .val { opacity: 0.4; }
.terminal.is-ref .val { color: var(--accent); }
.terminal-body .cursor {
  display: inline-block;
  width: 8px;
  height: 1.1em;
  vertical-align: text-bottom;
  background: var(--text-secondary);
  margin-left: 2px;
  animation: blink 1s steps(1) infinite;
}
@keyframes blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .terminal-body .cursor { animation: none; }
  .terminal, .terminal-body .val { transition: none; }
}

/* Landing: install */

.install { margin: 28px auto 0; }
.install-box {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--surface);
  border: 1px solid var(--accent-border);
  border-radius: 8px;
  padding: 12px 14px;
}
.install-box .prompt { color: var(--accent); font-family: var(--mono); }
.install-box code {
  flex: 1;
  background: none;
  border: 0;
  padding: 0;
  font-size: 14px;
  overflow-x: auto;
  white-space: nowrap;
}
.copy-btn {
  background: var(--accent-dim);
  border: 1px solid var(--accent-border);
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.copy-btn:hover { background: var(--accent-border); }
.install-note { text-align: center; color: var(--text-tertiary); font-size: 13px; margin-top: 12px; }

/* Landing: sections */

.section { padding: 56px 0 0; }
.section-label {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 10px;
}
.section h2 { margin-top: 0; }
.section .lede { margin-bottom: 20px; }

.steps { display: grid; gap: 12px; counter-reset: step; }
.step {
  background: var(--surface);
  border: 1px solid var(--surface-border);
  border-radius: 10px;
  padding: 18px 18px 18px 56px;
  position: relative;
  counter-increment: step;
}
.step::before {
  content: counter(step);
  position: absolute;
  left: 18px;
  top: 18px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--accent-dim);
  border: 1px solid var(--accent-border);
  color: var(--accent);
  font-family: var(--mono);
  font-size: 13px;
  display: grid;
  place-items: center;
}
.step h3 { margin: 0 0 4px; font-size: 16px; }
.step p { margin: 0; color: var(--text-secondary); font-size: 14.5px; }

.claims { list-style: none; padding: 0; display: grid; gap: 10px; }
.claims li {
  padding: 14px 16px 14px 40px;
  background: var(--surface);
  border: 1px solid var(--surface-border);
  border-radius: 8px;
  position: relative;
  font-size: 15px;
}
.claims li::before {
  content: "";
  position: absolute;
  left: 16px;
  top: 20px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
}
.section .more { display: inline-block; margin-top: 16px; font-size: 14px; }

@media (min-width: 640px) {
  .steps { grid-template-columns: repeat(3, 1fr); }
  .step { padding: 52px 18px 18px; }
  .step::before { left: 18px; top: 16px; }
}

@media (max-width: 480px) {
  .hero { padding-top: 48px; }
  .hero h1 { font-size: 42px; }
  .hero .tagline { font-size: 17px; }
  main h1 { font-size: 30px; }
  .site-header .wrap, .site-footer .wrap { height: auto; padding-top: 10px; padding-bottom: 10px; flex-wrap: wrap; }
}
```

- [ ] **Step 6: Write the hero script stub and a minimal landing page**

`apps/website/src/hero.js` (Task 5 replaces this):

```js
// Landing-page hero animation. Filled in by the landing page task.
(function () {
  if (!document.getElementById("hero-val")) return;
})();
```

`apps/website/src/pages/index.md` (Task 5 replaces this):

```md
---
title: Kerstel · Local-first secrets for Node and Bun projects
description: Your .env files hold only references. The real values live in an encrypted vault on your machine.
---
<section class="hero">
<h1>Kerstel</h1>
<p class="tagline">Local-first secrets for Node and Bun projects.</p>
</section>
```

- [ ] **Step 7: Implement the build**

`apps/website/src/build.ts`:

```ts
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
```

`apps/website/build.ts`:

```ts
import { resolve } from "node:path";
import { build, DEFAULT_OUT } from "./src/build";

const idx = process.argv.indexOf("--out");
const outArg = idx === -1 ? DEFAULT_OUT : process.argv[idx + 1];
if (!outArg) {
  console.error("usage: bun run build.ts [--out <dir>]");
  process.exit(2);
}
const outDir = resolve(outArg);
const written = build({ outDir });
console.log(`kerstel.dev: wrote ${written.length} page(s) to ${outDir}`);
```

- [ ] **Step 8: Run the build test to verify it passes**

```bash
bun test apps/website/test/build.test.ts
```

Expected: 7 pass, 0 fail.

- [ ] **Step 9: Typecheck and run the whole website suite**

```bash
bun run --cwd apps/website typecheck
bun test apps/website
```

Expected: typecheck exits 0; all tests across the three test files pass.

- [ ] **Step 10: Commit**

```bash
git add apps/website docs/CNAME docs/install.sh docs/*.png
git commit -m "feat(website): build orchestrator, layout, stylesheet, and static assets"
```

(`git add docs/...` stages the moves recorded by `git mv`. Check `git status --short` shows `R` entries from `docs/` to `apps/website/src/static/` and no leftover deletions.)

---

### Task 5: Landing page and hero animation

**Files:**
- Modify: `apps/website/src/pages/index.md` (replace)
- Modify: `apps/website/src/hero.js` (replace)
- Modify: `apps/website/test/build.test.ts` — add landing assertions

**Interfaces:**
- Consumes: CSS classes from Task 4 (`hero`, `terminal`, `install-box`, `copy-btn`, `section`, `steps`, `claims`).
- Produces: element `#hero-val` inside `.terminal`; global function `copyInstall(btn)` defined in `hero.js`.

Rules for the landing Markdown: the body is raw HTML. Leave a blank line only between top-level `<section>` blocks, never inside one, so `marked` passes each section through as one HTML block.

- [ ] **Step 1: Add landing assertions to the build test**

In `apps/website/test/build.test.ts`, inside `describe("build output", ...)`, add:

```ts
  test("landing page carries the hero, install command, and section links", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain('id="hero-val"');
    expect(html).toContain("curl -fsSL https://kerstel.dev/install.sh | bash");
    expect(html).toContain('href="/security"');
    expect(html).toContain('href="/docs/getting-started"');
    expect(html).not.toContain("version-badge");
    expect(html).not.toContain("api.github.com");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test apps/website/test/build.test.ts
```

Expected: FAIL on the new test (`curl -fsSL ...` not found).

- [ ] **Step 3: Write the landing page**

Replace `apps/website/src/pages/index.md` with:

```md
---
title: Kerstel · Local-first secrets for Node and Bun projects
description: Your .env files hold only references. The real values live in an encrypted vault on your machine. No account, no cloud, no telemetry.
---
<section class="hero">
<div class="hero-logo"><img src="/icon-light.png" alt="Kerstel"></div>
<h1>Kerstel</h1>
<p class="tagline">Local-first secrets for Node and Bun projects. Your <code>.env</code> holds references. The values never touch disk in the clear.</p>
<div class="terminal" aria-label="Example .env file">
<div class="terminal-bar"><i></i><i></i><i></i><span>.env</span></div>
<div class="terminal-body"><span class="comment"># safe to read, grep, and commit</span><br><span class="key">OPENAI_API_KEY=</span><span class="val" id="hero-val">kerstel://global/OPENAI_API_KEY</span><span class="cursor" aria-hidden="true"></span></div>
</div>
<div class="install">
<div class="install-box">
<span class="prompt">$</span>
<code>curl -fsSL https://kerstel.dev/install.sh | bash</code>
<button class="copy-btn" type="button" onclick="copyInstall(this)">Copy</button>
</div>
<p class="install-note">macOS, Linux, and Windows. No account, no cloud, no telemetry.</p>
</div>
</section>

<section class="section">
<div class="section-label">The problem</div>
<h2>Plaintext .env files leak</h2>
<p class="lede">Anything that can read files can read your secrets: AI coding agents, editor plugins, backup tools, and the commit you did not mean to make. Other tools fix this with a cloud account and a wrapper command. Kerstel asks for neither.</p>
</section>

<section class="section">
<div class="section-label">How it works</div>
<h2>Store once. Reference everywhere.</h2>
<p class="lede">Run <code>kerstel set global/OPENAI_API_KEY</code> once. From then on your project file holds <code class="ref">kerstel://global/OPENAI_API_KEY</code> and your code still reads the real value from <code>process.env</code>.</p>
<div class="steps">
<div class="step"><h3>Vault</h3><p>Values are encrypted at rest with AES-256-GCM. The data key lives in your OS credential store, never in a file.</p></div>
<div class="step"><h3>Daemon</h3><p>A per-user resolver unlocks the vault once and answers lookups over a local socket. Nothing leaves your machine.</p></div>
<div class="step"><h3>Hook</h3><p>A small preload intercepts reads of <code>process.env</code> and swaps each reference for its value. The file on disk never changes.</p></div>
</div>
<a class="more" href="/docs/getting-started">Read the getting started guide →</a>
</section>

<section class="section">
<div class="section-label">Security model</div>
<h2>Clear about what is protected</h2>
<ul class="claims">
<li>No plaintext secret ever sits in a project file. Reading, grepping, or committing <code>.env</code> yields only references.</li>
<li>Each value is encrypted with its own random nonce. The key that unlocks them is held by macOS Keychain, Secret Service, or Windows Credential Manager.</li>
<li>Code that runs inside your project can still read resolved values. That is the boundary Kerstel draws today, and per-process approval is the next step.</li>
</ul>
<a class="more" href="/security">Read the full security model →</a>
</section>
```

- [ ] **Step 4: Write the hero script**

Replace `apps/website/src/hero.js` with:

```js
// Landing-page behaviour: the .env hero animation and the install copy button.
// Dependency-free. Every other page loads this file too and exits at the first check.
(function () {
  var val = document.getElementById("hero-val");
  if (!val) return;

  var card = val.closest(".terminal");
  var PLAIN = "sk-live-4f9c1e7b2a8d03e6";
  var REF = "kerstel://global/OPENAI_API_KEY";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    val.textContent = REF;
    card.classList.add("is-ref");
    return;
  }

  function type(text, i, speed, done) {
    if (i > text.length) return done();
    val.textContent = text.slice(0, i);
    setTimeout(function () { type(text, i + 1, speed, done); }, speed);
  }

  function erase(done) {
    var t = val.textContent;
    if (!t.length) return done();
    val.textContent = t.slice(0, -1);
    setTimeout(function () { erase(done); }, 18);
  }

  function loop() {
    card.classList.remove("is-ref");
    val.textContent = "";
    type(PLAIN, 0, 45, function () {
      setTimeout(function () {
        card.classList.add("is-swapping");
        erase(function () {
          card.classList.remove("is-swapping");
          card.classList.add("is-ref");
          type(REF, 0, 30, function () {
            setTimeout(loop, 3200);
          });
        });
      }, 1100);
    });
  }

  loop();
})();

function copyInstall(btn) {
  var cmd = "curl -fsSL https://kerstel.dev/install.sh | bash";
  navigator.clipboard.writeText(cmd).then(function () {
    btn.textContent = "Copied";
    setTimeout(function () { btn.textContent = "Copy"; }, 2000);
  });
}
```

- [ ] **Step 5: Run the build test to verify it passes**

```bash
bun test apps/website/test/build.test.ts
```

Expected: all pass. The link check now also covers `/docs/getting-started` and `/security`, which do not exist yet, so it fails until Tasks 6 and 7 land. If you run Tasks 5, 6, and 7 in order, expect the link test to fail here with `index.html links to /security but security.html does not exist` and pass again after Task 7. Commit anyway; the branch is only required to be green at the end of Task 7.

- [ ] **Step 6: Preview in a browser**

```bash
bun run --cwd apps/website build -- --out /tmp/kerstel-site && bunx serve /tmp/kerstel-site -l 4173
```

Open `http://localhost:4173`. Check: the hero types `sk-live-…`, fades, and retypes the green `kerstel://` reference on a loop; the Copy button reports "Copied"; at 375px wide nothing scrolls horizontally. Stop the server with Ctrl-C.

- [ ] **Step 7: Commit**

```bash
git add apps/website/src/pages/index.md apps/website/src/hero.js apps/website/test/build.test.ts
git commit -m "feat(website): landing page with animated plaintext-to-reference hero"
```

---

### Task 6: Security model page

**Files:**
- Create: `apps/website/src/pages/security.md`
- Modify: `apps/website/test/build.test.ts` — add `"security.html"` to `EXPECTED_PAGES`

- [ ] **Step 1: Add the page to the expected list**

In `apps/website/test/build.test.ts`, change:

```ts
const EXPECTED_PAGES = ["index.html"];
```

to:

```ts
const EXPECTED_PAGES = ["index.html", "security.html"];
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test apps/website/test/build.test.ts
```

Expected: FAIL, `security.html missing`.

- [ ] **Step 3: Write the page**

`apps/website/src/pages/security.md`:

```md
---
title: Security model
description: What Kerstel protects, how values are encrypted, where the key lives, and the boundary it draws today.
---
# Security model

<p class="lede">Kerstel protects secrets at the file level today and is built to add access-level protection next. This page says exactly what that means.</p>

## What is protected

No plaintext secret ever sits in a project file. Your `.env`, `.env.local`, and their variants hold references of the form `kerstel://<scope>/<KEY>`. Reading a file, grepping the repo, committing by mistake, or syncing the folder to a backup service yields references and nothing else.

The values live in a single vault on your machine at `~/.kerstel/vault.db`. Nothing is sent anywhere. Kerstel makes no network calls, has no account, and collects no telemetry.

## Encryption at rest

Every value is encrypted with AES-256-GCM using a fresh random 96-bit nonce. The authentication tag is verified on every read, so a tampered ciphertext fails loudly instead of decrypting to garbage.

The 256-bit data key is generated on first run and stored only in your operating system's credential store:

| Platform | Store |
| --- | --- |
| macOS | Keychain |
| Linux | Secret Service (libsecret) |
| Windows | Credential Manager (DPAPI) |

The key is never written to the vault file, never logged, and never printed. On a Linux machine without a Secret Service provider, Kerstel falls back to a key file with `0600` permissions and warns you every time it does.

## Where plaintext appears

Plaintext leaves the vault in exactly three places:

1. Inside your app's process, when code reads `process.env.SOME_KEY` and the runtime hook resolves the reference.
2. In the environment of a child process started by `kerstel run -- <command>`, or spawned by a process already running under the hook.
3. On your terminal, only when you ask with `kerstel get <scope>/<KEY> --reveal`.

Plaintext never appears in log output, error messages, or audit rows.

## The boundary today

A process that runs code inside your project can read resolved values from `process.env`. That includes your app, its dependencies, and anything you launch through your package scripts. Kerstel does not try to stop code you chose to run from reading a secret you chose to give it.

This is file-level protection. It closes the most common leaks: agents and tools that read files, and secrets that end up in git history.

## What comes next

The resolver daemon already sees which process asks for which key. The next protection level uses that: an unrecognized process asking for a key triggers an approval prompt, the way macOS asks before an app reads a Keychain item. Allowlists and Touch ID or polkit for sensitive operations follow. The current design keeps resolution lazy and daemon-mediated so this layer can be added without changing how you wire a project.

## Out of scope

Kerstel does not defend against an attacker with root, a compromised OS credential store, or malicious code running after it has been granted a secret.

## Read more

The full threat model, architecture, and roadmap are in the [design spec on GitHub](https://github.com/alilibx/kerstel/blob/main/docs/superpowers/specs/2026-09-17-kerstel-secrets-manager-design.md).
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test apps/website/test/build.test.ts
```

Expected: `writes every expected page` passes. The link test still fails on `/docs/getting-started` until Task 7.

- [ ] **Step 5: Commit**

```bash
git add apps/website/src/pages/security.md apps/website/test/build.test.ts
git commit -m "feat(website): security model page"
```

---

### Task 7: Docs pages

**Files:**
- Create: `apps/website/src/pages/docs/index.md`
- Create: `apps/website/src/pages/docs/getting-started.md`
- Create: `apps/website/src/pages/docs/cli.md`
- Create: `apps/website/src/pages/docs/how-it-works.md`
- Create: `apps/website/src/pages/docs/teams.md`
- Modify: `apps/website/test/build.test.ts` — extend `EXPECTED_PAGES`, add a docs nav assertion

- [ ] **Step 1: Extend the test**

In `apps/website/test/build.test.ts`, replace the `EXPECTED_PAGES` constant with:

```ts
const EXPECTED_PAGES = [
  "index.html",
  "security.html",
  "docs/index.html",
  "docs/getting-started.html",
  "docs/cli.html",
  "docs/how-it-works.html",
  "docs/teams.html",
];
```

and add inside `describe("build output", ...)`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test apps/website/test/build.test.ts
```

Expected: FAIL, `docs/index.html missing` and the nav test failing on missing files.

- [ ] **Step 3: Write the docs index**

`apps/website/src/pages/docs/index.md` (no `section`, so it gets no sub-nav of its own):

```md
---
title: Docs
description: Guides and reference for Kerstel, the local-first secrets manager for Node and Bun projects.
---
# Docs

<p class="lede">Everything you need to store a secret, reference it from a project, and run your app.</p>

- [Getting started](/docs/getting-started). Install Kerstel, store your first secret, and run a project against it.
- [CLI reference](/docs/cli). Every command with its flags.
- [How resolution works](/docs/how-it-works). References, scopes, the daemon, and the runtime hook.
- [Working with a team](/docs/teams). Commit references, fill each teammate's local vault.

Looking for the threat model? See the [security model](/security).
```

- [ ] **Step 4: Write Getting started**

`apps/website/src/pages/docs/getting-started.md`:

````md
---
title: Getting started
description: Install Kerstel, store a secret, replace the plaintext in your .env with a reference, and run your app.
section: docs
order: 1
---
# Getting started

<p class="lede">Five minutes from a plaintext <code>.env</code> to one that is safe to commit.</p>

## 1. Install

```bash
curl -fsSL https://kerstel.dev/install.sh | bash
```

The installer places the `kerstel` binary in `~/.kerstel/bin`, adds it to your PATH, creates the vault, and stores the data key in your OS credential store. Run `kerstel doctor` afterwards to confirm the vault and credential store are reachable.

Prefer to build it yourself? The [README](https://github.com/alilibx/kerstel#build-from-source) covers building from source with Bun.

## 2. Store a secret

```bash
kerstel set global/OPENAI_API_KEY --value sk-...
```

Or pipe the value in so it never lands in your shell history:

```bash
pbpaste | kerstel set global/OPENAI_API_KEY
```

`global` is a scope shared by every project on this machine. Use a project name instead, such as `myapp/DATABASE_URL`, for a value that belongs to one project.

## 3. Reference it from your project

Open `.env` and replace the value with a reference:

```bash
# .env
OPENAI_API_KEY=kerstel://global/OPENAI_API_KEY
```

This file is now safe to read, grep, and commit. `kerstel ls` shows every reference the vault can serve.

## 4. Run your app

The universal way, which works for any command:

```bash
kerstel run -- npm run dev
```

`kerstel run` resolves every reference in the environment up front and starts the command with real values injected. Nothing about the command changes.

Projects wired with the runtime hook skip the wrapper: your code reads `process.env.OPENAI_API_KEY` and gets the real value directly. [How resolution works](/docs/how-it-works) explains the difference.

## 5. Check the setup

```bash
kerstel doctor
```

`doctor` reports whether the daemon is running, whether the credential store holds the key, and whether the current project is wired for the hook.

## What about a whole project at once?

`kerstel init` scans a project's `.env` files, moves each value into the vault, rewrites the files with references, and wires the hook for you. It is in development and lands in an upcoming release. Until then the steps above are the manual path.
````

- [ ] **Step 5: Write the CLI reference**

`apps/website/src/pages/docs/cli.md`:

```md
---
title: CLI reference
description: Every Kerstel command, what it does, and the flags it takes.
section: docs
order: 2
---
# CLI reference

<p class="lede">All commands take a reference in the form <code>&lt;scope&gt;/&lt;KEY&gt;</code>, where scope is <code>global</code> or a project name.</p>

## Secrets

| Command | What it does |
| --- | --- |
| `kerstel set <scope>/<KEY> [--value <value>]` | Store or overwrite a secret. Without `--value`, the value is read from stdin. |
| `kerstel get <scope>/<KEY> [--reveal]` | Read a secret. Prints a masked value unless `--reveal` is given. |
| `kerstel ls [--scope <scope>]` | List stored references, optionally for one scope. Values are never listed. |
| `kerstel rm <scope>/<KEY> --yes` | Remove a secret. `--yes` is required; there is no interactive confirmation. |

## Running code

| Command | What it does |
| --- | --- |
| `kerstel run -- <command>` | Resolve every reference in the current environment, then run the command with real values injected. Works for anything that cannot load the runtime hook. |
| `kerstel resolve kerstel://<scope>/<KEY>` | Print one resolved value. Useful in scripts. |

## Daemon and diagnostics

| Command | What it does |
| --- | --- |
| `kerstel daemon start` | Start the resolver daemon in the background. |
| `kerstel daemon stop` | Stop it. |
| `kerstel daemon status` | Report whether it is running and where its socket is. |
| `kerstel daemon serve` | Run the daemon in the foreground. Used by `start`; handy for debugging. |
| `kerstel doctor` | Diagnose this machine: vault, credential store, daemon, and project wiring. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `KERSTEL_HOME` | Directory for the vault, socket, and hook assets. Defaults to `~/.kerstel`. |
| `KERSTEL_KEYCHAIN_BACKEND` | Force a credential store backend. Set to `file` for a `0600` key file instead of the OS store. Kerstel warns whenever this fallback is in use. |

## Exit codes

Commands exit `0` on success and non-zero on any failure. Errors go to stderr and name the fix, usually `kerstel doctor`. Plaintext values never appear in error output.
```

- [ ] **Step 6: Write How resolution works**

`apps/website/src/pages/docs/how-it-works.md`:

````md
---
title: How resolution works
description: Reference syntax, scopes, the resolver daemon, and how the runtime hook turns a reference into a value.
section: docs
order: 3
---
# How resolution works

<p class="lede">A reference is a pointer into your vault. This page follows one from the <code>.env</code> file to <code>process.env</code>.</p>

## References and scopes

A reference looks like this:

```
kerstel://<scope>/<KEY>
```

The scope is either `global` or a project name. A reference names exactly one scope and resolves there or fails. There is no fallback chain: `kerstel://myapp/API_KEY` never quietly picks up `global/API_KEY`. If you want a project to use a shared value, point the project's `.env` at the global reference directly.

## The vault

Values live in `~/.kerstel/vault.db`, encrypted per value with AES-256-GCM. The data key lives in your OS credential store. The [security model](/security) covers this in detail.

## The daemon

A per-user resolver daemon unlocks the vault once, using the credential store, and then answers lookups over a local socket (`~/.kerstel/kerstel.sock`, or a named pipe on Windows). Each request carries a session token, so only processes running as you can ask. The daemon records an audit row for each resolution.

You rarely start it by hand. The hook and `kerstel run` start it on demand; `kerstel daemon status` shows whether it is up.

## Two ways to resolve

### `kerstel run`

```bash
kerstel run -- next build
```

`run` reads the current environment, resolves every reference it finds, and starts the command with plaintext values in place. It is the universal path. It works for IDE run configurations, other languages, and any command that cannot load a Node preload.

### The runtime hook

The hook is a small, dependency-free preload that runs before your app code. It replaces `process.env` with a proxy. When code reads a key whose value starts with `kerstel://`, the hook asks the daemon, memoizes the answer for the life of the process, and returns the real value. Nothing on disk changes, and the hook does not care how the reference got into the environment: dotenv, Bun's native `.env` loader, Next.js env loading, or your shell.

For Bun projects the hook is a `preload` entry in `bunfig.toml`. For Node projects the package scripts run through a shim that sets `NODE_OPTIONS=--require <hook>`.

Child processes are covered: the hook injects itself into the environment it exposes, so a `node` or `bun` child resolves its own references. Variables handed to any child are handed already resolved. A child that is not Node or Bun, such as `python` or `git`, could not resolve a reference anyway.

## When resolution fails

If the daemon is unreachable, the vault is locked, or the key is missing, the hook throws an error that names the reference and points at `kerstel doctor`. It never returns the reference string to your code as if it were the value.

## Edge cases worth knowing

- **Build-time snapshots.** Frameworks that inline environment variables into a client bundle, such as `NEXT_PUBLIC_*`, only see real values when the build itself runs under the hook or through `kerstel run`.
- **Scrubbed environments.** A process launched with a clean environment, or by an absolute-path exec that drops `NODE_OPTIONS`, cannot load the hook. Use `kerstel run` for those.
- **One spawn resolves everything.** Building a child's environment enumerates every variable, so a single spawn resolves every reference in scope, whether or not the child reads it. Expect one audit row per reference per spawn.
````

- [ ] **Step 7: Write Working with a team**

`apps/website/src/pages/docs/teams.md`:

````md
---
title: Working with a team
description: Commit references instead of values, and fill each teammate's local vault from the same file.
section: docs
order: 4
---
# Working with a team

<p class="lede">The committed <code>.env</code> is the contract. Each machine holds its own vault.</p>

## Commit the references

Once every value in `.env` is a reference, the file contains nothing sensitive. Commit it. It doubles as a living `.env.example` that can never drift from what the app reads, because it is what the app reads.

```bash
# .env, committed
DATABASE_URL=kerstel://myapp/DATABASE_URL
OPENAI_API_KEY=kerstel://global/OPENAI_API_KEY
STRIPE_SECRET_KEY=kerstel://myapp/STRIPE_SECRET_KEY
```

If `.env` is in `.gitignore`, remove it there only after every value is a reference. `git grep "=sk-"` and similar checks stay useful as a guard.

## Onboard a teammate

A new clone has the references but an empty vault for that project. `kerstel ls` shows what the file expects; each missing key is set once:

```bash
git clone git@github.com:acme/myapp.git && cd myapp
kerstel ls --scope myapp
kerstel set myapp/DATABASE_URL
kerstel set myapp/STRIPE_SECRET_KEY
kerstel run -- npm run dev
```

Values are typed or pasted on stdin and never appear in shell history. The vault stays on that machine. Kerstel has no sync, no shared account, and nothing to configure between teammates.

## Share values out of band

How the value reaches a teammate is up to you: a password manager share, a secure channel, or your cloud provider's console. Kerstel's job is that the value lands in a local vault and nowhere else in the repo.

## Rotate a secret

Rotation is a `set` on each machine:

```bash
kerstel set myapp/STRIPE_SECRET_KEY
```

No project file changes, no commit, no redeploy of configuration. Restart the app so the hook's per-process memo refreshes.

## Coming later

The roadmap includes optional end-to-end encrypted sync and shared vaults, with keys that stay on your devices. Until then the workflow above needs nothing beyond git and the CLI.
````

- [ ] **Step 8: Run the whole website suite**

```bash
bun test apps/website
```

Expected: every test passes, including the link check from Task 4 and the landing assertions from Task 5.

- [ ] **Step 9: Preview and check the docs**

```bash
bun run --cwd apps/website build -- --out /tmp/kerstel-site && bunx serve /tmp/kerstel-site -l 4173
```

Open `http://localhost:4173/docs`, click through all four pages. Check the sub-nav highlights the current page, tables do not overflow at 375px (they scroll inside `pre`/table wrappers or wrap), and every link works. Stop the server.

- [ ] **Step 10: Commit**

```bash
git add apps/website/src/pages/docs apps/website/test/build.test.ts
git commit -m "feat(website): docs section with getting started, CLI, resolution, and teams pages"
```

---

### Task 8: CI job for the website

**Files:**
- Modify: `.github/workflows/ci.yml` — add a `website` job

- [ ] **Step 1: Add the job**

Append to `.github/workflows/ci.yml` under `jobs:`:

```yaml
  website:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run --cwd apps/website build
      # docs/ is committed build output. A page edit without a rebuild shows up
      # here as a diff and fails the job, so kerstel.dev can never go stale.
      - run: git diff --exit-code -- docs/
      - run: bun test apps/website
```

- [ ] **Step 2: Validate the YAML**

```bash
bun -e 'const y = await Bun.file(".github/workflows/ci.yml").text(); console.log(Object.keys(Bun.YAML.parse(y).jobs))'
```

Expected output: `[ "test", "build", "website" ]`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build kerstel.dev and fail on stale docs/ output"
```

---

### Task 9: Regenerate `docs/`, verify, and open the PR

**Files:**
- Modify: `docs/` — generated output replaces `index.html` and `changelog.html`
- Modify: `README.md` — one line pointing at the docs

- [ ] **Step 1: Build into `docs/`**

```bash
bun run --cwd apps/website build
git status --short docs/
```

Expected: `docs/index.html` modified, `docs/changelog.html` deleted, new files `docs/security.html`, `docs/docs/*.html`, `docs/styles.css`, `docs/hero.js`, `docs/.nojekyll`, and the assets back in place (`CNAME`, `install.sh`, the PNGs). `docs/superpowers/` untouched.

- [ ] **Step 2: Confirm the output is stable and the suite is green**

```bash
bun run --cwd apps/website build && git diff --exit-code -- docs/ && echo "docs/ is fresh"
bun run typecheck
bun run test
```

Expected: `docs/ is fresh`; typecheck exits 0 for all four workspaces; the full test suite passes (the CLI suites build the hook and binary first, which takes a minute).

- [ ] **Step 3: Confirm the retired product is gone from the output**

```bash
grep -rIl -i -E 'menu bar|macOS 14|AI usage|system metrics|api\.github\.com' docs/ --exclude-dir=superpowers || echo "clean"
```

Expected: `clean`.

- [ ] **Step 4: Point the README at the docs**

In `README.md`, change the final centered link block from:

```md
**[kerstel.dev](https://kerstel.dev)**
```

to:

```md
**[kerstel.dev](https://kerstel.dev)** · [Docs](https://kerstel.dev/docs) · [Security model](https://kerstel.dev/security)
```

- [ ] **Step 5: Commit the generated site**

```bash
git add -A docs README.md
git commit -m "feat(website): publish the rebuilt kerstel.dev for the secrets manager"
```

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat: rebuild kerstel.dev for the secrets manager (plan 4)" --body "$(cat <<'EOF'
## Summary

Replaces the menu-bar landing page at kerstel.dev with a six-page site for the secrets manager, generated from Markdown by a small Bun script in `apps/website` into `docs/`.

- Landing page with an animated plaintext-to-reference hero and the install one-liner
- Security model page
- Docs: getting started, CLI reference, how resolution works, working with a team
- CI job rebuilds and fails on a stale `docs/` diff
- No changelog widget (returns with plan 5 once a real release exists)

`install.sh` stays the stub until plan 5 ships binaries.

Spec: `docs/superpowers/specs/2026-09-18-kerstel-website-design.md`
Plan: `docs/superpowers/plans/2026-09-18-kerstel-website.md`

## Test plan

- [ ] `bun test apps/website` passes
- [ ] CI `website` job is green
- [ ] Preview `docs/` locally with `bunx serve docs`; hero animates, copy button works, docs nav highlights current page
- [ ] No horizontal scroll at 375px

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Review the PR**

Per the repo owner's global rules, run the `/review` skill (or the `code-reviewer` agent) on the new PR immediately, fix confirmed findings on this branch, and re-push before handing it over.

---

## Self-review

**Spec coverage.**

| Spec section | Task |
| --- | --- |
| §2 goals: replace site, one-liner front and center, security page, docs, deployment unchanged, stale output impossible | 5, 6, 7, 4, 8 |
| §3 non-goals: no changelog widget, `init` one sentence | 5 (asserts no `api.github.com`), 7 (Getting started) |
| §5 package layout, `workspaces` change | 1, 4 |
| §6 generator: front matter, `marked` with raw HTML, output paths, slots, nav, clean step, `--out`, idempotence | 1, 2, 3, 4 |
| §7.1 landing sections and order | 5 |
| §7.2 security page | 6 |
| §7.3 docs pages and forbidden copy | 7, 4 (test) |
| §8 visual direction | 4 (stylesheet), 5 |
| §9 CI | 8 |
| §10 tests | 4, 5, 7 |
| §11 rollout | 9 |

**Placeholder scan.** The Task 4 `index.md` and `hero.js` are minimal working files that Task 5 replaces in full; both are given verbatim. No "TBD" or "similar to" references remain.

**Type consistency.** `FrontMatter`, `ParsedPage` (Task 1) → `Page` (Task 2) → `RenderInput`, `renderPage`, `docsNav`, `escapeHtml` (Task 3) → `build`, `cleanOutput`, `SITE_URL`, `DEFAULT_OUT` (Task 4). Test files import exactly those names. The hero element id `hero-val` and the `copyInstall` function are used in Task 5's Markdown and script and asserted in Task 5's test.
