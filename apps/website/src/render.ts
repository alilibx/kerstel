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
