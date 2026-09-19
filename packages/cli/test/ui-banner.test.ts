import { expect, test } from "bun:test";
import { BIRD, renderBanner } from "../src/ui/banner";
import { makeTheme } from "../src/ui/theme";

const plain = makeTheme({ isTTY: false, noColor: true, truecolor: false });

test("no banner when stdout is not a terminal", () => {
  expect(renderBanner({ isTTY: false, columns: 120, theme: plain, version: "0.1.0" })).toBeNull();
});

test("a narrow terminal gets the one-line mark", () => {
  expect(renderBanner({ isTTY: true, columns: 43, theme: plain, version: "0.1.0" })).toBe("◆ kerstel 0.1.0");
});

test("a wide terminal gets the bird with the name, version, and tagline beside it", () => {
  const banner = renderBanner({ isTTY: true, columns: 80, theme: plain, version: "0.1.0" })!;
  const lines = banner.split("\n");
  expect(lines).toHaveLength(BIRD.length);
  expect(lines[3]).toContain("kerstel 0.1.0");
  expect(lines[4]).toContain("Local-first secrets");
  expect(lines[5]).toContain("for Node and Bun");
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(44);
});

test("the bird is only braille and spaces", () => {
  for (const line of BIRD) expect(line).toMatch(/^[⠀-⣿ ]*$/);
});
