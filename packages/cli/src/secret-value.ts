import { MAX_LINE_CHARS } from "./daemon/protocol";
import { isValidKey, isValidScope } from "./reference";

/**
 * What a stored value, scope and key must satisfy, and the sentence each
 * refusal prints. `kerstel set` and the UI's add and edit share these, so
 * they refuse the same things in the same words. Terminal UI spec §4.4.
 */

/**
 * The longest value Kerstel stores. One longer than a protocol line could be
 * stored but never resolved: the daemon's reply would exceed MAX_LINE_CHARS
 * and the connection would be dropped. The JSON envelope costs a little of the
 * budget, so this leaves headroom rather than allowing exactly the cap.
 */
export const MAX_VALUE_CHARS = MAX_LINE_CHARS - 1_024;

/** Why `value` cannot be stored, or null when it can. */
export function valueProblem(value: string): string | null {
  if (value === "") return "No value supplied. Pipe the secret on stdin, or pass --value.";
  if (value.length > MAX_VALUE_CHARS) {
    return (
      `That value is ${value.length} characters; Kerstel can transport at most ${MAX_VALUE_CHARS}. ` +
      "The daemon could store it but never serve it. Store a path or a shorter credential instead."
    );
  }
  return null;
}

export function scopeProblem(scope: string): string | null {
  return isValidScope(scope) ? null : `Invalid scope "${scope}". Use a lowercase name of letters, digits, . _ or -.`;
}

export function keyProblem(key: string): string | null {
  return isValidKey(key)
    ? null
    : `Invalid key "${key}". Use an ENV_STYLE name of letters, digits and _, not starting with a digit.`;
}
