import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectProject, readPackageJson, type DetectedProject } from "./detect";

/**
 * A monorepo root and its member packages. Monorepo spec
 * (`2026-09-19-monorepo-and-checkouts-design.md`) §2 and §3. `kerstel scan`
 * uses it to group packages, and `init` at a root (#34) uses it to set them up.
 */
export interface Workspace {
  root: string;
  source: "package.json" | "pnpm-workspace.yaml";
  /** Every member folder holding a `package.json`, sorted by path. The root is not one. */
  members: string[];
  /** The root first when it has env files, then members with env files, by path. */
  packages: DetectedProject[];
}

/** The `workspaces` globs from package.json: an array, or an object with a `packages` array. */
function packageJsonGlobs(json: Record<string, unknown> | null): string[] | null {
  const field = json?.workspaces;
  const list = Array.isArray(field)
    ? field
    : field && typeof field === "object" && Array.isArray((field as { packages?: unknown }).packages)
      ? (field as { packages: unknown[] }).packages
      : null;
  if (!list) return null;
  return list.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The `packages:` list of a pnpm-workspace.yaml, as a block sequence of plain or
 * quoted strings. Anything else is null, so a YAML feature this reader does not
 * understand can never pick the wrong folders. Other top-level keys (`catalog:`,
 * settings) are ignored; a file without `packages:` lists none.
 */
export function parsePnpmPackages(source: string): string[] | null {
  const lines = source.split(/\r\n|\n|\r/);
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (start === -1) return [];
  if (!/^packages\s*:\s*(#.*)?$/.test(lines[start]!)) return null;

  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const item = /^\s+-\s+(.*?)\s*$/.exec(line);
    if (!item) return null;
    const text = item[1]!;
    const quoted = /^(['"])(.*)\1\s*(#.*)?$/.exec(text);
    if (quoted) {
      globs.push(quoted[2]!);
      continue;
    }
    const plain = text.replace(/\s+#.*$/, "");
    if (plain === "" || /^['"[{&*!|>%@`]/.test(plain)) return null;
    globs.push(plain);
  }
  return globs;
}

function normalise(glob: string): string {
  return glob.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Member folders matched by the globs, relative to the root, sorted. */
function expandMembers(root: string, globs: string[]): string[] {
  const positive = globs.filter((g) => !g.startsWith("!")).map(normalise);
  const negative = globs.filter((g) => g.startsWith("!")).map((g) => new Bun.Glob(normalise(g.slice(1))));
  const found = new Set<string>();
  for (const glob of positive) {
    if (glob === "" || glob === ".") continue;
    let matches: Iterable<string>;
    try {
      matches = new Bun.Glob(`${glob}/package.json`).scanSync({ cwd: root, onlyFiles: true, dot: false });
    } catch {
      continue;
    }
    for (const match of matches) {
      const dir = match.replace(/\\/g, "/").replace(/\/package\.json$/, "");
      const segments = dir.split("/");
      if (segments.some((s) => s === "node_modules" || s.startsWith("."))) continue;
      if (negative.some((neg) => neg.match(dir))) continue;
      found.add(dir);
    }
  }
  return [...found].sort();
}

/**
 * The workspace rooted at `dir`, or null when `dir` is not a workspace root.
 * There is no upward search: a member is not a root.
 *
 * `warn` hears about a pnpm-workspace.yaml whose `packages:` this cannot read;
 * the folder is then treated as no workspace.
 */
export function detectWorkspace(dir: string, warn: (message: string) => void = () => {}): Workspace | null {
  const { json } = readPackageJson(join(dir, "package.json"));
  let globs = packageJsonGlobs(json);
  let source: Workspace["source"] = "package.json";

  const pnpmFile = join(dir, "pnpm-workspace.yaml");
  if (globs === null && existsSync(join(dir, "package.json")) && existsSync(pnpmFile)) {
    let text: string;
    try {
      text = readFileSync(pnpmFile, "utf8");
    } catch {
      return null;
    }
    const parsed = parsePnpmPackages(text);
    if (parsed === null) {
      warn(
        `${pnpmFile}: Kerstel reads its packages: list only as "- <glob>" lines, so this folder is treated as one project.`,
      );
      return null;
    }
    globs = parsed;
    source = "pnpm-workspace.yaml";
  }
  if (globs === null) return null;

  const members = expandMembers(dir, globs).map((rel) => join(dir, rel));
  const packages = [dir, ...members].map((root) => detectProject(root)).filter((p) => p.envFiles.length > 0);
  return { root: dir, source, members, packages };
}
