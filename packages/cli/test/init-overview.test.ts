import { expect, test } from "bun:test";
import { renderChangeSummary, renderOverview, valueColumn, type OverviewRow } from "../src/init/overview";

const rows: OverviewRow[] = [
  { key: "DATABASE_URL", value: "postgres://u:hunter2@db/app", source: ".env.local", conflicts: [], target: "project", showValue: false },
  { key: "OPENAI_API_KEY", value: "sk-live-abcdef0123456789", source: ".env", conflicts: [], target: "global", showValue: false },
  { key: "PORT", value: "3000", source: ".env", conflicts: [], target: "plaintext", showValue: true },
  { key: "API_TOKEN", value: "tok-local-bbbb", source: ".env.local", conflicts: [".env"], target: "project", showValue: false },
];

test("groups by destination, in the spec's order, with counts", () => {
  const text = renderOverview(rows, "whasal", [".env", ".env.local"]).join("\n");
  const project = text.indexOf("Vault, for whasal only (2)");
  const shared = text.indexOf("Vault, shared by all your projects (1)");
  const plain = text.indexOf("Stays in .env, .env.local as plain text (1)");
  expect(project).toBeGreaterThanOrEqual(0);
  expect(shared).toBeGreaterThan(project);
  expect(plain).toBeGreaterThan(shared);
});

test("never prints a value headed for the vault, only its length", () => {
  const text = renderOverview(rows, "whasal", [".env"]).join("\n");
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("sk-live");
  expect(text).not.toContain("tok-local");
  expect(text).toContain("•••• 27 chars");
});

test("prints a plain-text value in full only when the caller allows it", () => {
  expect(renderOverview(rows, "whasal", [".env"]).join("\n")).toContain("3000");
  const kept: OverviewRow = { ...rows[1]!, target: "plaintext", showValue: false };
  const text = renderOverview([kept], "whasal", [".env"]).join("\n");
  expect(text).not.toContain("sk-live");
  expect(text).toContain("•••• 24 chars");
});

test("names a conflicting key's files and which one wins, without values", () => {
  const text = renderOverview(rows, "whasal", [".env"]).join("\n");
  expect(text).toContain("API_TOKEN has different values in .env.local and .env");
  expect(text).toContain("the .env.local one wins");
});

test("a conflicting key kept as plain text gets no \"wins\" note", () => {
  const plain: OverviewRow[] = [
    { key: "LOG_FORMAT", value: "json", source: ".env.local", conflicts: [".env"], target: "plaintext", showValue: true },
  ];
  expect(renderOverview(plain, "whasal", [".env", ".env.local"]).join("\n")).not.toContain("wins");
});

test("an empty group is left out", () => {
  const text = renderOverview(rows.filter((r) => r.target !== "global"), "whasal", [".env"]).join("\n");
  expect(text).not.toContain("shared by all your projects");
});

test("the change summary is one line per file", () => {
  expect(
    renderChangeSummary([
      { label: ".env.local", kind: "env", count: 7 },
      { label: "package.json", kind: "package", count: 1 },
      { label: ".gitignore", kind: "gitignore", count: 2 },
    ]),
  ).toEqual([
    ".env.local: 7 values become references",
    "package.json: 1 script goes through Kerstel",
    ".gitignore: 2 lines hiding .env files are removed",
  ]);
});

test("the key and value columns line up across every group", () => {
  const lines = renderOverview(rows, "whasal", [".env"]);
  const column = (key: string, needle: string): number => {
    const line = lines.find((l) => l.trimStart().startsWith(`${key} `))!;
    return Bun.stringWidth(line.slice(0, line.indexOf(needle)));
  };
  const vault = column("DATABASE_URL", "••••");
  expect(column("OPENAI_API_KEY", "••••")).toBe(vault);
  expect(column("PORT", "3000")).toBe(vault);
  expect(column("PORT", ".env")).toBe(column("OPENAI_API_KEY", ".env"));
});

test("a shown value loses its control characters and is cut at 40 columns", () => {
  expect(valueColumn("\u001b]0;title\u0007debug\u009b", true)).toBe("]0;titledebug");
  const long = "a".repeat(60);
  const shown = valueColumn(long, true);
  expect(shown).toBe(`${"a".repeat(39)}…`);
  expect(Bun.stringWidth(shown)).toBe(40);
  expect(valueColumn("a".repeat(40), true)).toBe("a".repeat(40));
  expect(valueColumn(long, false)).toBe("•••• 60 chars");
});

test("a shown value loses bidi and zero-width characters, which can reorder or hide text", () => {
  // Right-to-left override: rendered, "abc" reads as "cba" and the line after it is reversed.
  expect(valueColumn("abc\u202edef", true)).toBe("abcdef");
  // Every embedding, override, and isolate, plus the marks that close them.
  expect(valueColumn("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f\u061cx", true)).toBe("x");
  // Invisible formatters: zero-width characters, word joiner and invisible
  // operators, soft hyphen, Mongolian vowel separator, and the byte-order mark.
  expect(valueColumn("a\u200bb\u200cc\u200dd\ufeffe", true)).toBe("abcde");
  expect(valueColumn("a\u2060b\u2061c\u2062d\u2063e\u2064f\u00adg\u180eh", true)).toBe("abcdefgh");
  // Line and paragraph separators would split the table row in a terminal that honours them.
  expect(valueColumn("one\u2028two\u2029three", true)).toBe("onetwothree");
  // The cut at 40 columns is measured AFTER stripping: invisible characters must
  // neither count towards the width nor push a visible character off the end.
  const padded = "a\u200b".repeat(40);
  expect(valueColumn(padded, true)).toBe("a".repeat(40));
  // The masked column never rendered the value, and its length counts every code unit.
  expect(valueColumn("abc\u202edef", false)).toBe("•••• 7 chars");
});

test("a row's note is shown after its source", () => {
  const lines = renderOverview(
    [
      { key: "API_TOKEN", value: "x".repeat(12), source: ".env", conflicts: [], target: "project", showValue: false, note: "already in the vault" },
      { key: "DB_URL", value: "y".repeat(20), source: ".env", conflicts: [], target: "project", showValue: false },
    ],
    "api",
    [".env"],
  );
  const text = lines.join("\n");
  expect(text).toContain("already in the vault");
  expect(text).not.toContain("x".repeat(12));
});
