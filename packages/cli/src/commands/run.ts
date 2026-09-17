import { openContext } from "../context";
import { fail } from "../output";
import { parseReference } from "../reference";

/**
 * Universal fallback: resolves every reference in the current environment up
 * front and execs the command with plaintext values injected. Used for anything
 * the runtime hook cannot reach, such as IDE run configurations.
 */
export async function runCommand(args: string[]): Promise<number> {
  const separator = args.indexOf("--");
  const command = separator === -1 ? args : args.slice(separator + 1);
  if (command.length === 0) {
    fail("Usage: kerstel run -- <command> [args...]");
    return 2;
  }

  const ctx = await openContext();
  const env: Record<string, string> = {};
  try {
    for (const [name, value] of Object.entries(process.env)) {
      if (typeof value !== "string") continue;
      const ref = parseReference(value);
      if (!ref) {
        env[name] = value;
        continue;
      }
      const resolved = ctx.vault.getSecret(ref);
      if (resolved === null) {
        fail(`No secret at kerstel://${ref.scope}/${ref.key} (referenced by ${name})`);
        return 1;
      }
      env[name] = resolved;
    }
  } finally {
    ctx.vault.close();
  }

  const child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}
