import { daemonCommand } from "./commands/daemon";
import { doctorCommand } from "./commands/doctor";
import { execCommand } from "./commands/exec";
import { runCommand } from "./commands/run";
import { getCommand, lsCommand, resolveCommand, rmCommand, setCommand } from "./commands/secrets";
import { bold, fail } from "./output";

const USAGE = `${bold("kerstel")} — local-first secrets for your projects

Usage:
  ... | kerstel set <scope>/<KEY>               Store a secret piped on stdin
  kerstel set <scope>/<KEY> --value <value>     Same, but the value lands in your
                                                shell history and in \`ps\` output
  kerstel get <scope>/<KEY> [--reveal]          Read a secret
  kerstel ls [--scope <scope>]                  List stored references
  kerstel rm <scope>/<KEY> --yes                Remove a secret
  kerstel run -- <command>                      Run a command with references resolved
  kerstel exec -- <command>                     Run a command with the hook wired in
  kerstel resolve kerstel://<scope>/<KEY>       Print one resolved value
  kerstel daemon <serve|start|stop|status>      Manage the resolver daemon
  kerstel doctor                                Diagnose this machine's setup

Scopes are explicit: "global" or a project name. A reference resolves in exactly
one scope — there is no fallback.`;

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...args] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  try {
    switch (command) {
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
        return await doctorCommand();
      default:
        fail(`Unknown command "${command}".`);
        console.log(USAGE);
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
