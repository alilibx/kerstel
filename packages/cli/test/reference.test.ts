import { expect, test } from "bun:test";
import { REFERENCE_FIXTURES, formatReference, isReference, parseReference } from "../src/reference";

test("parses a global reference", () => {
  expect(parseReference("kerstel://global/OPENAI_API_KEY")).toEqual({
    scope: "global",
    key: "OPENAI_API_KEY",
  });
});

test("parses a project reference", () => {
  expect(parseReference("kerstel://my-app/DATABASE_URL")).toEqual({
    scope: "my-app",
    key: "DATABASE_URL",
  });
});

test("formatReference is the inverse of parseReference", () => {
  const ref = formatReference("my.app_2", "STRIPE_SECRET_KEY");
  expect(ref).toBe("kerstel://my.app_2/STRIPE_SECRET_KEY");
  expect(parseReference(ref)).toEqual({ scope: "my.app_2", key: "STRIPE_SECRET_KEY" });
});

test("rejects malformed references", () => {
  const bad = [
    "",
    "OPENAI_API_KEY",
    "https://example.com/x",
    "kerstel://",
    "kerstel://global",
    "kerstel://global/",
    "kerstel:///KEY",
    "kerstel://global/KEY/EXTRA",
    "kerstel://Bad-Upper/KEY",
    "kerstel://global/1STARTS_WITH_DIGIT",
    "kerstel://global/has-dash",
    "kerstel://глобал/KEY",
    " kerstel://global/KEY",
    "kerstel://global/KEY ",
  ];
  for (const value of bad) {
    expect(parseReference(value)).toBeNull();
    expect(isReference(value)).toBe(false);
  }
});

test("isReference agrees with parseReference on every fixture", () => {
  for (const { value, valid } of REFERENCE_FIXTURES) {
    expect(isReference(value)).toBe(valid);
    expect(parseReference(value) !== null).toBe(valid);
  }
});

test("formatReference rejects invalid components", () => {
  expect(() => formatReference("UPPER", "KEY")).toThrow(/scope/i);
  expect(() => formatReference("app", "bad-key")).toThrow(/key/i);
});
