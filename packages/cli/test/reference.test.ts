import { expect, test } from "bun:test";
import {
  REFERENCE_FIXTURES,
  formatEnvReference,
  formatReference,
  isReference,
  isShorthand,
  parseReference,
  referenceSyntax,
} from "../src/reference";

test("parses the short form", () => {
  expect(parseReference("ks:global/OPENAI_API_KEY")).toEqual({ scope: "global", key: "OPENAI_API_KEY" });
  expect(parseReference("ks:my-app/DATABASE_URL")).toEqual({ scope: "my-app", key: "DATABASE_URL" });
});

test("still parses the kerstel:// form", () => {
  expect(parseReference("kerstel://global/OPENAI_API_KEY")).toEqual({ scope: "global", key: "OPENAI_API_KEY" });
  expect(parseReference("kerstel://my-app/DATABASE_URL", "OTHER")).toEqual({ scope: "my-app", key: "DATABASE_URL" });
});

test("ks:<scope> takes its key from the variable's name, and needs one", () => {
  expect(parseReference("ks:global", "OPENAI_API_KEY")).toEqual({ scope: "global", key: "OPENAI_API_KEY" });
  expect(parseReference("ks:global")).toBeNull();
  // A full reference ignores the name it is read under.
  expect(parseReference("ks:global/OPENAI_API_KEY", "OPENAI_KEY")).toEqual({ scope: "global", key: "OPENAI_API_KEY" });
});

test("the ks: scheme matches in any case; kerstel:// only in lowercase", () => {
  expect(parseReference("KS:global/KEY")).toEqual({ scope: "global", key: "KEY" });
  expect(parseReference("Ks:global", "KEY")).toEqual({ scope: "global", key: "KEY" });
  expect(parseReference("KERSTEL://global/KEY")).toBeNull();
});

test("formatReference writes ks:<scope>/<KEY>, and parseReference reads it back", () => {
  const ref = formatReference("my.app_2", "STRIPE_SECRET_KEY");
  expect(ref).toBe("ks:my.app_2/STRIPE_SECRET_KEY");
  expect(parseReference(ref)).toEqual({ scope: "my.app_2", key: "STRIPE_SECRET_KEY" });
});

test("formatEnvReference drops the key only when the variable has the same name", () => {
  expect(formatEnvReference("OPENAI_API_KEY", "global", "OPENAI_API_KEY")).toBe("ks:global");
  expect(formatEnvReference("OPENAI_KEY", "global", "OPENAI_API_KEY")).toBe("ks:global/OPENAI_API_KEY");
  expect(formatEnvReference("OPENAI_API_KEY", "global", "OPENAI_API_KEY", true)).toBe("ks:global/OPENAI_API_KEY");
  for (const [name, key] of [
    ["A", "A"],
    ["A", "B"],
  ] as const) {
    expect(parseReference(formatEnvReference(name, "app", key), name)).toEqual({ scope: "app", key });
  }
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
    "ks:",
    "ks:/KEY",
    "ks:global/",
    "ks:global/KEY/EXTRA",
    "ks:Global/KEY",
    "ks://global/KEY",
    " ks:global/KEY",
    "ks:global/KEY ",
  ];
  for (const value of bad) {
    expect(parseReference(value, "KEY")).toBeNull();
    expect(isReference(value, "KEY")).toBe(false);
  }
});

test("ks:<scope> under a name that is not a valid key is plain text", () => {
  expect(parseReference("ks:global", "FOO.BAR")).toBeNull();
  expect(parseReference("ks:global", "1DIGIT")).toBeNull();
});

test("isShorthand and referenceSyntax tell the spellings apart", () => {
  expect(isShorthand("ks:global")).toBe(true);
  expect(isShorthand("KS:my-app")).toBe(true);
  expect(isShorthand("ks:global/KEY")).toBe(false);
  expect(isShorthand("kerstel://global/KEY")).toBe(false);
  expect(isShorthand("ks:Bad")).toBe(false);
  expect(referenceSyntax("ks:global", "KEY")).toBe("short");
  expect(referenceSyntax("ks:global/KEY")).toBe("short");
  expect(referenceSyntax("kerstel://global/KEY")).toBe("long");
  expect(referenceSyntax("ks:global")).toBeNull();
  expect(referenceSyntax("plain")).toBeNull();
});

test("isReference agrees with parseReference on every fixture", () => {
  for (const { value, name, valid } of REFERENCE_FIXTURES) {
    expect(isReference(value, name)).toBe(valid);
    expect(parseReference(value, name) !== null).toBe(valid);
  }
});

test("formatReference and formatEnvReference reject invalid components", () => {
  expect(() => formatReference("UPPER", "KEY")).toThrow(/scope/i);
  expect(() => formatReference("app", "bad-key")).toThrow(/key/i);
  expect(() => formatEnvReference("KEY", "UPPER", "KEY")).toThrow(/scope/i);
});
