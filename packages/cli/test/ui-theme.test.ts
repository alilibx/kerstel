import { expect, test } from "bun:test";
import { cliName } from "../src/ui/cli-name";
import { detectTheme, makeTheme, SYMBOLS } from "../src/ui/theme";

test("colour is on only for a TTY without NO_COLOR", () => {
  expect(makeTheme({ isTTY: true, noColor: false, truecolor: false }).color).toBe(true);
  expect(makeTheme({ isTTY: false, noColor: false, truecolor: false }).color).toBe(false);
  expect(makeTheme({ isTTY: true, noColor: true, truecolor: false }).color).toBe(false);
});

test("the accent is 24-bit green on a truecolor terminal and ANSI green otherwise", () => {
  expect(makeTheme({ isTTY: true, noColor: false, truecolor: true }).accent("x")).toBe("\x1b[38;2;74;222;128mx\x1b[39m");
  expect(makeTheme({ isTTY: true, noColor: false, truecolor: false }).accent("x")).toBe("\x1b[32mx\x1b[39m");
  expect(makeTheme({ isTTY: false, noColor: false, truecolor: true }).accent("x")).toBe("x");
});

test("detectTheme reads NO_COLOR and COLORTERM", () => {
  const tty = { isTTY: true } as NodeJS.WriteStream;
  expect(detectTheme(tty, { NO_COLOR: "1" })).toEqual({ isTTY: true, noColor: true, truecolor: false });
  expect(detectTheme(tty, { COLORTERM: "24bit" })).toEqual({ isTTY: true, noColor: false, truecolor: true });
  expect(detectTheme({ isTTY: false } as NodeJS.WriteStream, {})).toEqual({ isTTY: false, noColor: false, truecolor: false });
});

test("symbols", () => {
  expect(SYMBOLS).toEqual({ pass: "✓", warn: "!", problem: "✗", info: "·" });
});

test("cliName is ks only when invoked as ks", () => {
  expect(cliName("ks")).toBe("ks");
  expect(cliName("/Users/me/.local/bin/ks")).toBe("ks");
  expect(cliName("./kerstel")).toBe("kerstel");
  expect(cliName("bun")).toBe("kerstel");
});
