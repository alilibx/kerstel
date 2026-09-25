import { readFileSync } from "node:fs";
import { formatReference, type SecretRef } from "../reference";
import { collectKeys, type LoadedEnvFile } from "./collect";
import { detectProject, type EnvFileInfo, type PackageManager, type Runtime } from "./detect";
import { parseDotenv } from "./dotenv-file";
import { deriveScope } from "./project-name";
import { findShadowedBinaries } from "./shadow";
import { launcherStatus, type LauncherStatus } from "./launcher";
import { scriptState, type ScriptSkipReason } from "./script-shell";
import { EXEC_PREFIX, LEGACY_EXEC_PREFIX, wirePackageJson } from "./wiring";
import { canonicalRoot, checkScopeOwner, projectForRoot } from "../vault/projects";
import type { ProjectRecord } from "../vault/store";

export interface ProjectStatus {
  root: string;
  /** Null when no valid scope can be derived -- the user must pass --scope. */
  scope: string | null;
  runtime: Runtime;
  packageManager: PackageManager;
  envFiles: string[];
  /**
   * `wrappable` counts scripts `init` would wire; `wired` those fully wired
   * already; `partlyWired` names scripts where only some commands carry the
   * prefix; `skipped` names the ones the wirer refuses, with the reason.
   */
  scripts: {
    wrappable: number;
    wired: number;
    /** Wired in full, but with the `kerstel exec -- ` form an older Kerstel wrote. `init` converts them. */
    oldForm: string[];
    partlyWired: string[];
    skipped: Array<{ name: string; reason: ScriptSkipReason }>;
  };
  /** The committed launcher, or null when no script is wired in any form, so there is nothing to check. */
  launcher: LauncherStatus | null;
  references: { total: number; resolvable: number; unresolved: string[] };
  /** Env files that exist but could not be read, by name. */
  unreadable: string[];
  /** `node_modules/.bin/kerstel` and friends in this project or an ancestor, absolute. See shadow.ts. */
  shadowed: string[];
  /** Other registered checkouts of this scope, by root (checkouts spec §6.4). */
  otherCheckouts: string[];
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
  vault: { getSecret(ref: SecretRef): string | null; listProjects?(): ProjectRecord[] },
): ProjectStatus | null {
  const detected = detectProject(root);
  if (!detected.packageJson) return null;

  // The scope `init` registered for this folder wins: a checkout set up with
  // --scope custom is `custom`, which the package name cannot say.
  const projects = vault.listProjects?.() ?? [];
  const recorded = projectForRoot(projects, detected.root);
  let scope: string | null = recorded?.name ?? null;
  if (scope === null) {
    try {
      scope = deriveScope({ packageName: detected.packageName, rootPath: detected.root }).scope;
    } catch {
      scope = null;
    }
  }
  // Only rows for the same package are checkouts of this one: a different
  // package sharing the scope on purpose (`init --scope`) is not.
  const here = canonicalRoot(detected.root);
  const elsewhere = projects.filter((p) => canonicalRoot(p.rootPath) !== here);
  const owner = scope === null ? null : checkScopeOwner(elsewhere, scope, detected.root, detected.packageName);
  const otherCheckouts = owner?.kind === "another-checkout" ? owner.roots : [];

  const packageSource = readFileSync(detected.packageJsonPath, "utf8");
  const wiring = wirePackageJson(packageSource);
  const wired = wiring.skipped.filter((skip) => skip.reason === "already-wired").length;
  const stateOf = (rewrite: { before: string }) => scriptState(rewrite.before, EXEC_PREFIX, [LEGACY_EXEC_PREFIX]).state;
  const oldForm = wiring.rewrites.filter((rewrite) => stateOf(rewrite) === "wired-old-form").map((r) => r.name);
  const partlyWired = wiring.rewrites.filter((rewrite) => stateOf(rewrite) === "partly-wired").map((r) => r.name);
  const skipped = wiring.skipped.flatMap((skip) =>
    skip.reason === "lifecycle" || skip.reason === "already-wired" || skip.reason === "not-a-string"
      ? []
      : [{ name: skip.name, reason: skip.reason }],
  );
  const anyWired = wired + oldForm.length + partlyWired.length > 0;

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
    scripts: { wrappable: wired + wiring.rewrites.length, wired, oldForm, partlyWired, skipped },
    launcher: anyWired ? launcherStatus(detected.root) : null,
    references: { total, resolvable, unresolved },
    unreadable,
    shadowed: findShadowedBinaries(detected.root),
    otherCheckouts,
  };
}
