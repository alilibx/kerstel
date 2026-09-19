import { readFileSync } from "node:fs";
import { formatReference, type SecretRef } from "../reference";
import { collectKeys, type LoadedEnvFile } from "./collect";
import { detectProject, type EnvFileInfo, type PackageManager, type Runtime } from "./detect";
import { parseDotenv } from "./dotenv-file";
import { deriveScope } from "./project-name";
import { findShadowedBinaries } from "./shadow";
import { wirePackageJson } from "./wiring";

export interface ProjectStatus {
  root: string;
  /** Null when no valid scope can be derived -- the user must pass --scope. */
  scope: string | null;
  runtime: Runtime;
  packageManager: PackageManager;
  envFiles: string[];
  /** `wrappable` counts scripts `init` would wire; `wired` those already wired. */
  scripts: { wrappable: number; wired: number };
  references: { total: number; resolvable: number; unresolved: string[] };
  /** Env files that exist but could not be read, by name. */
  unreadable: string[];
  /** `node_modules/.bin/kerstel` and friends in this project or an ancestor, absolute. See shadow.ts. */
  shadowed: string[];
}

/**
 * `loadEnvFiles`, but a file that will not open is RECORDED rather than
 * thrown.
 *
 * `init` deliberately keeps the loud version: a wizard that is about to
 * rewrite a file it could not read must stop. `doctor` is the opposite tool --
 * it exists to report the broken state of a machine, so one unreadable
 * `.env` has to become a line of output, not a stack trace over the whole
 * diagnosis.
 */
function readEnvFiles(files: EnvFileInfo[]): { loaded: LoadedEnvFile[]; unreadable: string[] } {
  const loaded: LoadedEnvFile[] = [];
  const unreadable: string[] = [];
  for (const info of files) {
    try {
      const original = readFileSync(info.path, "utf8");
      loaded.push({ info, original, file: parseDotenv(original) });
    } catch {
      unreadable.push(info.name);
    }
  }
  return { loaded, unreadable };
}

/**
 * What `doctor` knows about the directory it is standing in. Returns null when
 * there is no project here, so `doctor` can simply skip the section.
 *
 * Everything is derived by ASKING THE SAME FUNCTIONS `init` uses -- "is this
 * wired?" is answered by running the wirer and seeing whether it would change
 * anything. A second, parallel notion of "wired" would eventually disagree
 * with the first, and the disagreement would show up as `doctor` calling a
 * working project broken.
 */
export function projectStatus(
  root: string,
  vault: { getSecret(ref: SecretRef): string | null },
): ProjectStatus | null {
  const detected = detectProject(root);
  if (!detected.packageJson) return null;

  let scope: string | null;
  try {
    scope = deriveScope({ packageName: detected.packageName, rootPath: detected.root }).scope;
  } catch {
    scope = null;
  }

  const packageSource = readFileSync(detected.packageJsonPath, "utf8");
  const wiring = wirePackageJson(packageSource);
  const wired = wiring.skipped.filter((skip) => skip.reason === "already-wired").length;

  const { loaded, unreadable } = readEnvFiles(detected.envFiles);
  let total = 0;
  let resolvable = 0;
  const unresolved: string[] = [];
  for (const key of collectKeys(loaded)) {
    if (!key.reference) continue;
    total += 1;
    if (vault.getSecret(key.reference) !== null) resolvable += 1;
    else unresolved.push(formatReference(key.reference.scope, key.reference.key));
  }

  return {
    root,
    scope,
    runtime: detected.runtime,
    packageManager: detected.packageManager,
    envFiles: detected.envFiles.map((file) => file.name),
    scripts: { wrappable: wired + wiring.rewrites.length, wired },
    references: { total, resolvable, unresolved },
    unreadable,
    shadowed: findShadowedBinaries(detected.root),
  };
}
