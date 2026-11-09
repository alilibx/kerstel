import { parseReference } from "../reference";
import type { Choice } from "./prompts";

/**
 * What the wizard SUGGESTS for a key. Never what it decides: `init` prints the
 * suggestion, the user changes it per key, and only `--yes` accepts the whole
 * set — which is the user asking for exactly that.
 *
 * The bias is deliberate: guessing "plaintext" for a real secret is the one
 * mistake that leaves a secret in a file, so every plaintext rule below is
 * shape-based and narrow (a boolean, a number, a URL with no credentials in
 * it), the shape rules yield to a key that NAMES a credential, and anything
 * ambiguous falls through to "project".
 */

export type Suggestion = "project" | "global" | "plaintext";

/** The three choices, in the order the wizard offers them. */
export const SUGGESTIONS: readonly Suggestion[] = ["project", "global", "plaintext"];

export interface Explanation {
  suggestion: Suggestion;
  reason: string;
}

/**
 * Credentials for services a developer holds ONE account with, across every
 * project on the machine. Pointing a project at the global copy is the
 * one-keystroke choice spec §5 asks for.
 */
export const GLOBAL_KEYS: readonly string[] = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "HF_TOKEN",
  "REPLICATE_API_TOKEN",
  "STRIPE_SECRET_KEY",
  "SENDGRID_API_KEY",
  "TWILIO_AUTH_TOKEN",
];

/** Keys whose values are configuration, not credentials, by convention. */
const PLAINTEXT_KEYS =
  /^(NODE_ENV|PORT|HOST|LOG_LEVEL|DEBUG|CI|TZ|LANG|LC_.*|PUBLIC_.*|NEXT_PUBLIC_.*|VITE_.*)$/;

/**
 * Key names that ANNOUNCE a credential. A key matching this is never suggested
 * plaintext on the strength of its value's shape alone: `PASSWORD=secret` and
 * `REDIS_PASSWORD=redis` are short lowercase words, and a shape rule that
 * cannot tell them from `NODE_ENV=production` would leave a real password in
 * the file under `--yes`.
 *
 * A whole segment, not a substring: AUTHOR_NAME is not an AUTH key.
 */
const SECRET_KEYS =
  /(^|[^A-Za-z0-9])(PASSWORD|PASSWD|PASSPHRASE|PASSCODE|PASS|PWD|PIN|SECRET|TOKEN|KEY|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SECRET_?KEY|AUTH|CREDENTIALS?|DSN)($|[^A-Za-z0-9])/i;

/**
 * A query parameter that hands the credential over in the URL itself --
 * a presigned link, a webhook with its token in the query. The parameter NAME
 * has to end with the word, so `?monkey=1` is not a key; `apikey` and `auth`
 * are named whole, since they carry no separator.
 */
const SECRET_QUERY =
  /[?&](([^=&]*[-_.])?(key|token|secret|password|sig|signature)|apikey|auth)=/i;

/**
 * A path segment that looks like a credential rather than a route: 16 or more
 * characters mixing letters and digits, as in a Slack or Discord webhook.
 * Used only to decide what may be PRINTED, never what stays in a file.
 */
