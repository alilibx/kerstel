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
  /** Why `packageJson` is null, so the caller can name the actual problem. */
  packageJsonError: "missing" | "invalid" | null;
  packageName: string | null;
  /** The framework `package.json` depends on, when Kerstel recognises one. */
  framework: string | null;
  /** `.env*` files in the root, highest precedence first. */
  envFiles: EnvFileInfo[];
  /** `.env*` names that could not be read, such as a dangling symlink. */
  unreadableEnvFiles: string[];
  /**
   * `.env*` names that are editor or shell backup copies (`.env.bak`,
   * `.env.swp`, `.env.local~`). Skipped, and named so the user can delete the
   * plaintext they most likely still hold.
   */
  backupEnvFiles: string[];
}

/** Names that are templates for humans, never sources of real values. */
const TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"];

/**
 * Suffixes editors, `patch`, `cp -b`, and people leave behind. A copy like
 * `.env.bak` is not an environment any loader reads, and treating it as one
 * did two wrong things at once: its stale value outranked `.env` (rank 1 beats
 * rank 0), so the wrong secret went into the vault, and a Vim swap file got
 * parsed and rewritten in place.
 */
const BACKUP_SUFFIXES = [".bak", ".orig", ".old", ".save", ".backup", ".swp", ".swo", ".tmp", ".rej"];

/** `.env` or `.env.<something>`, before any template or backup judgement. */
function hasEnvPrefix(name: string): boolean {
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.");
}

/** Judge a name without its `.local` suffix: `.env.example.local` is still a template. */
function withoutLocal(name: string): string {
  return name.endsWith(".local") ? name.slice(0, -".local".length) : name;
}

/** An `.env*` name that is a backup copy rather than a file any loader reads. */
export function isBackupEnvFileName(name: string): boolean {
  if (!name.startsWith(".env")) return false;
  if (name.endsWith("~")) return true;
  if (!hasEnvPrefix(name)) return false;
  const base = withoutLocal(name);
  return BACKUP_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

export function isEnvFileName(name: string): boolean {
  if (!hasEnvPrefix(name)) return false;
  if (isBackupEnvFileName(name)) return false;
  return !TEMPLATE_SUFFIXES.some((suffix) => withoutLocal(name).endsWith(suffix));
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

interface EnvFileScan {
  found: EnvFileInfo[];
  unreadable: string[];
  backups: string[];
}

function scanEnvFiles(root: string): EnvFileScan {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return { found: [], unreadable: [], backups: [] };
  }

  const found: EnvFileInfo[] = [];
  const unreadable: string[] = [];
  const backups: string[] = [];
  for (const name of names) {
    const backup = isBackupEnvFileName(name);
    if (!backup && !isEnvFileName(name)) continue;
    const path = join(root, name);
    try {
      // A directory called `.env.d` is a real thing in some setups; reading it
      // as a file would throw EISDIR halfway through the wizard.
      if (!statSync(path).isFile()) continue;
    } catch {
      // statSync follows symlinks, so a dangling one lands here. It names an
      // env file the user expects to be migrated, so it is reported, not hidden.
      // A dangling backup holds nothing, so it is not worth a line.
      if (!backup) unreadable.push(name);
      continue;
    }
    if (backup) backups.push(name);
    else found.push({ name, path, rank: envFileRank(name) });
  }

  // Rank descending, then name ascending so the order is stable across
  // filesystems that do not enumerate in a fixed order.
  found.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  return { found, unreadable: unreadable.sort(), backups: backups.sort() };
}

export function discoverEnvFiles(root: string): EnvFileInfo[] {
  return scanEnvFiles(root).found;
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

type PackageJsonRead =
  | { json: Record<string, unknown>; error: null }
  | { json: null; error: "missing" | "invalid" };

function readPackageJson(path: string): PackageJsonRead {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return { json: null, error: "missing" };
  }
  try {
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { json: null, error: "invalid" };
    return { json: parsed as Record<string, unknown>, error: null };
  } catch {
    // The caller reports it; a malformed package.json must not crash `init`
    // before it can say which file is wrong.
    return { json: null, error: "invalid" };
  }
}

/** First match wins: Vite sits under most of the others, so it goes last. Spec §5.1. */
const FRAMEWORKS: ReadonlyArray<readonly [test: (name: string) => boolean, label: string]> = [
  [(n) => n === "next", "Next.js"],
  [(n) => n === "nuxt", "Nuxt"],
  [(n) => n === "@sveltejs/kit", "SvelteKit"],
  [(n) => n === "astro", "Astro"],
  [(n) => n.startsWith("@remix-run/"), "Remix"],
  [(n) => n === "vite", "Vite"],
];

export function detectFramework(packageJson: Record<string, unknown> | null): string | null {
  const names = ["dependencies", "devDependencies"].flatMap((field) => {
    const deps = packageJson?.[field];
    return deps && typeof deps === "object" ? Object.keys(deps) : [];
  });
  for (const [matches, label] of FRAMEWORKS) if (names.some(matches)) return label;
  return null;
}

export function detectProject(root: string): DetectedProject {
  const packageJsonPath = join(root, "package.json");
  const { json: packageJson, error: packageJsonError } = readPackageJson(packageJsonPath);
  const envScan = scanEnvFiles(root);
  const packageManager = detectPackageManager(root, packageJson);
  const name = packageJson?.name;

  return {
    root,
    runtime: packageManager === "bun" ? "bun" : "node",
    packageManager,
    packageJsonPath,
    packageJson,
    packageJsonError,
    packageName: typeof name === "string" && name.length > 0 ? name : null,
    framework: detectFramework(packageJson),
    envFiles: envScan.found,
    unreadableEnvFiles: envScan.unreadable,
    backupEnvFiles: envScan.backups,
  };
}
