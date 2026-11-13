import { openContext } from "../context";
import { fail } from "../output";
import { formatReference, isShorthand, parseReference } from "../reference";
import { cliName } from "../ui/cli-name";
import { refuseMissingExecutable, spawnChild } from "./spawn";

/**
 * Universal fallback: resolves every reference in the current environment up
 * front and execs the command with plaintext values injected. Used for anything
 * the runtime hook cannot reach, such as IDE run configurations.
 */
export async function runCommand(args: string[]): Promise<number> {
  const separator = args.indexOf("--");
  const command = separator === -1 ? args : args.slice(separator + 1);
  if (command.length === 0) {
    fail(`Usage: ${cliName()} run -- <command> [args...]`);
    return 2;
  }

  // Before the vault is opened: a command that cannot start should not
  // resolve a single secret, or prompt for the credential store.
  const missing = refuseMissingExecutable(command);
  if (missing !== null) return missing;

  const ctx = await openContext();
  const env: Record<string, string> = {};
  try {
    for (const [name, value] of Object.entries(process.env)) {
      if (typeof value !== "string") continue;
      const ref = parseReference(value, name);
      if (!ref) {
        env[name] = value;
        continue;
      }
      const resolved = ctx.vault.getSecret(ref);
      if (resolved === null) {
        fail(
          `No secret at ${formatReference(ref.scope, ref.key)} (referenced by ${name})` +
            (isShorthand(value)
              ? `. ${name} is ${value}, so Kerstel looked for ${ref.scope}/${name}. ` +
                `If ${name} was copied from another variable, write ${value}/<KEY>.`
              : ""),
        );
        return 1;
      }
      // One row per reference resolved. This path hands plaintext to a child
      // process without the daemon seeing it, so the audit row the daemon
      // would have written has to be written here -- otherwise the log claims
      // these secrets were never read.
      ctx.vault.record("run", ref);
      env[name] = resolved;
    }
  } finally {
    ctx.vault.close();
  }

  return await spawnChild(command, env);
}
