import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { openContext } from "../context";
import { isDaemonRunning } from "../daemon/client";
import { isCompiledBinary } from "../daemon/spawn";
import { projectStatus } from "../init/status";
import { fail } from "../output";
import { hookDir, kerstelHome, socketPath, tokenPath, vaultPath } from "../paths";
import { cliName } from "../ui/cli-name";
import { printBanner } from "../ui/banner";
import { note, step } from "../ui/steps";
import { renderTable } from "../ui/table";
import { SYMBOLS, theme } from "../ui/theme";
import { githubReleases } from "../update/release-source";
import { VERSION } from "../version";
import { exitCode, gatherChecks, type Check, type DoctorFacts } from "../doctor/checks";

/**
 * A path's actual mode next to the one Kerstel intends. `null` means "not
 * worth reporting" -- missing (nothing to protect yet) or Windows (NTFS has
 * no POSIX modes, so every path would otherwise show as a false problem).
 */
function readMode(path: string): number | null {
  if (process.platform === "win32" || !existsSync(path)) return null;
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * Spec: `ks` is on PATH and resolves to this same binary. Only meaningful for
 * a compiled binary -- running from source has no shortcut to check.
 */
function computeShortcut(): DoctorFacts["shortcut"] {
  if (!isCompiledBinary()) return "not-applicable";
  const found = Bun.which("ks");
  if (!found) return "missing";
  try {
    return realpathSync(found) === realpathSync(process.execPath) ? "linked" : "other";
  } catch {
    return "other";
  }
}

/** `~/.kerstel` when KERSTEL_HOME is the default, else the real path. */
function homeForDisplay(): string {
  const home = kerstelHome();
  return resolve(home) === resolve(join(homedir(), ".kerstel")) ? "~/.kerstel" : home;
}

function symbolFor(status: Check["status"]): string {
  if (status === "pass") return theme.green(SYMBOLS.pass);
  if (status === "warn") return theme.yellow(SYMBOLS.warn);
  if (status === "info") return theme.dim(SYMBOLS.info);
  return theme.red(SYMBOLS.problem);
}

/**
 * `<symbol> <label>  <detail>`, and a dim `Fix: <fix>` row under any warning
 * or problem -- aligned with `renderTable` so the whole group reads as one
 * block regardless of label length.
 */
function renderChecks(checks: Check[]): string[] {
  const rows: string[][] = [];
  for (const check of checks) {
    rows.push([`${symbolFor(check.status)}  ${check.label}`, check.detail]);
    if (check.fix && check.status !== "pass") {
      rows.push(["", theme.dim(`Fix: ${check.fix}`)]);
    }
  }
  return renderTable(rows, { gap: 2 });
}

function modeSuffix(mode: { actual: number | null; expected: number } | undefined): string {
  if (!mode || mode.actual === null) return "";
  const shown = mode.actual.toString(8).padStart(4, "0");
  if ((mode.actual & ~mode.expected) !== 0) {
    return theme.yellow(`  (mode ${shown}, expected ${mode.expected.toString(8).padStart(4, "0")})`);
  }
  return `  (mode ${shown})`;
}

/** The paths and permission modes `doctor` printed unconditionally before this task. Spec §6: `--verbose` only, now that the checks above cover the same ground in plain language. */
function verboseLines(facts: DoctorFacts): string[] {
  const [home, token, socket] = facts.modes;
  return [
    `Home:      ${kerstelHome()}${modeSuffix(home)}`,
    `Vault:     ${vaultPath()}`,
    `Token:     ${tokenPath()}${modeSuffix(token)}`,
    `Socket:    ${socketPath()}${modeSuffix(socket)}`,
    `Hook:      ${hookDir()}${facts.hook.installed ? "" : theme.yellow("  (not installed)")}`,
  ];
}

/**
 * A short explanation for a machine with nothing wired yet: outside a project,
 * or in one `init` has not set up. Someone who has already wired a project has
 * seen all of this, so they get the checks and nothing more.
 */
export function howItWorksNote(facts: Pick<DoctorFacts, "project" | "cli">): string | null {
  // "Set up" means init has been through here: scripts wired, or references
  // already resolving in a project that had no scripts to wire.
  const setUp =
    facts.project !== null && (facts.project.scripts.wired > 0 || facts.project.references.total > 0);
  if (setUp) return null;
  const lines = [
    "Your secrets live in an encrypted vault on this machine, unlocked",
    "through your OS credential store.",
    "A small daemon reads it for your scripts and starts on its own when",
    "needed, so there is nothing to keep running.",
    `\`${facts.cli} init\` moves a project's .env values into the vault and wires its`,
    "scripts through `kerstel exec`, so `npm run dev` keeps working and the",
    ".env file holds only kerstel:// references.",
  ];
  if (facts.project === null) lines.push("", `Run \`${facts.cli} init\` inside a project to get started.`);
  return lines.join("\n");
}

function summaryLine(checks: Check[]): string {
  const problems = checks.filter((check) => check.status === "problem").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  if (problems === 0 && warnings === 0) return "All good.";
  return (
    `${problems} problem${problems === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}. ` +
    "Everything else looks good."
  );
}

/** Where `doctor` looks for the newest release. Injectable so tests never call GitHub. */
export interface DoctorDeps {
  latestVersion: () => Promise<string | null>;
  /** Why the release source refuses to be used, if it does. */
  releaseProblem?: string | null;
}

function defaultDoctorDeps(): DoctorDeps {
  const source = githubReleases();
  return { latestVersion: () => source.latestVersion(), releaseProblem: source.problem ?? null };
}

export async function doctorCommand(
  args: string[] = [],
  cwd: string = process.cwd(),
  deps: DoctorDeps = defaultDoctorDeps(),
): Promise<number> {
  let verbose = false;
  for (const arg of args) {
    if (arg === "--verbose") verbose = true;
    else {
      fail(`Unknown option "${arg}". ${cliName()} doctor accepts: --verbose.`);
      return 2;
    }
  }

  let ctx: Awaited<ReturnType<typeof openContext>>;
  try {
    // doctor reports the key store in its own check, so no notice line above it.
    ctx = await openContext({ keyNotices: false });
  } catch (error) {
    // Nothing else here can be trusted -- the vault itself would not open, so
    // there is no secret count, no backend, no project to report on.
    fail(`Vault: ${(error as Error).message}`);
    return 1;
  }

  try {
    // Started first, so the network round trip overlaps the local checks.
    const latestVersion = deps.latestVersion();
    const project = projectStatus(cwd, ctx.vault);
    const facts: DoctorFacts = {
      backend: ctx.backend,
      secretCount: ctx.vault.listSecrets().length,
      daemonRunning: await isDaemonRunning(),
      hook: { installed: ctx.hookInstall.installed, error: ctx.hookInstall.error },
      modes: [
        { path: kerstelHome(), expected: 0o700, actual: readMode(kerstelHome()) },
        { path: tokenPath(), expected: 0o600, actual: readMode(tokenPath()) },
        { path: socketPath(), expected: 0o600, actual: readMode(socketPath()) },
      ],
      shortcut: computeShortcut(),
      project,
      cli: cliName(),
      platform: process.platform,
      home: homeForDisplay(),
      version: VERSION,
      latestVersion: await latestVersion,
      releaseProblem: deps.releaseProblem ?? null,
      // Set-but-empty injects nothing, so it is not worth a warning.
      bunOptions: process.env.BUN_OPTIONS?.trim() ? process.env.BUN_OPTIONS : null,
    };

    const checks = gatherChecks(facts);

    printBanner(theme, VERSION);

    const machineLines = renderChecks(checks.filter((check) => check.group === "machine"));
    if (verbose) machineLines.push("", ...verboseLines(facts));
    step("This machine", machineLines);

    if (project) {
      const title = project.scope ? `This project · ${project.scope}` : "This project";
      step(title, renderChecks(checks.filter((check) => check.group === "project")));
    }

    console.log("");
    console.log(summaryLine(checks));

    const howItWorks = howItWorksNote(facts);
    if (howItWorks) {
      console.log("");
      note(howItWorks, "How it works");
    }

    return exitCode(checks);
  } finally {
    ctx.vault.close();
  }
}
