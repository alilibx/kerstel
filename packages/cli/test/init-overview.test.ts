import { expect, test } from "bun:test";
import { renderChangeSummary, renderOverview, type OverviewRow } from "../src/init/overview";

const rows: OverviewRow[] = [
  { key: "DATABASE_URL", value: "postgres://u:hunter2@db/app", source: ".env.local", conflicts: [], target: "project" },
  { key: "OPENAI_API_KEY", value: "sk-live-abcdef0123456789", source: ".env", conflicts: [], target: "global" },
  { key: "PORT", value: "3000", source: ".env", conflicts: [], target: "plaintext" },
  { key: "API_TOKEN", value: "tok-local-bbbb", source: ".env.local", conflicts: [".env"], target: "project" },
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

test("prints a plain-text value in full", () => {
  expect(renderOverview(rows, "whasal", [".env"]).join("\n")).toContain("3000");
});

test("names a conflicting key's files and which one wins, without values", () => {
  const text = renderOverview(rows, "whasal", [".env"]).join("\n");
  expect(text).toContain("API_TOKEN has different values in .env.local and .env");
  expect(text).toContain("the .env.local one wins");
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
