import { openContext } from "../context";
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

export async function setCommand(args: string[]): Promise<number> {
  const target = args[0];
  if (!target) {
    fail("Usage: kerstel set <scope>/<KEY> [--value <value>]");
    return 2;
  }

  const ref = parseTarget(target);
  if (!ref) {
    fail(`Invalid reference "${target}". Use a lowercase scope and an ENV_STYLE key, e.g. global/API_KEY.`);
    return 2;
  }

  const flagIndex = args.indexOf("--value");
  const value = flagIndex !== -1 ? args[flagIndex + 1] : await readStdin();
  if (value === undefined || value === "") {
    fail("No value supplied. Pass --value, or pipe the secret on stdin.");
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
    if (args.includes("--reveal")) console.log(value);
    else console.log(`${mask()}  ${dim("(pass --reveal to print the value)")}`);
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

export async function resolveCommand(args: string[]): Promise<number> {
  const target = args[0];
  const ref = target ? parseTarget(target) : null;
  if (!ref) {
    fail("Usage: kerstel resolve kerstel://<scope>/<KEY>");
    return 2;
  }

  const ctx = await openContext();
  try {
    const value = ctx.vault.getSecret(ref);
    if (value === null) {
      fail(`No secret at ${formatReference(ref.scope, ref.key)}`);
      return 1;
    }
    console.log(value);
    return 0;
  } finally {
    ctx.vault.close();
  }
}
