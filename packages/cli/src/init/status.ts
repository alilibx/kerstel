import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { preloadPathFor } from "../commands/exec";
import { formatReference, type SecretRef } from "../reference";
import { collectKeys, loadEnvFiles } from "./collect";
import { detectProject, type PackageManager, type Runtime } from "./detect";
import { deriveScope } from "./project-name";
import { wireBunfig, wirePackageJson } from "./wiring";

export interface ProjectStatus {
  root: string;
  /** Null when no valid scope can be derived -- the user must pass --scope. */
  scope: string | null;
  runtime: Runtime;
  packageManager: PackageManager;
  envFiles: string[];
  /** `wrappable` counts scripts `init` would wire; `wired` those already wired. */
  scripts: { wrappable: number; wired: number };
  bunfig: "not-applicable" | "present" | "missing" | "unknown";
  references: { total: number; resolvable: number; unresolved: string[] };
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
  hookDir: string,
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

  let bunfig: ProjectStatus["bunfig"] = "not-applicable";
  if (detected.runtime === "bun") {
    const path = join(root, "bunfig.toml");
    const source = existsSync(path) ? readFileSync(path, "utf8") : null;
    try {
      bunfig = wireBunfig(source, preloadPathFor(hookDir)).changed ? "missing" : "present";
    } catch {
      // A multi-line preload array: present or not, this cannot say which.
      bunfig = "unknown";
    }
  }

  let total = 0;
  let resolvable = 0;
  const unresolved: string[] = [];
  for (const key of collectKeys(loadEnvFiles(detected.envFiles))) {
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
    bunfig,
    references: { total, resolvable, unresolved },
  };
}
