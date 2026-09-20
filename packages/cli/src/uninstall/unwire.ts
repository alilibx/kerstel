import { unwireScript } from "../init/script-shell";
import { EXEC_PREFIX, GITIGNORE_NOTE, serializePackageJson } from "../init/wiring";

/**
 * The inverse of init's wiring. Only what `init` wrote is undone: a script
 * that starts with exactly EXEC_PREFIX loses it, and every other script,
 * including one the user wrote that calls `kerstel` themselves, is untouched.
 */
export function unwirePackageJson(source: string): { changed: boolean; contents: string; unwrapped: string[] } {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const unwrapped: string[] = [];

  const scripts = parsed.scripts;
  if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
    const table = scripts as Record<string, unknown>;
    for (const [name, value] of Object.entries(table)) {
      if (typeof value !== "string") continue;
      const after = unwireScript(value, [EXEC_PREFIX]);
      if (after === value) continue;
      table[name] = after;
      unwrapped.push(name);
    }
  }

  if (unwrapped.length === 0) return { changed: false, contents: source, unwrapped };
  return { changed: true, contents: serializePackageJson(parsed, source), unwrapped };
}

/**
 * `init` replaced the lines that hid .env files with GITIGNORE_NOTE. Once the
 * files hold plaintext again they must be hidden again, so the note becomes
 * `.env` and `.env.*`, keeping the file's line ending.
 */
export function restoreGitignore(source: string): { changed: boolean; contents: string } {
  const parts = source.split(/(\r\n|\n)/);
  let changed = false;
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    const eol = parts[i + 1] ?? "";
    if (text.trim() === GITIGNORE_NOTE) {
      const lineEnd = eol === "" ? "\n" : eol;
      out += `.env${lineEnd}.env.*${eol}`;
      changed = true;
    } else {
      out += text + eol;
    }
  }
  return { changed, contents: changed ? out : source };
}
