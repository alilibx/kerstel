import { readFileSync } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import { isTemplateSecret, judge, namesCredential } from "../init/classify";
import { isBinaryBackupName, readPackageJson } from "../init/detect";
import { parseDotenv, type UnsupportedValue } from "../init/dotenv-file";
import { detectWorkspace, type Workspace } from "../init/workspace";
import { gitAvailable, gitStatuses, gitTopLevel, type GitFileStatus } from "../move/git";
import { vaultPath } from "../paths";
import { formatReference, parseReference } from "../reference";
import { readStoredReferences } from "../vault/meta";
import { projectForRoot, readProjectRows } from "../vault/projects";
import type { FileKind, FoundFile, WalkResult } from "./walk";

/**
 * What `kerstel scan` found. Spec `2026-11-09-kerstel-scan-design.md` §2 and §4.
 * Holds key names and line numbers, never a value.
 */

export interface LineFinding {
  key: string;
  line: number;
}

export interface ReferenceFinding extends LineFinding {
  /** Always the full `ks:<scope>/<KEY>`, even for a line with the shorthand. */
  ref: string;
  inVault: boolean;
}

export interface FileReport {
  path: string;
  name: string;
  /** Relative to its project's folder: `.env`, or `docker/.env` for a nested file. */
  rel: string;
  kind: FileKind;
  /** False for a swap file, which is binary, and for a file that could not be read. */
  read: boolean;
  /** Why it was not read. */
  notRead: "binary" | "unreadable" | null;
  git: GitFileStatus | null;
  secrets: LineFinding[];
  unclear: LineFinding[];
  config: number;
  references: ReferenceFinding[];
  unreadableLines: number[];
  /** A file `kerstel init` in its project would migrate. */
  initReads: boolean;
}

export interface ProjectReport {
  path: string;
  /** The package.json name, or the folder's name. */
  name: string;
  packageJson: boolean;
  /** The scope this folder is registered under, when `init` or `ks move` set it up. */
  scope: string | null;
  /** The workspace root this project belongs to, itself included. */
  workspace: string | null;
  files: FileReport[];
}

