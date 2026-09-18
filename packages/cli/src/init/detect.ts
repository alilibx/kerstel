import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type Runtime = "node" | "bun";

export interface EnvFileInfo {
  /** File name, e.g. ".env.production.local". */
  name: string;
  path: string;
  /** Higher wins when the same KEY appears in several files. */
  rank: number;
}

export interface DetectedProject {
  root: string;
  runtime: Runtime;
  packageManager: PackageManager;
  packageJsonPath: string;
  /** Parsed package.json, or null when it is missing or not valid JSON. */
  packageJson: Record<string, unknown> | null;
  packageName: string | null;
  /** `.env*` files in the root, highest precedence first. */
  envFiles: EnvFileInfo[];
}

/** Names that are templates for humans, never sources of real values. */
const TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"];

export function isEnvFileName(name: string): boolean {
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  if (name === ".env.") return false;
  return !TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Spec §8 / ruling 6 precedence, highest first:
 *   .env.<x>.local (3) > .env.local (2) > .env.<x> (1) > .env (0)
 *
 * Kerstel has no environments yet, so this decides only which duplicate value is the
 * one stored in the vault. It is the convention Next.js, Vite and CRA all
 * follow, so it is the one a developer already expects.
 */
export function envFileRank(name: string): number {
  if (name === ".env") return 0;
  if (name === ".env.local") return 2;
  if (name.endsWith(".local")) return 3;
  return 1;
}

export function discoverEnvFiles(root: string): EnvFileInfo[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }

  const found: EnvFileInfo[] = [];
  for (const name of names) {
    if (!isEnvFileName(name)) continue;
    const path = join(root, name);
    try {
      // A directory called `.env.d` is a real thing in some setups; reading it
      // as a file would throw EISDIR halfway through the wizard.
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    found.push({ name, path, rank: envFileRank(name) });
  }

  // Rank descending, then name ascending so the order is stable across
  // filesystems that do not enumerate in a fixed order.
  return found.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
}

const LOCKFILES: ReadonlyArray<readonly [file: string, manager: PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export function detectPackageManager(
  root: string,
  packageJson: Record<string, unknown> | null,
): PackageManager {
  for (const [file, manager] of LOCKFILES) {
    if (existsSync(join(root, file))) return manager;
  }

  // Corepack's `packageManager: "pnpm@9.1.0"`. Present in repos that keep
  // lockfiles out of git, which is exactly when the loop above finds nothing.
  const field = packageJson?.packageManager;
  if (typeof field === "string") {
    const name = field.split("@")[0];
    if (name === "bun" || name === "pnpm" || name === "yarn" || name === "npm") return name;
  }

  return "npm";
}

function readPackageJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // Missing, unreadable, or malformed. The caller reports it; a malformed
    // package.json must not crash `init` before it can say which file is wrong.
    return null;
  }
}

export function detectProject(root: string): DetectedProject {
  const packageJsonPath = join(root, "package.json");
  const packageJson = readPackageJson(packageJsonPath);
  const packageManager = detectPackageManager(root, packageJson);
  const name = packageJson?.name;

  return {
    root,
    runtime: packageManager === "bun" ? "bun" : "node",
    packageManager,
    packageJsonPath,
    packageJson,
    packageName: typeof name === "string" && name.length > 0 ? name : null,
    envFiles: discoverEnvFiles(root),
  };
}
