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