export interface ScanReport {
  root: string;
  folders: number;
  unreadable: string[];
  /** False when git is not installed, so no file has a git status. */
  git: boolean;
  /** Workspace roots found, with their member count. */
  workspaces: Map<string, Workspace>;
  projects: ProjectReport[];
  warnings: string[];
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** The nearest folder at or above `dir`, up to `root`, in `set`. */
function nearest(dir: string, root: string, set: Set<string>): string | null {
  let current = dir;
  while (isWithin(current, root)) {
    if (set.has(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function posix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function emptyFile(found: FoundFile, rel: string): FileReport {
  return {
    path: found.path,
    name: found.name,
    rel,
    kind: found.kind,
    read: true,
    notRead: null,
    git: null,
    secrets: [],
    unclear: [],
    config: 0,
    references: [],
    unreadableLines: [],
    initReads: false,
  };
}

/**
 * Judges a value `parseDotenv` refused, without its text, which the parser
 * never hands on. Spec §2.2.
 */
function judgeUnsupported(entry: UnsupportedValue, kind: FileKind, report: FileReport): void {
  if (entry.kind === "not-a-pair") {
    report.unreadableLines.push(entry.line);
    return;
  }
  const finding = { key: entry.key, line: entry.line };
  if (entry.kind === "pem") report.secrets.push(finding);
  else if (kind === "template") report.config += 1;
  else if (namesCredential(entry.key)) report.secrets.push(finding);
  else report.unclear.push(finding);
}

/** Reads one file and judges every line. `stored` is the vault's `scope/KEY` names. */
export function judgeFile(found: FoundFile, rel: string, stored: Set<string>): FileReport {
  const report = emptyFile(found, rel);
  if (isBinaryBackupName(found.name)) {
    report.read = false;
    report.notRead = "binary";
    return report;
  }
  let source: string;
  try {
    source = readFileSync(found.path, "utf8");
  } catch {
    report.read = false;
    report.notRead = "unreadable";
    return report;
  }

  const parsed = parseDotenv(source);
  parsed.lines.forEach((line, index) => {
    if (line.kind !== "pair") return;
    const finding = { key: line.key, line: index + 1 };
    const verdict = judge(line.key, line.value);
    if (verdict === "reference") {
      const ref = parseReference(line.value, line.key)!;
      report.references.push({
        ...finding,
        ref: formatReference(ref.scope, ref.key),
        inVault: stored.has(`${ref.scope}/${ref.key}`),
      });
    } else if (found.kind === "template") {
      if (isTemplateSecret(line.value)) report.secrets.push(finding);
      else report.config += 1;
    } else if (verdict === "secret") report.secrets.push(finding);
    else if (verdict === "unclear") report.unclear.push(finding);
    else report.config += 1;
  });
  for (const entry of parsed.unsupported) judgeUnsupported(entry, found.kind, report);
  report.secrets.sort((a, b) => a.line - b.line);
  report.unclear.sort((a, b) => a.line - b.line);
  report.unreadableLines.sort((a, b) => a - b);
  return report;
}

/** Fills in each file's git status, two git runs per repository. */
function addGitStatuses(walked: WalkResult, files: Map<string, FileReport>, enabled: boolean): boolean {
  if (!enabled || !gitAvailable()) return false;
  // A file belongs to the nearest work tree the walk saw, or to the one the
  // scan root sits in. Paths are given relative to that folder, which git
  // accepts whether or not it is the top of the tree.
  const anchors = new Set(walked.repoDirs);
  const rootInRepo = !walked.repoDirs.has(walked.root) && gitTopLevel(walked.root) !== null;
  if (rootInRepo) anchors.add(walked.root);

  const byAnchor = new Map<string, FoundFile[]>();
  for (const found of walked.files) {
    const anchor = nearest(found.dir, walked.root, anchors);
    if (!anchor) continue;
    byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), found]);
  }
  for (const [anchor, found] of byAnchor) {
    const rels = found.map((f) => posix(relative(anchor, f.path)));
    const statuses = gitStatuses(anchor, rels);
    if (!statuses) continue;
    found.forEach((f, i) => {
      const report = files.get(f.path);
      if (report) report.git = statuses.get(rels[i]!) ?? null;
    });
  }
  return true;
}

export interface BuildOptions {
  /** The vault to check references against. Defaults to this machine's. */
  vault?: string;
  /** For tests: false acts as if git were not installed. */
  git?: boolean;
}

/** Turns a walk into the report: projects, workspaces, judgements, and git. */
export function buildReport(walked: WalkResult, options: BuildOptions = {}): ScanReport {
  const vault = options.vault ?? vaultPath();
  // Names only: the scope and key columns are not encrypted, so this needs no
  // data key, no Keychain prompt, and creates nothing.
  const stored = readStoredReferences(vault);
  const rows = readProjectRows(vault);
  const warnings: string[] = [];

  // Projects: the nearest package.json folder, else the file's own folder.
  const projectOf = new Map<string, string>();
  for (const found of walked.files) projectOf.set(found.path, nearest(found.dir, walked.root, walked.packageDirs) ?? found.dir);
  const projectDirs = [...new Set(projectOf.values())];

  // Workspaces: any package folder at or above a project that declares one.
  const workspaces = new Map<string, Workspace>();
  const candidates = new Set<string>();
  for (const dir of projectDirs) {
    let current = dir;
    while (isWithin(current, walked.root)) {
      if (walked.packageDirs.has(current)) candidates.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  for (const dir of [...candidates].sort()) {
    const workspace = detectWorkspace(dir, (message) => warnings.push(message));
    if (workspace) workspaces.set(dir, workspace);
  }
  const workspaceOf = (dir: string): string | null => {
    if (workspaces.has(dir)) return dir;
    for (const [root, workspace] of workspaces) if (workspace.members.includes(dir)) return root;
    return null;
  };

  const reports = new Map<string, FileReport>();
  const projects = new Map<string, ProjectReport>();
  for (const dir of projectDirs.sort()) {
    const packageJson = walked.packageDirs.has(dir);
    const name = packageJson ? readPackageJson(`${dir}${sep}package.json`).json?.name : null;
    projects.set(dir, {
      path: dir,
      name: typeof name === "string" && name !== "" ? name : basename(dir),
      packageJson,
      scope: projectForRoot(rows, dir)?.name ?? null,
      workspace: workspaceOf(dir),
      files: [],
    });
  }
  for (const found of walked.files) {
    const project = projects.get(projectOf.get(found.path)!)!;
    const report = judgeFile(found, posix(relative(project.path, found.path)), stored);
    report.initReads = found.kind === "env" && found.dir === project.path && project.packageJson;
    project.files.push(report);
    reports.set(found.path, report);
  }
  const git = addGitStatuses(walked, reports, options.git ?? true);

  return {
    root: walked.root,
    folders: walked.folders,
    unreadable: walked.unreadable,
    git,
    workspaces,
    projects: [...projects.values()],
    warnings,
  };
}

/** What a file with secrets should have done to it. Spec §5.1, in this order. */
export type AdviceGroup = "tracked" | "template" | "backup" | "init" | "other";

export function adviceFor(file: FileReport): AdviceGroup | null {
  if (file.secrets.length === 0) return null;
  if (file.git === "tracked") return "tracked";
  if (file.kind === "template") return "template";
  if (file.kind === "backup") return "backup";
  return file.initReads ? "init" : "other";
}

export function hasSecrets(report: ScanReport): boolean {
  return report.projects.some((p) => p.files.some((f) => f.secrets.length > 0));
}
