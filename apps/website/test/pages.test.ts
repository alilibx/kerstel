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

  test("throws an error naming the offending page's relative source path", () => {
    const dir = mkdtempSync(join(tmpdir(), "kerstel-pages-bad-"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "index.md"), "---\ntitle: Home\ndescription: H\n---\nhome");
    writeFileSync(join(dir, "docs", "broken.md"), "---\ntitle: Broken\nno colon here\n---\nbroken");

    expect(() => collectPages(dir)).toThrow("docs/broken.md");
  });
});
