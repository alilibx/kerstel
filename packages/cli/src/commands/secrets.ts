import { openContext } from "../context";
import { DaemonError, ensureDaemon } from "../daemon/client";
import { MAX_LINE_CHARS } from "../daemon/protocol";
import { bold, dim, fail, info, mask, ok } from "../output";
import { formatReference, parseReference, type SecretRef } from "../reference";

/** Accepts `scope/KEY` or a full `kerstel://scope/KEY`. */
export function parseTarget(input: string): SecretRef | null {
  if (input.startsWith("kerstel://")) return parseReference(input);
  return parseReference(`kerstel://${input}`);
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c)))).replace(/\n$/, "");
}

/**
 * The value that follows `--value`, or undefined when the flag is absent or
 * the next token is another flag.
 *
 * `args[indexOf("--value") + 1]` alone silently swallows the NEXT FLAG as the
 * secret: `kerstel set global/K --value --reveal` would store the string
 * "--reveal". A value that genuinely starts with `--` has to come in on stdin.
 */
function valueFlag(args: string[]): { present: boolean; value: string | undefined } {
  const index = args.indexOf("--value");
  if (index === -1) return { present: false, value: undefined };
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) return { present: true, value: undefined };
  return { present: true, value: next };
}

export async function setCommand(args: string[]): Promise<number> {
  const target = args[0];
  if (!target) {
    fail("Usage: kerstel set <scope>/<KEY>   (pipe the secret on stdin)");
    return 2;
  }

  const ref = parseTarget(target);
  if (!ref) {
    fail(`Invalid reference "${target}". Use a lowercase scope and an ENV_STYLE key, e.g. global/API_KEY.`);
    return 2;
  }

  const flag = valueFlag(args);
  let value: string | undefined;
  if (flag.present) {
    // The value is already in this process's argv, and therefore in the shell
    // history and in `ps` output for every user on the machine. We cannot undo
    // that here -- the only honest thing is to say so. The flag stays because
    // non-interactive scripting needs it.
    console.error(
      "warning: --value puts the secret in your shell history and in `ps` output. " +
        "Pipe it on stdin instead: printf %s \"$SECRET\" | kerstel set " +
        `${ref.scope}/${ref.key}`,
    );
    value = flag.value;
  } else if (process.stdin.isTTY === true) {
    // Reading stdin from a terminal blocks forever with no output, which looks
    // exactly like a hang. Say what to do instead.
    fail(
      `No value supplied. Pipe the secret on stdin, e.g. printf %s "$SECRET" | kerstel set ${ref.scope}/${ref.key}`,
    );
    return 2;
  } else {
    value = await readStdin();
  }

  if (value === undefined || value === "") {
    fail("No value supplied. Pipe the secret on stdin, or pass --value.");
    return 2;
  }

  // A value longer than one protocol line can be stored but never resolved:
  // the daemon's reply would exceed MAX_LINE_CHARS and the connection would be
  // dropped. Refuse it at the door rather than accepting a secret that is
  // guaranteed to fail at runtime. The JSON envelope costs a little of the
  // budget, so leave headroom rather than allowing exactly the cap.
  const maxValueChars = MAX_LINE_CHARS - 1_024;
  if (value.length > maxValueChars) {
    fail(
      `That value is ${value.length} characters; Kerstel can transport at most ${maxValueChars}. ` +
        "The daemon could store it but never serve it. Store a path or a shorter credential instead.",
    );
    return 2;
  }

  const ctx = await openContext();
  try {
    ctx.vault.setSecret(ref, value);
    ok(`Stored ${bold(formatReference(ref.scope, ref.key))}`);
    return 0;
  } finally {
    ctx.vault.close();
  }
}

