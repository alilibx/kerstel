import { basename } from "node:path";
import { isValidScope } from "../reference";

const MAX_SCOPE_CHARS = 64;

/**
 * Turns a package or directory name into a scope that `isValidScope()`
 * accepts: `^[a-z0-9][a-z0-9._-]*$`, at most 64 characters.
 *
 * Returns "" when nothing usable survives, so the caller decides what to do
 * about it rather than being handed an invalid scope that fails later, deeper.
 */
export function slugifyScope(input: string): string {
  // An npm scope (`@acme/web`) names an org, not this project. Keep the part
  // that actually identifies the package. Only npm's own `@scope/name` syntax
  // triggers this — an ordinary slash elsewhere (e.g. a stray "a//b") is just
  // an invalid character the next step replaces.
  const withoutOrg = input.startsWith("@") && input.includes("/") ? input.slice(input.indexOf("/") + 1) : input;

  let slug = withoutOrg
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".");

  // Trim every separator from both ends, not only "-" and ".": a leading "_"
  // passes the character class but fails the first-character rule, and a scope
  // that fails validation this late is a crash three steps from its cause.
  slug = slug.replace(/^[._-]+/, "").replace(/[._-]+$/, "");

  if (slug.length > MAX_SCOPE_CHARS) {
    slug = slug.slice(0, MAX_SCOPE_CHARS).replace(/[._-]+$/, "");
  }

  return isValidScope(slug) ? slug : "";
}

export interface DerivedScope {
  scope: string;
  source: "package.json" | "directory";
}

/**
 * The project's vault scope. `package.json` `name` first because it is what
 * the developer already calls this project; the directory basename second
 * because a private project often has no name at all.
 */
export function deriveScope(options: { packageName: string | null; rootPath: string }): DerivedScope {
  if (options.packageName) {
    const fromPackage = slugifyScope(options.packageName);
    if (fromPackage) return { scope: fromPackage, source: "package.json" };
  }

  const fromDirectory = slugifyScope(basename(options.rootPath));
  if (fromDirectory) return { scope: fromDirectory, source: "directory" };

  throw new Error(
    `Kerstel could not derive a project name from "${options.packageName ?? ""}" or the directory ` +
      `"${options.rootPath}". Pass one explicitly: kerstel init --scope <name>`,
  );
}
