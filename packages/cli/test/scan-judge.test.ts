import { expect, test } from "bun:test";
import { isTemplateSecret, judge, looksReal, namesCredential } from "../src/init/classify";
import { isBinaryBackupName, isTemplateEnvFileName } from "../src/init/detect";
import { parseDotenv } from "../src/init/dotenv-file";

/**
 * A made-up key with a real service's prefix. Built at runtime so the source
 * holds no key-shaped literal for a secret scanner to flag.
 */
const fake = (prefix: string, rest: string) => `${prefix}${rest}`;

test("judge sorts lines into reference, secret, unclear and config", () => {
  expect(judge("OPENAI_API_KEY", "ks:global")).toBe("reference");
  expect(judge("OPENAI_KEY", "ks:global/OPENAI_API_KEY")).toBe("reference");
  expect(judge("DB", "kerstel://app/DB")).toBe("reference");

  expect(judge("STRIPE_SECRET_KEY", "anything-at-all")).toBe("secret");
  expect(judge("DB_PASSWORD", "12345678")).toBe("secret");
  expect(judge("DATABASE_URL", "postgres://user:pw@db.internal/app")).toBe("secret");
  expect(judge("HOOK", "https://api.example.com/x?token=abc")).toBe("secret");
  expect(judge("GITHUB_TOKEN", "short")).toBe("secret");

  expect(judge("APP_NAME", "Northwind Traders")).toBe("unclear");

  expect(judge("PORT", "3000")).toBe("config");
  expect(judge("NODE_ENV", "production")).toBe("config");
  expect(judge("API_URL", "https://api.example.com")).toBe("config");
  expect(judge("STRIPE_SECRET_KEY", "")).toBe("config");
});

test("a token prefix or a private key is a secret whatever the key is called", () => {
  expect(judge("NEXT_PUBLIC_STRIPE_KEY", fake("sk_live_", "abcdefghijklmnop"))).toBe("secret");
  expect(judge("VITE_GH", fake("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"))).toBe("secret");
  expect(judge("CERT", "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe("secret");
});

test("namesCredential reads the name alone, and a public prefix wins", () => {
  expect(namesCredential("SESSION_SECRET")).toBe(true);
  expect(namesCredential("AUTHOR_NAME")).toBe(false);
  expect(namesCredential("NEXT_PUBLIC_API_KEY")).toBe(false);
});

test("placeholders from common starters are not real", () => {
  for (const placeholder of [
    "sk_test_xxx",
    fake("sk_test_", "XXXXXXXXXXXXXXXXXXXXXXXX"),
    "ghp_your_token_here",
    "sk-replace-me-1234567890",
    fake("AKIA", "IOSFODNN7EXAMPLE"),
    "changeme12345678901234",
    fake("sk_live_", "************************"),
    "postgres",
    "00000000000000000000aaa",
  ]) {
    expect(looksReal(placeholder)).toBe(false);
  }
  expect(looksReal(fake("sk_live_", "51Hq8f3kQ2zP9mX4vB7nL1cR"))).toBe(true);
});

test("a template counts only certain, real-looking credentials", () => {
  expect(isTemplateSecret(fake("sk_live_", "51Hq8f3kQ2zP9mX4vB7nL1cR"))).toBe(true);
  expect(isTemplateSecret("https://svc.example/api?token=8f3kQ2zP9mX4vB7nL1cR")).toBe(true);
  expect(isTemplateSecret("https://svc.example/api?api_key=8f3kQ2zP9mX4vB7nL1cR&x=1")).toBe(true);
  expect(isTemplateSecret("postgres://app:Zq8f3kQ2zP9mX4vB7nL1@db.example/app")).toBe(true);
  expect(isTemplateSecret("-----BEGIN PRIVATE KEY-----\\nabc")).toBe(true);

  expect(isTemplateSecret("sk_test_xxx")).toBe(false);
  expect(isTemplateSecret("postgres://postgres:postgres@localhost/app")).toBe(false);
  expect(isTemplateSecret("https://svc.example/api?token=<your-token>")).toBe(false);
  expect(isTemplateSecret("a-long-password-with-no-signal-1234")).toBe(false);
  expect(isTemplateSecret("")).toBe(false);
});

test("file names: templates and binary swap files", () => {
  expect(isTemplateEnvFileName(".env.example")).toBe(true);
  expect(isTemplateEnvFileName(".env.sample.local")).toBe(true);
  expect(isTemplateEnvFileName(".env")).toBe(false);
  expect(isTemplateEnvFileName(".env.example.bak")).toBe(false);
  expect(isBinaryBackupName(".env.swp")).toBe(true);
  expect(isBinaryBackupName(".env.local.swo")).toBe(true);
  expect(isBinaryBackupName(".env.bak")).toBe(false);
});

test("the parser tags what it refuses, so scan can judge without the text", () => {
  const parsed = parseDotenv(
    [
      "UNQUOTED=-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBg",
      "-----END PRIVATE KEY-----",
      'QUOTED="-----BEGIN OPENSSH PRIVATE KEY-----',
      "b3BlbnNzaC1rZXk",
      '-----END OPENSSH PRIVATE KEY-----"',
      'NOTES="first line',
      'second line"',
      "MY-KEY=value",
      "just some text",
      "",
    ].join("\n"),
  );
  expect(parsed.unsupported.map((u) => [u.key, u.line, u.kind])).toEqual([
    ["UNQUOTED", 1, "pem"],
    ["QUOTED", 4, "pem"],
    ["NOTES", 7, "multiline"],
    ["MY-KEY", 9, "bad-key"],
    ["line 10", 10, "not-a-pair"],
  ]);
});
