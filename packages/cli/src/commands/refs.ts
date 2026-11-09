import { existsSync } from "node:fs";
import { fail, info } from "../output";
import { vaultPath } from "../paths";
import { scanProjectRefs, type ProjectRefs } from "../project-refs";
import { cliName } from "../ui/cli-name";
import { SYMBOLS, theme, type Theme } from "../ui/theme";
import { readStoredReferences, vaultReadError } from "../vault/meta";
import { readProjectRows } from "../vault/projects";

/**
 * `kerstel refs [--by-key]`: which project files reference which secrets, and
 * which secrets nothing references. Terminal UI spec §3.1.
 *
 * Reads the vault's names without its key, the way `init --dry-run` does, so
 * there is no Keychain prompt and nothing is decrypted or created. Exit 0
 * always: an unresolvable reference is information, and `doctor` judges.
 */

export function parseRefsArgs(args: string[]): { byKey: boolean } | { error: string } {
  let byKey = false;
  for (const arg of args) {
    if (arg === "--by-key") byKey = true;
    else return { error: `Unknown option ${arg}. Usage: ${cliName()} refs [--by-key]` };
  }
  return { byKey };
}

function pad(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, Bun.stringWidth(cell))));
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat(widths[i]! - Bun.stringWidth(cell))))
      .join("  ")
      .trimEnd(),
  );
}

const missing = (t: Theme) => t.red(`${SYMBOLS.problem} not in the vault`);

/** Scope, then checkout, then file, then its references. */
export function renderByProject(refs: ProjectRefs, t: Theme): string[] {
  const out: string[] = [];
  for (const checkout of refs.checkouts) {
    if (out.length > 0) out.push("");
    out.push(`${t.bold(checkout.scope)}  ${t.dim(checkout.rootPath)}`);
    const files = checkout.files.filter((file) => file.references.length > 0);
    if (files.length === 0) {
      out.push(`  ${t.dim("no references")}`);
      continue;
    }
    const rows: string[][] = [];
    for (const file of files) {
      const seen = new Set<string>();
      for (const r of file.references) {
        if (seen.has(r.reference)) continue;
        seen.add(r.reference);
        rows.push([seen.size === 1 ? file.name : "", r.reference, r.inVault ? "" : missing(t)]);
      }
    }
    out.push(...pad(rows).map((line) => `  ${line}`));
  }
  out.push(...tail(refs, t));
  return out;
}

/** Each stored secret, then the files that reference it; references the vault lacks last. */
export function renderByKey(refs: ProjectRefs, t: Theme): string[] {
  const byRef = new Map<string, { scope: string; path: string }[]>();
  for (const checkout of refs.checkouts) {
    for (const file of checkout.files) {
      for (const r of file.references) {
        const list = byRef.get(r.reference) ?? [];
        if (!list.some((x) => x.path === file.path)) list.push({ scope: checkout.scope, path: file.path });
        byRef.set(r.reference, list);
      }
    }
  }
  const unresolved = new Set(refs.unresolvable.map((u) => u.reference));
  const out: string[] = [];
  const resolved = [...byRef.keys()].filter((ref) => !unresolved.has(ref)).sort();
  for (const ref of resolved) {
    if (out.length > 0) out.push("");
    out.push(t.bold(ref));
    out.push(...pad(byRef.get(ref)!.map((x) => [x.scope, t.dim(x.path)])).map((line) => `  ${line}`));
  }
  if (unresolved.size > 0) {
    if (out.length > 0) out.push("");
    out.push(t.bold("Not in the vault"));
    out.push(
      ...pad(refs.unresolvable.map((u) => [u.reference, u.scope, t.dim(u.file)])).map(
        (line) => `  ${t.red(SYMBOLS.problem)} ${line}`,
      ),
    );
  }
  out.push(...tail(refs, t));
  return out;
}

/** Unreachable checkouts and unreferenced secrets, after either view. */
function tail(refs: ProjectRefs, t: Theme): string[] {
  const out: string[] = [];
  if (refs.unreachable.length > 0) {
    out.push("", t.bold("Unreachable"));
    out.push(
      ...pad(refs.unreachable.map((u) => [u.scope, t.dim(u.rootPath), u.reason])).map(
        (line) => `  ${t.red(SYMBOLS.problem)} ${line}`,
      ),
    );
  }
  if (refs.unreadable.length > 0) {
    out.push("", t.bold("Could not read"));
    out.push(
      ...pad(refs.unreadable.map((u) => [u.scope, t.dim(u.file), u.reason])).map(
        (line) => `  ${t.red(SYMBOLS.problem)} ${line}`,
      ),
    );
  }
  if (refs.unused.length > 0) {
    // Only the files that could be read were searched: a secret listed here
    // may still be used by a folder above, so it is not safe to delete yet.
    const partial = refs.unreachable.length + refs.unreadable.length > 0;
    out.push("", t.bold(partial ? "Referenced by no project that could be read" : "Referenced by no project"));
    out.push(...refs.unused.map((ref) => `  ${ref}`));
    if (partial) out.push(t.dim("  Check the folders and files above before deleting any of these."));
  }
  return out;
}

export async function refsCommand(
  args: string[],
  deps: { vault?: string; stdout?: (line: string) => void; theme?: Theme } = {},
): Promise<number> {
  const options = parseRefsArgs(args);
  if ("error" in options) {
    fail(options.error);
    return 2;
  }
  const file = deps.vault ?? vaultPath();
  const print = deps.stdout ?? ((line: string) => console.log(line));
  if (!existsSync(file)) {
    info(`No vault yet. Run \`${cliName()} init\` in a project to start one.`);
    return 0;
  }
  const problem = vaultReadError(file);
  if (problem) {
    fail(`Could not read the vault at ${file}: ${problem}. Run \`${cliName()} doctor\`.`);
    return 1;
  }
  const refs = scanProjectRefs(readProjectRows(file), readStoredReferences(file));
  if (refs.checkouts.length + refs.unreachable.length + refs.unused.length === 0) {
    info(`No projects are set up and the vault is empty. Run \`${cliName()} init\` in a project.`);
    return 0;
  }
  const t = deps.theme ?? theme;
  const lines = options.byKey ? renderByKey(refs, t) : renderByProject(refs, t);
  // A blank line separates sections; it never leads the output.
  while (lines[0] === "") lines.shift();
  for (const line of lines) print(line);
  return 0;
}
