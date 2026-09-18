import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listBackups, readBackup } from "../init/backup";
import { collectKeys, loadEnvFiles, type LoadedEnvFile } from "../init/collect";
import { detectProject, envFileRank } from "../init/detect";
import { maskForDisplay } from "../init/display";
import { entries, parseDotenv, restoreLineValue, serializeDotenv } from "../init/dotenv-file";
import { backupsDir } from "../paths";
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

/**
 * A key whose values differed when `init` ran -- across files, or twice inside
 * one file. `init` kept one value in the vault; the others exist only in the
 * encrypted backup, which uninstall deletes along with the key that opens it.
 */
export interface BackupOnlyValue {
  project: string;
  key: string;
  /** The backed-up env files holding a value for this key that uninstall will not restore. */
  files: string[];
  /** The backup directory those values live in. */
  backupDir: string;
}

export interface RestoredProject {
  name: string;
  rootPath: string;
  /** Names of the env files this plan rewrites, e.g. [".env", ".env.local"]. */
  envFiles: string[];
}

export interface UninstallPlan {
  files: PlannedFile[];
  restored: RestoredProject[];
  unreachable: UnreachableProject[];
  unresolvable: UnresolvableReference[];
  /** kerstel:// references for vault secrets no reachable project uses. */
  unused: string[];
  backupOnly: BackupOnlyValue[];
}

export function emptyPlan(): UninstallPlan {
  return { files: [], restored: [], unreachable: [], unresolvable: [], unused: [], backupOnly: [] };
}

/**
 * Keys in a project's LATEST backup whose values were collapsed by `init`,
 * narrowed to the files where a backed-up value will not be back after the
 * restore. A key `init` left in plaintext (`--keep`, or a "plaintext" answer)
 * still holds every value in the live files, so it loses nothing and is not
 * reported. `restored` maps each env file name to its contents after the
 * restore. The backup is decrypted in memory only; no value leaves this function.
 */
function backupOnlyValues(project: string, dataKey: Buffer, restored: Map<string, string>): BackupOnlyValue[] {
  const timestamp = listBackups(project).at(-1);
  if (!timestamp) return [];
  const backupDir = join(backupsDir(), project, timestamp);

  // The manifest lists files in the order init loaded them, highest
  // precedence first, which is the order collectKeys expects.
  const loaded: LoadedEnvFile[] = readBackup(project, timestamp, dataKey).map((file) => ({
    info: { name: file.name, path: join(backupDir, file.name), rank: envFileRank(file.name) },
    original: file.contents,
    file: parseDotenv(file.contents),
  }));

  const flagged = new Map<string, Set<string>>();
  const flag = (key: string, files: string[]) => {
    const set = flagged.get(key) ?? new Set<string>();
    for (const file of files) set.add(file);
    flagged.set(key, set);
  };

  for (const key of collectKeys(loaded)) {
    if (key.conflicts.length > 0) flag(key.key, [key.source, ...key.conflicts]);
  }
  for (const entry of loaded) {
    const values = new Map<string, Set<string>>();
    for (const pair of entries(entry.file)) {
      const seen = values.get(pair.key) ?? new Set<string>();
      seen.add(pair.value);
      values.set(pair.key, seen);
    }
    for (const [key, seen] of values) if (seen.size > 1) flag(key, [entry.info.name]);
  }

  const valuesOf = (source: string, key: string) =>
    new Set(entries(parseDotenv(source)).filter((pair) => pair.key === key).map((pair) => pair.value));
  const loses = (entry: LoadedEnvFile, key: string) => {
    const after = valuesOf(restored.get(entry.info.name) ?? "", key);
    return [...valuesOf(entry.original, key)].some((value) => !after.has(value));
  };

  // Report files in backup (precedence) order, not discovery order.
  const result: BackupOnlyValue[] = [];
  for (const [key, files] of flagged) {
    const losing = loaded.filter((entry) => files.has(entry.info.name) && loses(entry, key));
    if (losing.length > 0) result.push({ project, key, files: losing.map((entry) => entry.info.name), backupDir });
  }
  return result;
}

/**
 * Plan-5 spec §6.1. Reads the vault and every registered project and works
 * out what uninstall would write and what it would lose. Writes nothing.
 *
 * Values come from the vault, not from the encrypted backups: a backup holds
 * what the files said when `init` ran, and restoring it would silently undo
 * every rotation since. The latest backup is still READ (in memory, with
 * `dataKey`), because it can hold the one thing the vault never did: the
 * losing values of a key `init` collapsed. See `backupOnlyValues`.
 */
export function planUninstall(vault: Vault, dataKey: Buffer): UninstallPlan {
  const plan = emptyPlan();
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

    const restoredEnvFiles: string[] = [];
    const restoredContents = new Map<string, string>();
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
        restoreLineValue(copy, i, value);
      }
      const after = serializeDotenv(copy);
      restoredContents.set(loaded.info.name, after);
      if (after === loaded.original) continue;
      restoredEnvFiles.push(loaded.info.name);
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

    plan.backupOnly.push(...backupOnlyValues(project.name, dataKey, restoredContents));
    plan.restored.push({ name: project.name, rootPath: root, envFiles: restoredEnvFiles });
  }

  plan.unused = vault
    .listSecrets()
    .map((secret) => formatReference(secret.scope, secret.key))
    .filter((reference) => !used.has(reference));

  return plan;
}

/** True when applying the plan would lose a secret. See the loss gate in spec §6.2. */
export function hasLoss(plan: UninstallPlan): boolean {
  return (
    plan.unreachable.length + plan.unresolvable.length + plan.unused.length + plan.backupOnly.length > 0
  );
}
