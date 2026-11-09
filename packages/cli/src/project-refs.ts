import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectProject, readPackageJson } from "./init/detect";
import { parseDotenv } from "./init/dotenv-file";
import { formatReference, parseReference, type SecretRef } from "./reference";
import type { ProjectRecord } from "./vault/store";

/**
 * Which registered project files reference which secrets. Terminal UI spec
 * (`2026-09-19-terminal-ui-design.md`) §3.1. `kerstel refs`, the References
 * screen, and `uninstall`'s planner all read references through here, so what
 * one calls unresolvable or unused the others do too.
 *
 * Reads project files and never writes them. Existence is judged by name,
 * from the set of stored `scope/KEY` pairs the caller passes, so nothing is
 * decrypted.
 */

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One reference on one line of an env file. */
export interface LineReference {
  /** Index into `parseDotenv(...).lines`; the line number is this plus one. */
  index: number;
  /** The variable that holds it. */
  key: string;
  ref: SecretRef;
  /** Always the full `ks:<scope>/<KEY>`, whatever the line spells. */
  reference: string;
}

/** Every reference in an env file's text, in line order. */
export function lineReferences(source: string): LineReference[] {
  const out: LineReference[] = [];
  parseDotenv(source).lines.forEach((line, index) => {
    if (line.kind !== "pair") return;
    const ref = parseReference(line.value, line.key);
    if (ref) out.push({ index, key: line.key, ref, reference: formatReference(ref.scope, ref.key) });
  });
  return out;
}

/**
 * Why a registered checkout cannot be read, or null when it can. The same
 * reasons `uninstall` gives, since it cannot restore such a checkout either.
 */
export function unreachableReason(root: string): string | null {
  if (!existsSync(root)) return "the folder no longer exists";
  const read = readPackageJson(join(root, "package.json"));
  if (read.error === "missing") return "it has no package.json";
  if (read.error === "invalid") return "its package.json is not valid JSON";
  return null;
}

export interface FileReferences {
  path: string;
  /** The file's name, e.g. `.env.local`. */
  name: string;
  /**
   * The bytes this scan read. `uninstall` restores from these same bytes, so
   * what it calls used and what it puts back come from one read of the file.
   */
  original: string;
  /** Empty for an env file with no references; it is still listed, for `uninstall`. */
  references: (LineReference & { inVault: boolean })[];
}

export interface CheckoutReferences {
  scope: string;
  rootPath: string;
  files: FileReferences[];
}

export interface UnreachableCheckout {
  scope: string;
  rootPath: string;
  reason: string;
}

/** An env file in a reachable checkout that could not be read, such as one with no read permission. */
export interface UnreadableFile {
  scope: string;
  rootPath: string;
  file: string;
  reason: string;
}

export interface UnresolvableReference {
  scope: string;
  rootPath: string;
  file: string;
  reference: string;
}

export interface ProjectRefs {
  /** Reachable checkouts, in row order. */
  checkouts: CheckoutReferences[];
  unreachable: UnreachableCheckout[];
  /** Env files that could not be read. Their references are unknown, so nothing they might use is "unused" for sure. */
  unreadable: UnreadableFile[];
  /** References whose secret the vault does not hold. */
  unresolvable: UnresolvableReference[];
  /** Stored secrets no reachable checkout references, as full references, sorted. */
  unused: string[];
}

/**
 * Reads every registered checkout's env files. `stored` is every `scope/KEY`
 * the vault holds (`readStoredReferences`, or `listSecrets` on an open vault).
 */
export function scanProjectRefs(projects: ProjectRecord[], stored: Set<string>): ProjectRefs {
  const result: ProjectRefs = { checkouts: [], unreachable: [], unreadable: [], unresolvable: [], unused: [] };
  const used = new Set<string>();

  for (const project of projects) {
    const reason = unreachableReason(project.rootPath);
    if (reason) {
      result.unreachable.push({ scope: project.name, rootPath: project.rootPath, reason });
      continue;
    }
    const checkout: CheckoutReferences = { scope: project.name, rootPath: project.rootPath, files: [] };
    const detected = detectProject(project.rootPath);
    for (const name of detected.unreadableEnvFiles) {
      result.unreadable.push({
        scope: project.name,
        rootPath: project.rootPath,
        file: join(project.rootPath, name),
        reason: "it could not be read (a broken symlink?)",
      });
    }
    for (const info of detected.envFiles) {
      // One unreadable file must not hide every other checkout's references.
      let original: string;
      try {
        original = readFileSync(info.path, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        result.unreadable.push({
          scope: project.name,
          rootPath: project.rootPath,
          file: info.path,
          reason: code === "EACCES" || code === "EPERM" ? "permission denied" : `it could not be read (${code ?? "error"})`,
        });
        continue;
      }
      const references = lineReferences(original).map((line) => {
        const inVault = stored.has(`${line.ref.scope}/${line.ref.key}`);
        if (inVault) used.add(`${line.ref.scope}/${line.ref.key}`);
        else {
          result.unresolvable.push({
            scope: project.name,
            rootPath: project.rootPath,
            file: info.path,
            reference: line.reference,
          });
        }
        return { ...line, inVault };
      });
      checkout.files.push({ path: info.path, name: info.name, original, references });
    }
    result.checkouts.push(checkout);
  }

  result.unused = [...stored]
    .filter((pair) => !used.has(pair))
    .map((pair) => {
      const slash = pair.indexOf("/");
      return { scope: pair.slice(0, slash), key: pair.slice(slash + 1) };
    })
    // Scope, then key: the order `ks ls` lists them in.
    .sort((a, b) => (a.scope === b.scope ? compare(a.key, b.key) : compare(a.scope, b.scope)))
    .map((ref) => formatReference(ref.scope, ref.key));
  return result;
}
