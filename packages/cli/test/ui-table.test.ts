import { expect, test } from "bun:test";
import { renderTable } from "../src/ui/table";

test("columns align by display width, not string length", () => {
  const lines = renderTable([
    ["DATABASE_URL", "•••• 64 chars", ".env.local"],
    ["PORT", "3000", ".env"],
    ["名前", "x", ".env"],
  ]);
  expect(lines[0]).toBe("DATABASE_URL  •••• 64 chars  .env.local");
  expect(lines[1]).toBe("PORT          3000           .env");
  expect(lines[2]).toBe("名前          x              .env");
});

test("ANSI colour codes do not count toward width", () => {
  const lines = renderTable([["\x1b[32mA\x1b[39m", "b"], ["AAA", "c"]]);
  expect(Bun.stringWidth(lines[0]!)).toBe(Bun.stringWidth(lines[1]!));
});

test("indent and gap", () => {
  expect(renderTable([["a", "b"]], { indent: 4, gap: 1 })).toEqual(["    a b"]);
});