const OPAQUE_SEGMENT = /\/(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}(?=[/?#]|$)/;

/**
 * Values that carry a well-known credential prefix: Stripe and OpenAI-style
 * `sk_`/`sk-`/`rk_`, Google `AIza`, GitHub `ghp_` and friends, Slack `xox?-`,
 * AWS `AKIA`, and a JWT (`eyJ…`, as Supabase keys are). Whatever the key is
 * called, such a value is never printed.
 */
const TOKEN_PREFIX = /^(sk[-_]|rk_|AIza|gh[pousr]_|github_pat_|xox[abprs]-|AKIA[0-9A-Z]{12}|eyJ[A-Za-z0-9_-]{8,}\.)/;

const BOOLEANS = new Set(["true", "false", "yes", "no", "on", "off", "1", "0"]);
const NUMBER = /^-?\d+(\.\d+)?$/;
const URL_HEAD = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
const SINGLE_LOWERCASE_WORD = /^[a-z]+$/;

/**
 * The URL's authority (host, plus userinfo if present) when `value` starts
 * with a `scheme://`, or `null` when it isn't a URL at all. Userinfo in the
 * authority (`user:pass@host`) is a positive secret signal — stronger than
 * any key-name convention — so callers check for `@` in the result before
 * falling back to the credentialless case.
 */
function urlAuthority(value: string): string | null {
  const match = URL_HEAD.exec(value);
  if (!match) return null;
  return match[2] ?? "";
}

const SHARED = "You probably use this account in every project";
const UNSURE = "Might be a secret, so it's safer in the vault";

function stored(key: string, reason: string): Explanation {
  return GLOBAL_KEYS.includes(key) ? { suggestion: "global", reason: SHARED } : { suggestion: "project", reason };
}

/**
 * The order below is the whole design, so it is worth stating:
 *
 *   1. A value with no content to protect (empty, or a boolean) is
 *      plaintext whatever the key is called. A number is plaintext too,
 *      unless the key names a credential: `PIN=4821` and
 *      `DB_PASSWORD=12345678` are secrets that happen to be digits.
 *   2. A URL is judged on its own contents first: userinfo or a credential in
 *      the query beats every key-name convention.
 *   3. `PUBLIC_*` and friends beat the credential words, because a developer
 *      who named a key PUBLIC_API_KEY has declared it public.
 *   4. A key that names a credential beats the value-SHAPE plaintext rules,
 *      which cannot tell `PASSWORD=secret` from `NODE_ENV=production`.
 */
export function explain(key: string, value: string): Explanation {
  const trimmed = value.trim();

  if (trimmed === "") return { suggestion: "plaintext", reason: "It's empty, so there's nothing to protect" };
  if (BOOLEANS.has(trimmed.toLowerCase())) {
    return { suggestion: "plaintext", reason: "An on/off switch or a number, not a credential" };
  }
  if (NUMBER.test(trimmed)) {
    if (SECRET_KEYS.test(key) && !PLAINTEXT_KEYS.test(key)) return stored(key, "The name says it's a secret");
    return { suggestion: "plaintext", reason: "An on/off switch or a number, not a credential" };
  }

  const authority = urlAuthority(trimmed);
  if (authority !== null) {
    if (authority.includes("@")) return { suggestion: "project", reason: "The URL has a username and password in it" };
    if (SECRET_QUERY.test(trimmed)) return { suggestion: "project", reason: "The URL carries a key or token" };
    if (PLAINTEXT_KEYS.test(key)) return { suggestion: "plaintext", reason: "A setting, not a credential" };
    return SECRET_KEYS.test(key)
      ? stored(key, "The name says it's a secret")
      : { suggestion: "plaintext", reason: "A plain URL with no credentials in it" };
  }

  if (PLAINTEXT_KEYS.test(key)) return { suggestion: "plaintext", reason: "A setting, not a credential" };
  if (SECRET_KEYS.test(key)) return stored(key, "The name says it's a secret");
  if (trimmed.length < 8 && SINGLE_LOWERCASE_WORD.test(trimmed)) {
    return { suggestion: "plaintext", reason: "A short word, like a mode or a name" };
  }
  return stored(key, UNSURE);
}

/**
 * May the overview print this value in full? Spec §5.1 step 2. Narrower than
 * `explain`, on purpose: `explain` decides what stays in the FILE, and a
 * number or a plain URL there is harmless, but printing `DB_PASSWORD=12345678`
 * or a webhook URL with its token in the path puts it on screen and, under
 * `--yes`, into CI logs.
 *
 * A key that names a credential is never shown, even behind a `PUBLIC_`,
 * `VITE_` or `NEXT_PUBLIC_` prefix: those prefixes are bundler namespaces, and
 * people do put live keys behind them. Nor is a value that carries a known
 * token prefix, or a URL with a password, a token in its query, or an opaque
 * credential-like path segment, whatever its key.
 *
 * Past those, true only for a key that is configuration by convention
 * (`PORT`, `NODE_ENV`, `PUBLIC_*`), or for a value with no content worth
 * hiding -- empty, a boolean, a number, a short lowercase word. A URL is shown
 * only under a configuration key. The caller still combines this with where
 * the value is going and with `--keep`.
 */
export function isSafeToDisplay(key: string, value: string): boolean {
  const trimmed = value.trim();
  if (SECRET_KEYS.test(key) || TOKEN_PREFIX.test(trimmed)) return false;
  const authority = urlAuthority(trimmed);
  if (authority !== null && (authority.includes("@") || SECRET_QUERY.test(trimmed) || OPAQUE_SEGMENT.test(trimmed))) {
    return false;
  }
  if (PLAINTEXT_KEYS.test(key)) return true;
  return (
    trimmed === "" ||
    BOOLEANS.has(trimmed.toLowerCase()) ||
    NUMBER.test(trimmed) ||
    (trimmed.length < 8 && SINGLE_LOWERCASE_WORD.test(trimmed))
  );
}

/** What the wizard SUGGESTS. See `explain` for why; the two cannot disagree. */
export function suggest(key: string, value: string): Suggestion {
  return explain(key, value).suggestion;
}

/** The three destinations, in the words every menu uses. Spec §5.2. */
export function DESTINATION_CHOICES(scope: string): Choice<Suggestion>[] {
  return [
    { value: "project", label: "Vault, for this project only", hint: `Only ${scope} can read it` },
    { value: "global", label: "Vault, shared by all your projects", hint: "For accounts you use everywhere, like an OpenAI key" },
    { value: "plaintext", label: "Keep as plain text", hint: "Stays in the file. For settings, not secrets" },
  ];
}

/**
 * `kerstel scan`'s verdict on one line. Spec `2026-11-09-kerstel-scan-design.md` §2.2.
 *
 * Built on `explain()`, so `scan` and `init` cannot disagree about what is a
 * credential. The one difference is `unclear`: `explain()` sends a value it
 * cannot place to the vault, which is the right default when migrating, but a
 * scan that failed on `APP_NAME=Northwind Traders` would fail forever.
 */
export type Verdict = "reference" | "secret" | "unclear" | "config";

/** A PEM private key pasted on one line, with `\n` escapes. */
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

export function judge(key: string, value: string): Verdict {
  if (parseReference(value, key)) return "reference";
  const trimmed = value.trim();
  // A token prefix is evidence whatever the key is called:
  // NEXT_PUBLIC_STRIPE_KEY=sk_live_... is a live key behind a bundler prefix.
  if (TOKEN_PREFIX.test(trimmed) || PEM_PRIVATE_KEY.test(trimmed)) return "secret";
  const { suggestion, reason } = explain(key, value);
  if (suggestion === "plaintext") return "config";
  return reason === UNSURE ? "unclear" : "secret";
}

/** Does the key's name alone say it holds a credential? For a value `scan` cannot read. */
export function namesCredential(key: string): boolean {
  return SECRET_KEYS.test(key) && !PLAINTEXT_KEYS.test(key);
}

/** Query parameters that carry a credential, with their values. Same names as `SECRET_QUERY`. */
const SECRET_QUERY_VALUES =
  /[?&](?:(?:[^=&#]*[-_.])?(?:key|token|secret|password|sig|signature)|apikey|auth)=([^&#]*)/gi;
const PLACEHOLDER_RUN = /[xX]{3,}|\*{3,}|0{3,}/;
const PLACEHOLDER_WORD = /your|here|replace|example|changeme/i;

/**
 * Does a credential in a template look real rather than like a placeholder?
 * Scan spec §2.2: 16 or more characters mixing letters and digits, with no run
 * of x, * or 0 and none of the words starters use in placeholders.
 */
export function looksReal(credential: string): boolean {
  return (
    credential.length >= 16 &&
    /[A-Za-z]/.test(credential) &&
    /\d/.test(credential) &&
    !PLACEHOLDER_RUN.test(credential) &&
    !PLACEHOLDER_WORD.test(credential)
  );
}

/**
 * A value in `.env.example` and friends that is certainly a real credential.
 * Templates are full of `STRIPE_SECRET_KEY=sk_test_xxx` and
 * `postgres://postgres:postgres@localhost`, so key names and weak signals
 * don't count here: only a real-looking token, URL password, or query
 * credential, or a private key.
 */
export function isTemplateSecret(value: string): boolean {
  const trimmed = value.trim();
  if (PEM_PRIVATE_KEY.test(trimmed)) return true;
  if (TOKEN_PREFIX.test(trimmed) && looksReal(trimmed)) return true;
  const head = URL_HEAD.exec(trimmed);
  if (head) {
    const authority = head[2] ?? "";
    const at = authority.lastIndexOf("@");
    if (at !== -1) {
      const userinfo = authority.slice(0, at);
      const colon = userinfo.indexOf(":");
      if (colon !== -1 && looksReal(userinfo.slice(colon + 1))) return true;
    }
    for (const match of trimmed.matchAll(SECRET_QUERY_VALUES)) {
      if (looksReal(match[1] ?? "")) return true;
    }
  }
  return false;
}
