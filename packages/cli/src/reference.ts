export const GLOBAL_SCOPE = "global";
export const REFERENCE_PROTOCOL = "kerstel://";

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

/**
 * Parses `kerstel://<scope>/<KEY>`. Returns null for anything else, including
 * plain values, other URL schemes, and structurally invalid references. Callers
 * treat null as "this is an ordinary plaintext value, leave it alone".
 */
export function parseReference(value: string): SecretRef | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith(REFERENCE_PROTOCOL)) return null;

  const body = value.slice(REFERENCE_PROTOCOL.length);
  const slash = body.indexOf("/");
  if (slash <= 0) return null;

  const scope = body.slice(0, slash);
  const key = body.slice(slash + 1);
  if (!isValidScope(scope) || !isValidKey(key)) return null;

  return { scope, key };
}

export function isReference(value: string): boolean {
  return parseReference(value) !== null;
}

export function formatReference(scope: string, key: string): string {
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
  return `${REFERENCE_PROTOCOL}${scope}/${key}`;
}

/** Shared cases so the hook's standalone parser can be proven equivalent. */
export const REFERENCE_FIXTURES: { value: string; valid: boolean }[] = [
  { value: "kerstel://global/OPENAI_API_KEY", valid: true },
  { value: "kerstel://global/_PRIVATE", valid: true },
  { value: "kerstel://my-app/DATABASE_URL", valid: true },
  { value: "kerstel://my.app_2/A1", valid: true },
  { value: "", valid: false },
  { value: "plain-value", valid: false },
  { value: "postgres://user:pw@localhost/db", valid: false },
  { value: "kerstel://", valid: false },
  { value: "kerstel://global", valid: false },
  { value: "kerstel://global/", valid: false },
  { value: "kerstel:///KEY", valid: false },
  { value: "kerstel://global/KEY/EXTRA", valid: false },
  { value: "kerstel://Bad-Upper/KEY", valid: false },
  { value: "kerstel://global/1DIGIT", valid: false },
  { value: "kerstel://global/has-dash", valid: false },
  { value: " kerstel://global/KEY", valid: false },
  { value: "kerstel://global/KEY ", valid: false },
];
