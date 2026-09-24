import { daemonCommand } from "./commands/daemon";
import { doctorCommand } from "./commands/doctor";
import { execCommand } from "./commands/exec";
import { initCommand } from "./commands/init";
import { moveCommand } from "./commands/move";
import { runCommand } from "./commands/run";
import { getCommand, lsCommand, resolveCommand, rmCommand, setCommand } from "./commands/secrets";
import { uninstallCommand } from "./commands/uninstall";
import { updateCommand, versionCommand } from "./commands/update";
import { isScrubbedEnvironment } from "./daemon/env";
import { bold, fail } from "./output";
import { ignoreProjectSettings } from "./project-env";
import { printBanner } from "./ui/banner";
import { cliName } from "./ui/cli-name";
import { detectTheme, makeTheme, theme } from "./ui/theme";
import { githubReleases } from "./update/release-source";
import { VERSION } from "./version";

const HEADER = `${bold("kerstel")} — local-first secrets for your projects`;

const COMMANDS = `Usage:
  ${cliName()} init [--yes] [--dry-run]              Migrate this project's .env files
  ${cliName()} move [KEY...] [--to global|project|plaintext] [--yes] [--replace] [--allow-tracked]
                                                Move keys between the vault and plain text
  ... | ${cliName()} set <scope>/<KEY>               Store a secret piped on stdin
  ${cliName()} set <scope>/<KEY> --value <value>     Same, but the value lands in your
                                                shell history and in \`ps\` output
  ${cliName()} get <scope>/<KEY> [--reveal]          Read a secret
  ${cliName()} ls [--scope <scope>]                  List stored references
  ${cliName()} rm <scope>/<KEY> --yes                Remove a secret
  ${cliName()} run -- <command>                      Run a command with references resolved
  ${cliName()} exec -- <command>                     Run a command with the hook wired in
  ${cliName()} resolve kerstel://<scope>/<KEY>       Print one resolved value
  ${cliName()} daemon <serve|start|stop|status>      Manage the resolver daemon
  ${cliName()} doctor [--verbose]                    Diagnose this machine's setup
  ${cliName()} update [--check]                      Install the latest release
  ${cliName()} uninstall [--dry-run] [--yes] [--force]
                                                Restore every project and remove Kerstel
  ${cliName()} --version                             Print the version, and whether it's current

Scopes are explicit: "global" or a project name. A reference resolves in exactly
one scope — there is no fallback.`;

export async function runCli(argv: string[]): Promise<number> {
  // FIRST, before any command and before anything reads a KERSTEL_* setting:
  // Bun has already loaded this directory's .env into process.env, and in
  // Kerstel's model that file is committed. See project-env.ts.
  //
  // Not in the daemon: its environment is an allowlist built by a parent that
  // has already been through this, so nothing in it came from a project, and
  // re-running the check there would let a `.env` in its own directory strip
  // the KERSTEL_HOME it was deliberately given.
  if (!isScrubbedEnvironment()) {
    for (const setting of ignoreProjectSettings()) {
      process.stderr.write(
        `Ignoring ${setting.name}: ${setting.file} names it, and Kerstel never takes its own settings ` +
          `from a project's env files. Remove that line, or set it somewhere else.\n`,
      );
    }
  }

  const [command, ...args] = argv;

  if (!command) {
    printBanner(theme, VERSION);
    console.log(COMMANDS);
    return 0;
  }

  if (command === "--help" || command === "-h" || command === "help") {
    console.log(HEADER);
    console.log("");
    console.log(COMMANDS);
    return 0;
  }

  if (command === "--version" || command === "version") {
    return versionCommand({
      isTTY: process.stdout.isTTY === true,
      source: githubReleases(),
      currentVersion: VERSION,
      cli: cliName(),
      // Styled for stderr's own terminal, and not console.error, which Bun
      // paints red on a TTY.
      stderr: (line) => process.stderr.write(`${makeTheme(detectTheme(process.stderr)).dim(line)}\n`),
    });
  }

  try {
    switch (command) {
      case "init":
        return await initCommand(args);
      case "move":
        return await moveCommand(args);
      case "set":
        return await setCommand(args);
      case "get":
        return await getCommand(args);
      case "ls":
      case "list":
        return await lsCommand(args);
      case "rm":
      case "remove":
        return await rmCommand(args);
      case "run":
        return await runCommand(args);
      case "exec":
        return await execCommand(args);
      case "resolve":
        return await resolveCommand(args);
      case "daemon":
        return await daemonCommand(args);
      case "doctor":
        return await doctorCommand(args);
      case "uninstall":
        return await uninstallCommand(args);
      case "update":
        return await updateCommand(args);
      default:
        fail(`Unknown command "${command}".`);
        console.log(COMMANDS);
        return 2;
    }
  } catch (error) {
    fail((error as Error).message);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