export async function getCommand(args: string[]): Promise<number> {
  const target = args[0];
  if (!target) {
    fail("Usage: kerstel get <scope>/<KEY> [--reveal]");
    return 2;
  }

  const ref = parseTarget(target);
  if (!ref) {
    fail(`Invalid reference "${target}".`);
    return 2;
  }

  const ctx = await openContext();
  try {
    const value = ctx.vault.getSecret(ref);
    if (value === null) {
      fail(`No secret at ${formatReference(ref.scope, ref.key)}`);
      return 1;
    }
    if (args.includes("--reveal")) {
      // This is one of only two places a plaintext value leaves the vault
      // without passing through the daemon (the other is `run`), so the audit
      // row the daemon would have written has to be written here. A reveal
      // that is not recorded is a reveal the audit log denies happened.
      ctx.vault.appendAudit({
        ts: Date.now(),
        event: "reveal",
        scope: ref.scope,
        key: ref.key,
        pid: process.pid,
        processName: "kerstel",
      });
      console.log(value);
    } else {
      console.log(`${mask()}  ${dim("(pass --reveal to print the value)")}`);
    }
    return 0;
  } finally {
    ctx.vault.close();
  }
}

export async function lsCommand(args: string[]): Promise<number> {
  const scopeIndex = args.indexOf("--scope");
  const scope = scopeIndex !== -1 ? args[scopeIndex + 1] : undefined;

  const ctx = await openContext();
  try {
    const secrets = ctx.vault.listSecrets(scope);
    if (secrets.length === 0) {
      info(scope ? `No secrets in scope "${scope}".` : "No secrets stored yet. Add one with `kerstel set`.");
      return 0;
    }
    for (const secret of secrets) {
      console.log(
        `${formatReference(secret.scope, secret.key)}  ${dim(new Date(secret.updatedAt).toISOString())}`,
      );
    }
    return 0;
  } finally {
    ctx.vault.close();
  }
}

export async function rmCommand(args: string[]): Promise<number> {
  const target = args[0];
  if (!target) {
    fail("Usage: kerstel rm <scope>/<KEY> --yes");
    return 2;
  }

  const ref = parseTarget(target);
  if (!ref) {
    fail(`Invalid reference "${target}".`);
    return 2;
  }
  if (!args.includes("--yes")) {
    fail(`Deleting a secret cannot be undone. Re-run with --yes to remove ${formatReference(ref.scope, ref.key)}.`);
    return 2;
  }

  const ctx = await openContext();
  try {
    if (!ctx.vault.removeSecret(ref)) {
      fail(`No secret at ${formatReference(ref.scope, ref.key)}`);
      return 1;
    }
    ok(`Removed ${formatReference(ref.scope, ref.key)}`);
    return 0;
  } finally {
    ctx.vault.close();
  }
}

/**
 * Prints one resolved value.
 *
 * Deliberately goes THROUGH the daemon rather than opening the vault directly,
 * which is what every other command here does. Two things follow from that, and
 * both are the point:
 *
 *  - it is the command that gives `ensureDaemon` a real caller, so a machine
 *    with no daemon running starts one on first use, as spec §7 promises;
 *  - the daemon writes an `audit_log` row for every resolution it serves, so
 *    this command -- which prints plaintext to a terminal -- is audited without
 *    a second, parallel audit path that could drift from the daemon's.
 */
export async function resolveCommand(args: string[]): Promise<number> {
  const target = args[0];
  const ref = target ? parseTarget(target) : null;
  if (!ref) {
    fail("Usage: kerstel resolve kerstel://<scope>/<KEY>");
    return 2;
  }

  let client;
  try {
    client = await ensureDaemon();
  } catch (error) {
    fail((error as Error).message);
    return 1;
  }

  try {
    console.log(await client.resolve(ref.scope, ref.key, { processName: "kerstel" }));
    return 0;
  } catch (error) {
    if (error instanceof DaemonError && error.code === "not_found") {
      fail(`No secret at ${formatReference(ref.scope, ref.key)}`);
      return 1;
    }
    fail((error as Error).message);
    return 1;
  } finally {
    client.close();
  }
}
