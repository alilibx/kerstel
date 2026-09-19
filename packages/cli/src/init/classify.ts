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
 * has to end with the word, so `?monkey=1` is not a key.
 */
const SECRET_QUERY =
  /[?&]([^=&]*[-_.])?(key|token|secret|password|sig|signature)=/i;

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
  return stored(key, "Might be a secret, so it's safer in the vault");
}

/**
 * May the overview print this value in full? Spec §5.1 step 2. Narrower than
 * `explain`, on purpose: `explain` decides what stays in the FILE, and a
 * number or a plain URL there is harmless, but printing `DB_PASSWORD=12345678`
 * or a webhook URL with its token in the path puts it on screen and, under
 * `--yes`, into CI logs.
 *
 * True only for a key that is configuration by convention (`PORT`,
 * `NODE_ENV`, `PUBLIC_*`), or for a value with no content worth hiding -- empty,
 * a boolean, a number, a short lowercase word -- under a key that does not
 * name a credential. A URL is shown only under a configuration key. The caller
 * still combines this with where the value is going and with `--keep`.
 */
export function isSafeToDisplay(key: string, value: string): boolean {
  if (PLAINTEXT_KEYS.test(key)) return true;
  if (SECRET_KEYS.test(key)) return false;
  const trimmed = value.trim();
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
