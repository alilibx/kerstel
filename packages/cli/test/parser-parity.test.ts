import { expect, test } from "bun:test";
import { REFERENCE_FIXTURES, parseReference as cliParse } from "../src/reference";
// @ts-expect-error -- plain JS module without type declarations
import { parseReference as hookParse } from "../../hook/src/protocol.js";

test("the hook's parser matches the CLI's on every fixture", () => {
  for (const { value } of REFERENCE_FIXTURES) {
    expect(hookParse(value)).toEqual(cliParse(value));
  }
});
