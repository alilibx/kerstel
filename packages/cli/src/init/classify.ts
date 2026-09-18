/**
 * What the wizard SUGGESTS for a key. Never what it decides: `init` prints the
 * suggestion, the user changes it per key, and only `--yes` accepts the whole
 * set — which is the user asking for exactly that.
 *
 * The bias is deliberate: guessing "plaintext" for a real secret is the one
 * mistake that leaves a secret in a file, so every plaintext rule below is
 * shape-based and narrow (a boolean, a number, a URL with no credentials in
 * it), and anything ambiguous falls through to "project".
 */

export type Suggestion = "project" | "global" | "plaintext";

/** The three choices, in the order the wizard offers them. */
export const SUGGESTIONS: readonly Suggestion[] = ["project", "global", "plaintext"];

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

export function suggest(key: string, value: string): Suggestion {
  const trimmed = value.trim();

  if (trimmed === "") return "plaintext";
  if (BOOLEANS.has(trimmed.toLowerCase())) return "plaintext";
  if (NUMBER.test(trimmed)) return "plaintext";

  const authority = urlAuthority(trimmed);
  if (authority !== null) {
    // `postgres://user:pass@host/db` carries a credential regardless of what
    // the key is called; `https://api.example.com/v1` carries none.
    return authority.includes("@") ? "project" : "plaintext";
  }

  if (trimmed.length < 8 && SINGLE_LOWERCASE_WORD.test(trimmed)) return "plaintext";
  if (PLAINTEXT_KEYS.test(key)) return "plaintext";

  if (GLOBAL_KEYS.includes(key)) return "global";

  return "project";
}
