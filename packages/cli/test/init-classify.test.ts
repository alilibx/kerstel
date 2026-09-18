import { expect, test } from "bun:test";
import { GLOBAL_KEYS, SUGGESTIONS, type Suggestion, suggest } from "../src/init/classify";

const CASES: [key: string, value: string, expected: Suggestion][] = [
  // Plaintext: nothing worth encrypting.
  ["EMPTY", "", "plaintext"],
  ["BLANK", "   ", "plaintext"],
  ["ENABLE_X", "true", "plaintext"],
  ["ENABLE_Y", "FALSE", "plaintext"],
  ["FLAG_ON", "on", "plaintext"],
  ["ZERO", "0", "plaintext"],
  ["RETRIES", "3", "plaintext"],
  ["RATIO", "-1.5", "plaintext"],
  ["API_BASE", "https://api.example.com/v1", "plaintext"],
  ["REDIS_URL", "redis://localhost:6379", "plaintext"],
  ["SHORT_WORD", "local", "plaintext"],
  ["NODE_ENV", "development", "plaintext"],
  ["PORT", "3000", "plaintext"],
  ["HOST", "0.0.0.0", "plaintext"],
  ["LOG_LEVEL", "debug", "plaintext"],
  ["DEBUG", "app:*", "plaintext"],
  ["CI", "true", "plaintext"],
  ["TZ", "Europe/Berlin", "plaintext"],
  ["LANG", "en_US.UTF-8", "plaintext"],
  ["LC_ALL", "en_US.UTF-8", "plaintext"],
  ["PUBLIC_SITE_NAME", "Kerstel", "plaintext"],
  ["NEXT_PUBLIC_ANALYTICS_ID", "G-ABCDEFGHIJ", "plaintext"],
  ["VITE_API_URL", "https://api.example.com", "plaintext"],
  // Global: shared-service credentials that follow the developer, not the app.
  ["OPENAI_API_KEY", "sk-proj-abcdef1234567890", "global"],
  ["ANTHROPIC_API_KEY", "sk-ant-abcdef1234567890", "global"],
  ["GITHUB_TOKEN", "ghp_abcdef1234567890", "global"],
  ["AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "global"],
  ["STRIPE_SECRET_KEY", "sk_live_abcdef1234567890", "global"],
  // Project: everything else, including a URL that carries credentials.
  ["DATABASE_URL", "postgres://user:pass@db.internal:5432/app", "project"],
  ["SESSION_SECRET", "e3b0c44298fc1c149afbf4c8996fb924", "project"],
  ["INTERNAL_WEBHOOK_SECRET", "whsec_abcdefghijklmnop", "project"],
  ["ADMIN_PASSWORD", "hunter2hunter2", "project"],
  ["SMTP_URL", "smtps://postmaster:pw@smtp.example.com:465", "project"],
  // A URL's userinfo is a positive secret signal that outranks the key name.
  ["PORT", "postgres://u:p@h/db", "project"],
  ["HOST", "redis://default:secret@cache.internal:6379", "project"],
  // For a NON-url value, the key-name convention still wins — intended, not a gap.
  ["DEBUG", "sk-live-xxxxx", "plaintext"],
  // A literal boolean is never a secret, even under a global-credential key.
  ["OPENAI_API_KEY", "true", "plaintext"],
  // A key that NAMES a credential is never suggested plaintext, whatever
  // shape its value happens to have.
  ["REDIS_PASSWORD", "redis", "project"],
  ["PASSWORD", "secret", "project"],
  ["DB_PASSWD", "pw", "project"],
  ["SERVICE_AUTH", "abc", "project"],
  ["DB_DSN", "mysql://db.internal/app", "project"],
  ["VENDOR_CREDENTIALS", "abcd", "project"],
  ["MY_APIKEY", "short", "project"],
  ["AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE", "global"],
  // A URL is only harmless while its query carries no credential.
  ["API_URL", "https://h/?key=abc", "project"],
  ["WEBHOOK_URL", "https://hooks.example.com/t?x=1&token=abc", "project"],
  ["ASSET_URL", "https://cdn.example.com/a.png?sig=xyz", "project"],
  ["REPORT_URL", "https://h/r?api_key=abc", "project"],
  ["API_BASE", "https://api.example.com/v1?monkey=1", "plaintext"],
  // PUBLIC_ is a declaration by the developer, and it outranks the credential
  // word inside the same name.
  ["PUBLIC_API_KEY", "abc", "plaintext"],
  ["NEXT_PUBLIC_TOKEN", "x", "plaintext"],
  // A credential word has to be a whole segment: AUTHOR is not AUTH.
  ["AUTHOR_NAME", "ali", "plaintext"],
  // An empty value is still nothing to encrypt.
  ["PASSWORD", "", "plaintext"],
];

test("suggest classifies every documented case", () => {
  for (const [key, value, expected] of CASES) {
    expect(`${key}=${suggest(key, value)}`).toBe(`${key}=${expected}`);
  }
});

test("an empty value never becomes a stored secret, even for a global key", () => {
  expect(suggest("OPENAI_API_KEY", "")).toBe("plaintext");
});

test("the global list is exactly the documented set", () => {
  expect([...GLOBAL_KEYS].sort()).toEqual(
    [
      "ANTHROPIC_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "GEMINI_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GOOGLE_API_KEY",
      "HF_TOKEN",
      "NPM_TOKEN",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "REPLICATE_API_TOKEN",
      "SENDGRID_API_KEY",
      "STRIPE_SECRET_KEY",
      "TWILIO_AUTH_TOKEN",
    ].sort(),
  );
});

test("a long opaque value under an unknown key stays with the project", () => {
  expect(suggest("SOME_VENDOR_SECRET", "a7Xq02LmNp93ZtRv")).toBe("project");
});

test("SUGGESTIONS is the three choices in wizard order", () => {
  expect(SUGGESTIONS).toEqual(["project", "global", "plaintext"]);
});
