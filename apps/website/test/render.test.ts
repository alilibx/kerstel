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

  test("wraps a rendered table in a scrollable container", () => {
    const html = renderPage({
      page: { ...cli, body: "| A | B |\n| --- | --- |\n| 1 | 2 |" },
      pages: all,
      layout,
      siteUrl: "https://kerstel.dev",
    });
    expect(html).toContain('<div class="table-wrap"><table>');
    expect(html).toContain("</table>\n</div>");
    expect(html).toContain("<th>A</th>");
  });

  test("uses the page's own body renderer when it has one", () => {
    const html = renderPage({
      page: { ...security, body: "# ignored", renderBody: (md) => `<div class="custom">${md.length}</div>` },
      pages: all,
      layout,
      siteUrl: "https://kerstel.dev",
    });
    expect(html).toContain('<main><div class="custom">9</div></main>');
    expect(html).not.toContain("<h1>");
  });

  test("throws on an unknown slot", () => {
    expect(() => renderPage({ page: home, pages: all, layout: "{{bogus}}", siteUrl: "https://kerstel.dev" })).toThrow(
      "layout uses unknown slot {{bogus}}",
    );
  });
});
