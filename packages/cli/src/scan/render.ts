import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { readPackageJson } from "../init/detect";
import { SYMBOLS, type Theme } from "../ui/theme";
import { adviceFor, hasSecrets, type AdviceGroup, type FileReport, type ProjectReport, type ScanReport } from "./report";

/**
 * `kerstel scan`'s output. Spec `2026-11-09-kerstel-scan-design.md` §5. Only
 * key names, line numbers and paths are printed, never a value: the report
 * holds none to print.
 */

export interface RenderOptions {
  keys: boolean;
  all: boolean;
  verbose: boolean;
  cli: string;
  home?: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function tilde(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(home + sep) ? `~${sep}${path.slice(home.length + 1)}` : path;
}

type Mark = "problem" | "warn" | "pass" | "info";

function missingRefs(file: FileReport): number {
  return file.references.filter((r) => !r.inVault).length;
}

export function fileMark(file: FileReport): Mark {
  if (file.secrets.length > 0 && (file.git === "tracked" || file.kind === "template")) return "problem";
  if (
    file.secrets.length > 0 ||
    file.unclear.length > 0 ||
    missingRefs(file) > 0 ||
    file.unreadableLines.length > 0 ||
    file.notRead === "unreadable"
  ) {
    return "warn";
  }
  return file.references.length > 0 ? "pass" : "info";
}

function needsAttention(file: FileReport): boolean {
  const mark = fileMark(file);
  return mark === "problem" || mark === "warn";
}

export function fileStatus(file: FileReport): string {
  const parts: string[] = [];
  if (file.kind === "backup") parts.push("backup copy");
  if (file.kind === "template") parts.push("template");
  if (file.notRead === "binary") parts.push("binary, not read");
  if (file.notRead === "unreadable") parts.push("could not be read");

  const counts: string[] = [];
  if (file.secrets.length > 0) counts.push(plural(file.secrets.length, "secret"));
  if (file.unclear.length > 0) counts.push(`${file.unclear.length} unclear`);
  if (counts.length > 0) parts.push(counts.join(", "));
  if (file.references.length > 0) {
    const missing = missingRefs(file);
    const refs = plural(file.references.length, "reference");
    parts.push(
      missing === 0 ? refs : missing === file.references.length ? `${refs} not in this vault` : `${refs}, ${missing} not in this vault`,
    );
  }
  if (file.unreadableLines.length > 0) parts.push(`${plural(file.unreadableLines.length, "line")} Kerstel can't read`);
  if (file.read && parts.length === (file.kind === "env" ? 0 : 1)) {
    parts.push(file.config > 0 ? (file.kind === "template" ? "no real keys" : "config only") : "empty");
  }
  if (file.secrets.length + file.unclear.length > 0) {
    if (file.git === "tracked") parts.push("tracked by git");
    else if (file.git === "not-ignored") parts.push("not ignored by git");
  }
  return parts.join(" · ");
}

function paint(theme: Theme, mark: Mark): string {
  if (mark === "problem") return theme.red(SYMBOLS.problem);
  if (mark === "warn") return theme.yellow(SYMBOLS.warn);
  if (mark === "pass") return theme.green(SYMBOLS.pass);
  return theme.dim(SYMBOLS.info);
}

function keyLines(file: FileReport, indent: string, theme: Theme): string[] {
  const rows: Array<{ line: number; key: string; what: string }> = [];
  for (const f of file.secrets) rows.push({ line: f.line, key: f.key, what: "secret" });
  for (const f of file.unclear) rows.push({ line: f.line, key: f.key, what: "unclear" });
  for (const r of file.references) {
    if (!r.inVault) rows.push({ line: r.line, key: r.key, what: `${r.ref} not in this vault` });
  }
  for (const line of file.unreadableLines) rows.push({ line, key: "", what: "can't be read" });
  const keyWidth = Math.max(0, ...rows.map((r) => r.key.length));
  const lineWidth = Math.max(0, ...rows.map((r) => `line ${r.line}`.length));
  return rows
    .sort((a, b) => a.line - b.line)
    .map((r) => `${indent}${r.key.padEnd(keyWidth)}  ${theme.dim(`line ${r.line}`.padEnd(lineWidth))}  ${r.what}`);
}

function fileLines(files: FileReport[], indent: string, options: RenderOptions, theme: Theme, width: number): string[] {
  const out: string[] = [];
  for (const file of files) {
    out.push(`${indent}${file.rel.padEnd(width)}${paint(theme, fileMark(file))} ${fileStatus(file)}`);
    if (options.keys) out.push(...keyLines(file, `${indent}  `, theme));
  }
  return out;
}

function projectLabel(project: ProjectReport): string {
  if (project.scope) return `set up as ${project.scope}`;
  return project.packageJson ? "" : "no package.json";
}

interface Group {
  root: ProjectReport | null;
  path: string;
  name: string;
  workspace: boolean;
  members: number;
  projects: ProjectReport[];
}

function groups(report: ScanReport): Group[] {
  const byRoot = new Map<string, Group>();
  for (const project of report.projects) {
    const key = project.workspace ?? project.path;
    let group = byRoot.get(key);
    if (!group) {
      const workspace = project.workspace ? report.workspaces.get(project.workspace) : undefined;
      group = {
        root: null,
        path: key,
        name: project.name,
        workspace: workspace !== undefined,
        members: workspace?.members.length ?? 0,
        projects: [],
      };
      byRoot.set(key, group);
    }
    if (project.path === key) {
      group.root = project;
      group.name = project.name;
    }
    group.projects.push(project);
  }
  for (const group of byRoot.values()) {
    if (!group.root && group.workspace) {
      // The root holds no env file of its own: name the group after its package.
      const name = readPackageJson(join(group.path, "package.json")).json?.name;
      group.name = typeof name === "string" && name !== "" ? name : basename(group.path);
    }
  }
  return [...byRoot.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function renderText(report: ScanReport, options: RenderOptions, theme: Theme): string[] {
  const home = options.home ?? homedir();
  const out: string[] = [];
  const fileCount = report.projects.reduce((n, p) => n + p.files.length, 0);
  const where = tilde(report.root, home);

  if (fileCount === 0) {
    out.push(`No env files under ${where}.`);
    out.push(...unreadableLines(report, options, theme, home));
    return out;
  }
  out.push(`Scanned ${where}: ${plural(report.folders, "folder")}, ${plural(fileCount, "env file")}`);

  let hidden = 0;
  for (const group of groups(report)) {
    const busy = group.projects.some((p) => p.files.some(needsAttention));
    if (!busy && !options.all) {
      hidden += 1;
      continue;
    }
    out.push("");
    const label = group.workspace
      ? `workspace, ${plural(group.members, "package")}`
      : group.root
        ? projectLabel(group.root)
        : "";
    out.push([theme.bold(group.name), theme.dim(tilde(group.path, home)), label].filter((s) => s !== "").join("  "));
    const width = Math.max(...group.projects.flatMap((p) => p.files.map((f) => f.rel.length))) + 2;
    if (!group.workspace) {
      out.push(...fileLines(group.projects[0]!.files, "  ", options, theme, width));
      continue;
    }
    for (const project of group.projects) {
      if (!options.all && !project.files.some(needsAttention)) continue;
      const rel = relative(group.path, project.path) || "(root)";
      const extra = projectLabel(project);
      out.push(`  ${rel}${extra ? `  ${theme.dim(extra)}` : ""}`);
      out.push(...fileLines(project.files, "    ", options, theme, width));
    }
  }
  if (hidden > 0) {
    out.push("");
    out.push(theme.dim(`${plural(hidden, "more project")} with nothing to do (--all lists them)`));
  }

  out.push("");
  out.push(...summary(report, options, theme, home));
  return out;
}

function unreadableLines(report: ScanReport, options: RenderOptions, theme: Theme, home: string): string[] {
  if (report.unreadable.length === 0) return [];
  const out = [
    `${theme.dim(SYMBOLS.info)}  ${plural(report.unreadable.length, "folder")} could not be read${options.verbose ? ":" : " (--verbose lists them)"}`,
  ];
  if (options.verbose) for (const dir of report.unreadable) out.push(`    ${tilde(dir, home)}`);
  return out;
}

function summary(report: ScanReport, options: RenderOptions, theme: Theme, home: string): string[] {
  const out: string[] = [];
  const by: Record<AdviceGroup, Array<{ file: FileReport; project: ProjectReport }>> = {
    tracked: [],
    template: [],
    backup: [],
    init: [],
    other: [],
  };
  let unclear = 0;
  // References `init` can fill in, by project, and the files it can't reach.
  const missingInit = new Map<string, number>();
  const missingOther: FileReport[] = [];
  for (const project of report.projects) {
    for (const file of project.files) {
      const group = adviceFor(file);
      if (group) by[group].push({ file, project });
      unclear += file.unclear.length;
      const missing = missingRefs(file);
      if (missing === 0) continue;
      if (file.initReads) missingInit.set(project.path, (missingInit.get(project.path) ?? 0) + missing);
      else missingOther.push(file);
    }
  }
  const red = `${theme.red(SYMBOLS.problem)}  `;
  const warn = `${theme.yellow(SYMBOLS.warn)}  `;
  const list = (paths: string[]) => paths.map((p) => `     ${p}`);

  if (by.tracked.length > 0) {
    const n = by.tracked.length;
    out.push(
      `${red}${plural(n, "file")} with secrets ${n === 1 ? "is" : "are"} tracked by git. Untrack ${n === 1 ? "it" : "them"} (git rm --cached <file>),`,
    );
    out.push("   then rotate the keys: they stay in git history.");
    out.push(...list(by.tracked.map(({ file }) => tilde(file.path, home))));
  }
  if (by.template.length > 0) {
    const n = by.template.length;
    out.push(`${red}${plural(n, "template")} ${n === 1 ? "holds" : "hold"} what look like real keys. Replace each with a`);
    out.push("   placeholder, then rotate the key: templates are usually shared.");
    out.push(...list(by.template.map(({ file }) => tilde(file.path, home))));
  }
  if (by.backup.length > 0) {
    const n = by.backup.length;
    out.push(`${warn}${n === 1 ? "1 backup copy holds" : `${n} backup copies hold`} secrets. Delete ${n === 1 ? "it" : "them"}:`);
    out.push(...list(by.backup.map(({ file }) => tilde(file.path, home))));
  }
  if (by.init.length > 0) {
    // A workspace member is set up by one `init` at its root (monorepo spec §4).
    const projects = [...new Set(by.init.map(({ project }) => project.workspace ?? project.path))];
    const n = projects.length;
    out.push(
      `${warn}${plural(n, "project")} ${n === 1 ? "holds" : "hold"} secrets in plain text. Run ${options.cli} init in ${n === 1 ? "it" : "each"}:`,
    );
    out.push(...list(projects.map((p) => tilde(p, home))));
  }
  if (by.other.length > 0) {
    const n = by.other.length;
    out.push(`${warn}${plural(n, "file")} ${options.cli} init doesn't read ${n === 1 ? "holds" : "hold"} secrets. Store each value with`);
    out.push(`   ${options.cli} set, then replace it with its ks: reference, or delete the file:`);
    out.push(
      ...list(
        by.other.map(({ file, project }) => `${tilde(file.path, home)}${project.packageJson ? "" : " (no package.json)"}`),
      ),
    );
  }
  if (missingInit.size > 0) {
    const n = [...missingInit.values()].reduce((a, b) => a + b, 0);
    out.push(
      `${warn}${plural(n, "reference")} ${n === 1 ? "isn't" : "aren't"} in this vault. Run ${options.cli} init in ${missingInit.size === 1 ? "the project" : "each project"} to add ${n === 1 ? "its value" : "their values"}:`,
    );
    out.push(...list([...missingInit.keys()].map((p) => tilde(p, home))));
  }
  if (missingOther.length > 0) {
    const n = missingOther.reduce((sum, file) => sum + missingRefs(file), 0);
    out.push(
      `${warn}${plural(n, "reference")} in files ${options.cli} init doesn't read ${n === 1 ? "isn't" : "aren't"} in this vault. Store each value`,
    );
    out.push(`   with ${options.cli} set <scope>/<KEY>${options.keys ? "" : " (--keys names them)"}:`);
    out.push(...list(missingOther.map((file) => tilde(file.path, home))));
  }
  if (!hasSecrets(report)) out.push(`${theme.green(SYMBOLS.pass)}  No secrets in plain text.`);
  if (unclear > 0) {
    out.push(
      `${theme.dim(SYMBOLS.info)}  ${plural(unclear, "line")} ${unclear === 1 ? "is" : "are"} unclear: settings or secrets, Kerstel can't tell${options.keys ? "." : " (--keys names them)."}`,
    );
  }
  for (const warning of report.warnings) out.push(`${warn}${warning}`);
  if (!report.git) out.push(`${theme.dim(SYMBOLS.info)}  git is not installed, so files git tracks are not flagged.`);
  out.push(...unreadableLines(report, options, theme, home));
  return out;
}

/** The `--json` shape. Spec §5.2; the CLI docs page documents it, so changing it is a breaking change. */
export function renderJson(report: ScanReport): unknown {
  return {
    root: report.root,
    folders: report.folders,
    unreadable: report.unreadable,
    git: report.git,
    projects: report.projects.map((project) => ({
      path: project.path,
      name: project.name,
      workspace: project.workspace,
      packageJson: project.packageJson,
      scope: project.scope,
      files: project.files.map((file) => ({
        name: file.rel,
        kind: file.kind,
        read: file.read,
        git: file.git,
        secrets: file.secrets,
        unclear: file.unclear,
        config: file.config,
        references: file.references,
        unreadableLines: file.unreadableLines,
      })),
    })),
  };
}
