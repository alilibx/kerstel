import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFiles } from "../init/collect";
import { detectProject } from "../init/detect";
import { maskForDisplay } from "../init/display";
import { parseDotenv, serializeDotenv, setLineValue } from "../init/dotenv-file";
import type { DotenvPair } from "../init/dotenv-file";
import { formatReference, parseReference } from "../reference";
import type { Vault } from "../vault/store";
import { restoreGitignore, unwirePackageJson } from "./unwire";

export interface PlannedFile {
  path: string;
  /** Shown above the diff, e.g. "demo-app: .env". */
  label: string;
  after: string;
  diffBefore: string;
  diffAfter: string;
}

export interface UnreachableProject {
  name: string;
  rootPath: string;
  reason: string;
}

export interface UnresolvableReference {
  project: string;
  file: string;
  reference: string;
}

export interface UninstallPlan {
  files: PlannedFile[];
  restored: { name: string; rootPath: string }[];
  unreachable: UnreachableProject[];
  unresolvable: UnresolvableReference[];
  /** kerstel:// references for vault secrets no reachable project uses. */
  unused: string[];
}

/**
 * Plan-5 spec §6.1. Reads the vault and every registered project and works
 * out what uninstall would write and what it would lose. Writes nothing.
 *
 * Values come from the vault, not from the encrypted backups: a backup holds
 * what the files said when `init` ran, and restoring it would silently undo
 * every rotation since.
 */
export function planUninstall(vault: Vault): UninstallPlan {
  const plan: UninstallPlan = { files: [], restored: [], unreachable: [], unresolvable: [], unused: [] };
  const used = new Set<string>();

  for (const project of vault.listProjects()) {
    const root = project.rootPath;
    const unreachable = (reason: string) => plan.unreachable.push({ name: project.name, rootPath: root, reason });

    if (!existsSync(root)) {
      unreachable("the folder no longer exists");
      continue;
    }
    const packagePath = join(root, "package.json");
    if (!existsSync(packagePath)) {
      unreachable("it has no package.json");
      continue;
    }
    const packageSource = readFileSync(packagePath, "utf8");
    let unwired: ReturnType<typeof unwirePackageJson>;
    try {
      unwired = unwirePackageJson(packageSource);
    } catch {
      unreachable("its package.json is not valid JSON");
      continue;
    }

    for (const loaded of loadEnvFiles(detectProject(root).envFiles)) {
      const copy = parseDotenv(loaded.original);
      for (let i = 0; i < copy.lines.length; i += 1) {
        const line = copy.lines[i];
        if (!line || line.kind !== "pair") continue;
        const ref = parseReference(line.value);
        if (!ref) continue;
        const reference = formatReference(ref.scope, ref.key);
        const value = vault.getSecret(ref);
        if (value === null) {
          plan.unresolvable.push({ project: project.name, file: loaded.info.path, reference });
          continue;
        }
        used.add(reference);
        setLineValue(copy, i, value);
      }
      const after = serializeDotenv(copy);
      if (after === loaded.original) continue;
      plan.files.push({
        path: loaded.info.path,
        label: `${project.name}: ${loaded.info.name}`,
        after,
        diffBefore: maskForDisplay(loaded.original),
        diffAfter: maskForDisplay(after),
      });
    }

    // package.json and .gitignore hold no secrets, so their diffs are shown as they are.
    if (unwired.changed) {
      plan.files.push({
        path: packagePath,
        label: `${project.name}: package.json`,
        after: unwired.contents,
        diffBefore: packageSource,
        diffAfter: unwired.contents,
      });
    }

    const gitignorePath = join(root, ".gitignore");
    if (existsSync(gitignorePath)) {
      const source = readFileSync(gitignorePath, "utf8");
      const restored = restoreGitignore(source);
      if (restored.changed) {
        plan.files.push({
          path: gitignorePath,
          label: `${project.name}: .gitignore`,
          after: restored.contents,
          diffBefore: source,
          diffAfter: restored.contents,
        });
      }
    }

    plan.restored.push({ name: project.name, rootPath: root });
  }

  plan.unused = vault
    .listSecrets()
    .map((secret) => formatReference(secret.scope, secret.key))
    .filter((reference) => !used.has(reference));

  return plan;
}

/** True when applying the plan would lose a secret. See the loss gate in spec §6.2. */
export function hasLoss(plan: UninstallPlan): boolean {
  return plan.unreachable.length + plan.unresolvable.length + plan.unused.length > 0;
}
