import { expect, test } from "bun:test";
import { REFERENCE_FIXTURES, isShorthand as cliIsShorthand, parseReference as cliParse } from "../src/reference";
// @ts-expect-error -- plain JS module without type declarations
import { isShorthand as hookIsShorthand, parseReference as hookParse } from "../../hook/src/protocol.js";

test("the hook's parser matches the CLI's on every fixture, with and without the variable's name", () => {
  for (const { value, name } of REFERENCE_FIXTURES) {
    expect(hookParse(value, name)).toEqual(cliParse(value, name));
    expect(hookParse(value)).toEqual(cliParse(value));
    expect(hookIsShorthand(value)).toBe(cliIsShorthand(value));
  }
});
