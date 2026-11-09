export const GLOBAL_SCOPE = "global";
/** The 0.1 form, `kerstel://<scope>/<KEY>`. Still accepted, never written. */
export const REFERENCE_PROTOCOL = "kerstel://";
/** The short form, `ks:<scope>` or `ks:<scope>/<KEY>`. Matched in any case, written lowercase. */
export const SHORT_PROTOCOL = "ks:";

/** Scope: lowercase project name, or the reserved word `global`. */
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/** Key: the shell-safe environment variable name shape. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SecretRef {
  scope: string;
  key: string;
}

export function isValidScope(scope: string): boolean {
  return scope.length > 0 && scope.length <= 64 && SCOPE_PATTERN.test(scope);
}

export function isValidKey(key: string): boolean {
  return key.length > 0 && key.length <= 128 && KEY_PATTERN.test(key);
}

/** Which spelling a reference uses, or null when the value is not one. */
export type ReferenceSyntax = "short" | "long";

interface Split {
  syntax: ReferenceSyntax;
  scope: string;
  /** Null for the shorthand `ks:<scope>`, whose key is the variable's name. */
  key: string | null;
}

function split(value: unknown): Split | null {
  if (typeof value !== "string") return null;
  if (value.startsWith(REFERENCE_PROTOCOL)) {
    const body = value.slice(REFERENCE_PROTOCOL.length);
    const slash = body.indexOf("/");
    if (slash <= 0) return null;
    return { syntax: "long", scope: body.slice(0, slash), key: body.slice(slash + 1) };
  }
  if (value.slice(0, SHORT_PROTOCOL.length).toLowerCase() === SHORT_PROTOCOL) {
    const body = value.slice(SHORT_PROTOCOL.length);
    const slash = body.indexOf("/");
    if (slash === -1) return { syntax: "short", scope: body, key: null };
    return { syntax: "short", scope: body.slice(0, slash), key: body.slice(slash + 1) };
  }
  return null;
}

/**
 * Parses a reference: `ks:<scope>/<KEY>`, `kerstel://<scope>/<KEY>`, or the
 * shorthand `ks:<scope>`, which names the key with the same name as the
 * variable holding it. Returns null for anything else, including plain values,
 * other URL schemes, structurally invalid references, and a shorthand with no
 * `name` to complete it. Callers treat null as "this is an ordinary plaintext
 * value, leave it alone".
 *
 * Pass `name` wherever the value came from a variable: a dotenv line or the
 * environment. Leave it out for a reference typed on its own, such as the
 * argument to `kerstel resolve`.
 */
export function parseReference(value: string, name?: string): SecretRef | null {
  const parts = split(value);
  if (!parts) return null;
  const key = parts.key ?? name;
  if (key === undefined) return null;
  if (!isValidScope(parts.scope) || !isValidKey(key)) return null;
  return { scope: parts.scope, key };
}

/** The syntax of a value that parses as a reference under `name`, or null. */
export function referenceSyntax(value: string, name?: string): ReferenceSyntax | null {
  return parseReference(value, name) === null ? null : split(value)!.syntax;
}

/** True for `ks:<scope>`, the form whose key comes from the variable's name. */
export function isShorthand(value: string): boolean {
  const parts = split(value);
  return parts !== null && parts.key === null && isValidScope(parts.scope);
}

export function isReference(value: string, name?: string): boolean {
  return parseReference(value, name) !== null;
}

function checkParts(scope: string, key: string): void {
  if (!isValidScope(scope)) {
    throw new Error(
      `Invalid scope "${scope}". Use "global" or a lowercase project name (letters, digits, . _ -).`,
    );
  }
  if (!isValidKey(key)) {
    throw new Error(
      `Invalid key "${key}". Use an environment variable name (letters, digits, _; not starting with a digit).`,
    );
  }
}

/**
 * `ks:<scope>/<KEY>`: a reference that means the same thing wherever it is
 * pasted. Used for every reference shown on its own, outside a dotenv line.
 */
export function formatReference(scope: string, key: string): string {
  checkParts(scope, key);
  return `${SHORT_PROTOCOL}${scope}/${key}`;
}

/**
 * The reference to write as the value of variable `name`: `ks:<scope>` when
 * the variable and the vault key share a name, `ks:<scope>/<KEY>` otherwise.
 * Pass `full` to always write the key, as for a variable that another line
 * of the project's env files expands (spec §5.1): the shorthand would name a
 * different key once copied under another name.
 */
export function formatEnvReference(name: string, scope: string, key: string, full = false): string {
  checkParts(scope, key);
  return !full && name === key ? `${SHORT_PROTOCOL}${scope}` : `${SHORT_PROTOCOL}${scope}/${key}`;
}

/** Shared cases so the hook's standalone parser can be proven equivalent. */
/**
 * Shared cases so the hook's standalone parser can be proven equivalent.
 * `name` is the variable the value is read under, where there is one.
 */
export const REFERENCE_FIXTURES: { value: string; name?: string; valid: boolean }[] = [
  { value: "kerstel://global/OPENAI_API_KEY", valid: true },
  { value: "kerstel://global/OPENAI_API_KEY", name: "OTHER", valid: true },
  { value: "kerstel://global/_PRIVATE", valid: true },
  { value: "kerstel://my-app/DATABASE_URL", valid: true },
  { value: "kerstel://my.app_2/A1", valid: true },
  { value: "", valid: false },
  { value: "plain-value", valid: false },
  { value: "postgres://user:pw@localhost/db", valid: false },
  { value: "kerstel://", valid: false },
  { value: "kerstel://global", valid: false },
  { value: "kerstel://global", name: "KEY", valid: false },
  { value: "kerstel://global/", valid: false },
  { value: "kerstel:///KEY", valid: false },
  { value: "kerstel://global/KEY/EXTRA", valid: false },
  { value: "kerstel://Bad-Upper/KEY", valid: false },
  { value: "kerstel://global/1DIGIT", valid: false },
  { value: "kerstel://global/has-dash", valid: false },
  { value: " kerstel://global/KEY", valid: false },
  { value: "kerstel://global/KEY ", valid: false },
  { value: "KERSTEL://global/KEY", valid: false },
  { value: "ks:global/OPENAI_API_KEY", valid: true },
  { value: "ks:global/OPENAI_API_KEY", name: "OPENAI_KEY", valid: true },
  { value: "ks:my-app/DATABASE_URL", valid: true },
  { value: "KS:global/KEY", valid: true },
  { value: "Ks:global/KEY", valid: true },
  { value: "ks:global", name: "OPENAI_API_KEY", valid: true },
  { value: "KS:my.app_2", name: "_A1", valid: true },
  { value: "ks:global", valid: false },
  { value: "ks:global", name: "FOO.BAR", valid: false },
  { value: "ks:global", name: "1DIGIT", valid: false },
  { value: "ks:", valid: false },
  { value: "ks:", name: "KEY", valid: false },
  { value: "ks:/KEY", valid: false },
  { value: "ks:global/", valid: false },
  { value: "ks:global/", name: "KEY", valid: false },
  { value: "ks:global/KEY/EXTRA", valid: false },
  { value: "ks:Global", name: "KEY", valid: false },
  { value: "ks:global/has-dash", valid: false },
  { value: " ks:global", name: "KEY", valid: false },
  { value: "ks:global ", name: "KEY", valid: false },
  { value: "ks: global", name: "KEY", valid: false },
  { value: "ks://global/KEY", valid: false },
  { value: "kstest", name: "KEY", valid: false },
  { value: "ks-global", name: "KEY", valid: false },
];
