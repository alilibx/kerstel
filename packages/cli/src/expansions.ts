/**
 * Names that a `$NAME` or `${NAME}` (including `${NAME:-default}`) in env file
 * text refers to. `@next/env`, `dotenv-expand` and Docker Compose all expand
 * these by copying the other variable's raw value, so a reference that a line
 * copies must name its key in full: the shorthand `ks:<scope>` would name a
 * different key under the new variable. Short-references spec §5.1.
 *
 * Deliberately broad: a `$NAME` in a comment or a single-quoted value counts
 * too. Counting one too many only means writing `ks:<scope>/<KEY>` where
 * `ks:<scope>` would have done; counting one too few points a variable at the
 * wrong key.
 */
export function expandedNames(sources: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]!);
  }
  return names;
}
