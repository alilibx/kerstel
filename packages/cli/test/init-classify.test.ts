import { expect, test } from "bun:test";
import type { Choice } from "../src/init/prompts";
import {
  DESTINATION_CHOICES,
  GLOBAL_KEYS,
  SUGGESTIONS,
  explain,
  isSafeToDisplay,
  suggest,
  type Suggestion,
} from "../src/init/classify";

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
  // Short credential names, and bare *_KEY names, are credentials too.
  ["DB_PASS", "hunter", "project"],
  ["SMTP_PWD", "letmein", "project"],
  ["DOOR_PASSCODE", "abc", "project"],
  ["GPG_PASSPHRASE", "correct horse", "project"],
  ["SIGNING_KEY", "secret", "project"],
  ["MASTER_KEY", "abc", "project"],
  // A number under a credential name is a secret that happens to be digits.
  ["PIN", "4821", "project"],
  ["SMTP_PASS", "12345678", "project"],
  ["ENCRYPTION_KEY", "12345678901234567890", "project"],
  ["DB_PASSWORD", "12345678", "project"],
  // A number under any other name, or under a declared-public name, is still a setting.
  ["PORT", "3000", "plaintext"],
  ["NEXT_PUBLIC_PIN_LENGTH", "4", "plaintext"],
  // A boolean stays a switch even under a credential word.
  ["AUTH_ENABLED", "true", "plaintext"],
  // Whole segments only: SPINNER is not PIN, KEYBOARD is not KEY, PASSENGER is not PASS.
  ["SPINNER_STYLE", "dots", "plaintext"],
  ["KEYBOARD_LAYOUT", "us", "plaintext"],
  ["PASSENGER_COUNT", "4", "plaintext"],
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

test.each([
  ["EMPTY", "", "plaintext" as Suggestion, "It's empty, so there's nothing to protect"],
  ["DEBUG", "true", "plaintext" as Suggestion, "An on/off switch or a number, not a credential"],
  ["DATABASE_URL", "postgres://u:pw@db/app", "project" as Suggestion, "The URL has a username and password in it"],
  ["WEBHOOK", "https://x.test/hook?token=abc", "project" as Suggestion, "The URL carries a key or token"],
  ["NEXT_PUBLIC_API", "https://api.test", "plaintext" as Suggestion, "A setting, not a credential"],
  ["OPENAI_API_KEY", "sk-abcdefgh12345678", "global" as Suggestion, "You probably use this account in every project"],
  ["DB_PASSWORD", "hunter2hunter2", "project" as Suggestion, "The name says it's a secret"],
  ["API_BASE", "https://api.test/v1", "plaintext" as Suggestion, "A plain URL with no credentials in it"],
  ["MODE", "dev", "plaintext" as Suggestion, "A short word, like a mode or a name"],
  ["SESSION_BLOB", "a9f8e7d6c5b4a3f2", "project" as Suggestion, "Might be a secret, so it's safer in the vault"],
  ["PIN", "4821", "project" as Suggestion, "The name says it's a secret"],
])("explain(%s) suggests %s with its reason", (key, value, suggestion, reason) => {
  expect(explain(key, value)).toEqual({ suggestion, reason });
  expect(suggest(key, value)).toBe(suggestion);
});

test("the destination choices carry the spec's labels and hints", () => {
  expect(DESTINATION_CHOICES("whasal")).toEqual([
    { value: "project", label: "Vault, for this project only", hint: "Only whasal can read it" },
    { value: "global", label: "Vault, shared by all your projects", hint: "For accounts you use everywhere, like an OpenAI key" },
    { value: "plaintext", label: "Keep as plain text", hint: "Stays in the file. For settings, not secrets" },
  ]);
});

test.each([
  ["PORT", "3000", true],
  ["NODE_ENV", "development", true],
  ["PUBLIC_SITE_URL", "https://example.com", true],
  ["FEATURE_FLAG", "true", true],
  ["RETRIES", "3", true],
  ["MODE", "fast", true],
  ["EMPTY", "", true],
  ["DB_PASSWORD", "12345678", false],
  ["STRIPE_SECRET_KEY", "1234567890", false],
  ["PIN", "4821", false],
  ["DB_PASS", "hunter", false],
  ["SIGNING_KEY", "secret", false],
  ["API_TOKEN", "true", false],
  ["SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T0/B0/abc", false],
  ["HOMEPAGE", "https://example.com", false],
  ["SESSION_ID", "a-long-opaque-value", false],
  // A public prefix is a bundler namespace, not a promise the value is public:
  // a credential word in the name, or a token-shaped value, still masks it.
  ["VITE_SUPABASE_KEY", "sk_live_4f9abcdef", false],
  ["NEXT_PUBLIC_API_KEY", "sk_live_4f9abcdef", false],
  ["PUBLIC_TOKEN", "sk_live_4f9abcdef", false],
  ["VITE_ANALYTICS_ID", "sk_live_4f9abcdef", false],
  ["NEXT_PUBLIC_MAPS", "AIzaSyA-1234567890abcdef", false],
  ["VITE_GITHUB", "ghp_abcdefghijklmnop", false],
  ["VITE_API_URL", "https://user:pass@api.example.com", false],
  ["NEXT_PUBLIC_FEED", "https://example.com/feed?token=abc", false],
  ["VITE_API_URL", "https://api.example.com", true],
  ["NEXT_PUBLIC_ANALYTICS_ID", "G-ABCDEFGHIJ", true],
] as const)("isSafeToDisplay(%p, …) is %p", (key, value, expected) => {
  expect(isSafeToDisplay(key, value)).toBe(expected);
});
