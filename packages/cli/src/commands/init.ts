import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openContext } from "../context";
import { cliCommand } from "../daemon/spawn";
import { SUGGESTIONS, suggest, type Suggestion } from "../init/classify";
import { collectKeys, loadEnvFiles, type CollectedKey, type LoadedEnvFile } from "../init/collect";
import { createBackup } from "../init/backup";
import { detectProject, type DetectedProject } from "../init/detect";
import { lookup, parseDotenv, serializeDotenv, setValue } from "../init/dotenv-file";
import { deriveScope } from "../init/project-name";
import {
  DefaultsPrompter,
  NonInteractiveError,
  TtyPrompter,
  type Prompter,
} from "../init/prompts";
import { renderDiff, wireBunfig, wirePackageJson } from "../init/wiring";
import { bold, dim, fail, info, ok, yellow } from "../output";
import { GLOBAL_SCOPE, formatReference, isValidScope, parseReference } from "../reference";
import { loadOrCreateDataKey } from "../vault/keychain";
import type { Vault } from "../vault/store";
import { preloadPathFor } from "./exec";

/**
 * Spec §8's setup wizard.
 *
 * Three rules shape every line below:
 *   1. NO PLAINTEXT IS EVER PRINTED. Not in the plan, not in a diff, not in an
 *      error, not in the self-check. The user is told a value's length and
 *      shape and nothing else; the value itself only ever moves between the
 *      file, the vault and the encrypted backup.
 *   2. NOTHING IS WRITTEN BEFORE THE USER SAYS YES, and the backup is written
 *      before anything else, so every step has an undo.
 *   3. --dry-run returns before the first write, having printed every diff.
 */

const GITIGNORE_NOTE = "# Kerstel: .env files hold references, safe to commit";
/** A .gitignore line that hides .env files (a `!` negation is left alone). */
const GITIGNORE_ENV_LINE = /^\s*\.env(\..*)?\s*$/;

export interface InitOptions {
  cwd: string;
  yes: boolean;
  dryRun: boolean;
  nonInteractive: boolean;
  fromStdin: boolean;
  scope?: string;
  globalKeys: Set<string>;
  keepKeys: Set<string>;
}

function splitKeys(raw: string): string[] {
  return raw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

export function parseInitArgs(args: string[], cwd: string): InitOptions | { error: string } {
  const options: InitOptions = {
    cwd,
    yes: false,
    dryRun: false,
    nonInteractive: false,
    fromStdin: false,
    globalKeys: new Set<string>(),
    keepKeys: new Set<string>(),
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--non-interactive") {
      options.nonInteractive = true;
    } else if (arg === "--from-stdin") {
      options.fromStdin = true;
    } else if (arg === "--scope") {
      const value = args[++i];
      // A flag as the next token means the value is missing, not that the
      // project is called "--yes".
      if (!value || value.startsWith("--")) return { error: "--scope needs a name, e.g. --scope my-app" };
      if (!isValidScope(value)) {
        return { error: `Invalid scope "${value}". Use a lowercase name of letters, digits, . _ or -.` };
      }
      options.scope = value;
    } else if (arg === "--global" || arg === "--keep") {
      const value = args[++i];
      if (!value || value.startsWith("--")) return { error: `${arg} needs a comma-separated list of KEYs` };
      const target = arg === "--global" ? options.globalKeys : options.keepKeys;
      for (const key of splitKeys(value)) target.add(key);
    } else {
      return {
        error:
          `Unknown option "${arg}". kerstel init accepts: --yes, --dry-run, --scope <name>, ` +
          "--global KEY[,KEY], --keep KEY[,KEY], --non-interactive, --from-stdin.",
      };
    }
  }

  return options;
}

/** Shape and size only. A value's CONTENT never reaches the terminal. */
function describeValue(value: string): string {
  if (value.trim() === "") return "empty";
  const kind = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? "url" : "opaque";
  return `${value.length} chars, ${kind}`;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

/**
 * Spec §8's teammate flow: the repository carries references, this machine's
 * vault does not carry the values. Ask for them, or read them as JSON.
 */
async function fillMissingReferences(
  missing: CollectedKey[],
  vault: Vault,
  options: InitOptions,
  prompter: Prompter,
): Promise<number> {
  console.log("");
  console.log(bold("Values this machine is missing"));
  for (const key of missing) {
    const ref = key.reference!;
    info(`${key.key.padEnd(28)} ${formatReference(ref.scope, ref.key)}`);
  }

  if (options.dryRun) {
    info("--dry-run: no values were requested and nothing was stored.");
    return 0;
  }

  let supplied: Record<string, string> = {};
  if (options.fromStdin) {
    const raw = await readStdin();
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      supplied = parsed as Record<string, string>;
    } catch {
      fail('--from-stdin expects a JSON object of {"KEY": "value"} on stdin.');
      return 2;
    }
  }

  for (const key of missing) {
    const ref = key.reference!;
    const reference = formatReference(ref.scope, ref.key);
    let value = supplied[key.key];
    if (value === undefined) {
      value = await prompter.text(`Value for ${reference}?`, { secret: true, flag: "--from-stdin" });
    }
    if (typeof value !== "string" || value === "") {
      fail(`No value supplied for ${reference}. Nothing was stored for it.`);
      return 2;
    }
    vault.setSecret(ref, value);
    ok(`Stored ${reference}`);
  }

  return 0;
}

interface Decision {
  key: CollectedKey;
  target: Suggestion;
}

async function decideTargets(
  keys: CollectedKey[],
  options: InitOptions,
  prompter: Prompter,
): Promise<Decision[]> {
  const decisions: Decision[] = [];
  for (const key of keys) {
    if (options.keepKeys.has(key.key)) {
      decisions.push({ key, target: "plaintext" });
      continue;
    }
    if (options.globalKeys.has(key.key)) {
      decisions.push({ key, target: "global" });
      continue;
    }
    const answer = await prompter.choose(
      `${key.key}  ${dim(`(${describeValue(key.value)}, from ${key.source})`)}`,
      [...SUGGESTIONS],
      suggest(key.key, key.value),
    );
    decisions.push({ key, target: answer as Suggestion });
  }
  return decisions;
}

interface FileChange {
  path: string;
  label: string;
  /** The bytes to write once the user has said yes. */
  after: string;
  /**
   * The two sides of the diff the user is shown. Every value this rewrite
   * REMOVES is replaced by its `describeValue` mask, so the diff is a full,
   * honest, line-for-line diff of the file without being a printed copy of
   * the secrets -- rule 1 above. `after` is safe to show as it stands: by
   * definition it holds references and nothing else.
   */
  diffBefore: string;
  diffAfter: string;
}

/**
 * The stand-in a removed value gets in a printed diff: its shape and size,
 * rendered as one unquoted token so the masked line still parses as the `.env`
 * line it is standing in for.
 */
function redact(value: string): string {
  return `«${describeValue(value).replace(/,?\s+/g, "-")}»`;
}

function planEnvRewrites(loaded: LoadedEnvFile[], references: Map<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  for (const entry of loaded) {
    // Re-parse from the original bytes so a rewrite is always computed from
    // what is on disk, never from an object an earlier step already mutated.
    const copy = parseDotenv(entry.original);
    for (const [key, reference] of references) setValue(copy, key, reference);
    const after = serializeDotenv(copy);
    if (after === entry.original) continue;

    const masked = parseDotenv(entry.original);
    for (const key of references.keys()) {
      const current = lookup(masked, key);
      // A value that is ALREADY a reference is not a secret and must keep its
      // own text: masking it would invent a diff line for a key this run does
      // not touch.
      if (current === null || parseReference(current) !== null) continue;
      setValue(masked, key, redact(current));
    }

    changes.push({
      path: entry.info.path,
      label: entry.info.name,
      after,
      diffBefore: serializeDotenv(masked),
      diffAfter: after,
    });
  }
  return changes;
}

/** Spec §8 step 5. Default NO: committing `.env` is the user's call, not ours. */
async function offerGitignore(root: string, prompter: Prompter): Promise<void> {
  const path = join(root, ".gitignore");
  if (!existsSync(path)) return;

  const source = readFileSync(path, "utf8");
  const parts = source.split(/(\r\n|\n)/);
  const hidden: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    if (GITIGNORE_ENV_LINE.test(text)) hidden.push(text.trim());
  }
  if (hidden.length === 0) return;

  console.log("");
  info(`.gitignore hides your env files: ${hidden.join(", ")}`);
  info("They now hold references, not secrets, so committing them gives teammates a living .env.example.");
  const remove = await prompter.confirm(
    "Remove those lines from .gitignore so the reference-only files can be committed?",
    false,
  );
  if (!remove) {
    info("Left .gitignore alone.");
    return;
  }

  const kept: string[] = [];
  let noteInserted = false;
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    const eol = parts[i + 1] ?? "";
    if (GITIGNORE_ENV_LINE.test(text)) {
      if (!noteInserted) {
        kept.push(GITIGNORE_NOTE, eol === "" ? "\n" : eol);
        noteInserted = true;
      }
      continue;
    }
    kept.push(text, eol);
  }

  const after = kept.join("");
  console.log(renderDiff(".gitignore", source, after));
  writeFileSync(path, after);
  ok("Updated .gitignore");
}

/**
 * Spec §8 step 6: prove the wiring works by running a probe through it.
 *
 * The probe spawns THIS CLI (`kerstel exec -- <runtime> -e ...`) with one
 * reference in its environment and compares what the child printed to what the
 * vault holds. Neither string is ever printed -- a self-check that leaks the
 * secret it is checking would defeat the product it is checking.
 */
async function selfCheck(
  detected: DetectedProject,
  probe: { key: string; reference: string; expected: string },
): Promise<"passed" | "failed" | "skipped"> {
  const runtime = detected.runtime === "bun" ? "bun" : "node";
  const expression = `process.stdout.write(String(process.env.${probe.key}))`;
  const command = cliCommand(["exec", "--", runtime, "-e", expression]);

  try {
    const child = Bun.spawn(command, {
      cwd: detected.root,
      env: { ...process.env, [probe.key]: probe.reference },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (code === 0 && stdout === probe.expected) return "passed";

    fail(
      `Self-check failed: a ${runtime} process wired through \`kerstel exec\` did not receive the ` +
        `value behind ${probe.reference}. Run \`kerstel doctor\` in this directory.`,
    );
    // stderr is the child's diagnostics, never the resolved value: the probe
    // writes the value to stdout, which is deliberately not echoed anywhere.
    if (stderr.trim().length > 0) console.log(dim(stderr.trim()));
    return "failed";
  } catch (error) {
    console.log(
      yellow(
        `!  Self-check skipped: could not run "${runtime}" (${(error as Error).message}). ` +
          "Your scripts are wired; run one to confirm.",
      ),
    );
    return "skipped";
  }
}

/**
 * The wizard proper. Wrapped by `runInit` below, which is what everything
 * calls: a NonInteractiveError raised anywhere in here means the same thing
 * (this run cannot answer its own question) and deserves the same exit code
 * whether it reached us through `initCommand` or straight from a test.
 */
async function runInitSteps(options: InitOptions, prompter: Prompter): Promise<number> {
  console.log(bold("kerstel init"));

  // --- Step 1: detect -----------------------------------------------------
  const detected = detectProject(options.cwd);
  if (!detected.packageJson) {
    fail(
      `No readable package.json in ${options.cwd}. Run \`kerstel init\` from your project root ` +
        "(Kerstel wires package scripts, so it needs one).",
    );
    return 2;
  }

  const scope = options.scope ?? deriveScope({
    packageName: detected.packageName,
    rootPath: detected.root,
  }).scope;

  info(`Runtime:    ${detected.runtime} (${detected.packageManager})`);
  info(`Scope:      ${bold(scope)}`);

  if (detected.envFiles.length === 0) {
    fail(
      "No .env files here. There is nothing to migrate yet -- create one, or store secrets " +
        "directly with `kerstel set <scope>/<KEY>`.",
    );
    return 1;
  }
  info(`Env files:  ${detected.envFiles.map((file) => file.name).join(", ")}`);

  // --- Step 2: parse ------------------------------------------------------
  const loaded = loadEnvFiles(detected.envFiles);
  for (const entry of loaded) {
    for (const unsupported of entry.file.unsupported) {
      console.log(
        yellow(
          `!  ${entry.info.name}:${unsupported.line} — ${unsupported.key} left untouched because ` +
            `${unsupported.reason}.`,
        ),
      );
    }
  }

  const keys = collectKeys(loaded);
  for (const key of keys) {
    if (key.conflicts.length === 0) continue;
    console.log(
      yellow(
        `!  ${key.key} differs between ${key.source} and ${key.conflicts.join(", ")}. Kerstel stores the ` +
          `${key.source} value and points every file at it; the others survive only in the encrypted ` +
          "backup. (v1 has no environments.)",
      ),
    );
  }

  const ctx = await openContext();
  try {
    const referenced = keys.filter((key) => key.reference !== null);
    const plain = keys.filter((key) => key.reference === null);

    // --- Teammate flow ----------------------------------------------------
    const missing = referenced.filter((key) => ctx.vault.getSecret(key.reference!) === null);
    if (missing.length > 0) {
      const code = await fillMissingReferences(missing, ctx.vault, options, prompter);
      if (code !== 0) return code;
    }

    // --- Step 3: classify and decide --------------------------------------
    const decisions = plain.length > 0 ? await decideTargets(plain, options, prompter) : [];

    const references = new Map<string, string>();
    for (const decision of decisions) {
      if (decision.target === "plaintext") continue;
      const target = decision.target === "global" ? GLOBAL_SCOPE : scope;
      references.set(decision.key.key, formatReference(target, decision.key.key));
    }
    for (const key of referenced) {
      // Already-migrated keys keep their existing reference, which the
      // rewrite planner needs so an unchanged file is detected as unchanged.
      references.set(key.key, key.value);
    }

    // --- Plan ---------------------------------------------------------------
    const envChanges = planEnvRewrites(loaded, references);

    const packageSource = readFileSync(detected.packageJsonPath, "utf8");
    const packageWiring = wirePackageJson(packageSource);

    const bunfigPath = join(detected.root, "bunfig.toml");
    const bunfigSource = existsSync(bunfigPath) ? readFileSync(bunfigPath, "utf8") : null;
    let bunfigWiring: { changed: boolean; created: boolean; contents: string } | null = null;
    if (detected.runtime === "bun") {
      try {
        bunfigWiring = wireBunfig(bunfigSource, preloadPathFor(ctx.hookDir));
      } catch (error) {
        fail((error as Error).message);
        return 1;
      }
    }

    const nothingToDo =
      envChanges.length === 0 && !packageWiring.changed && !(bunfigWiring?.changed ?? false);
    if (nothingToDo) {
      ok(`Already migrated: every value in ${detected.envFiles.map((f) => f.name).join(", ")} is a reference, and your scripts are wired.`);
      return 0;
    }

    if (decisions.length > 0) {
      console.log("");
      console.log(bold("Plan"));
      for (const decision of decisions) {
        const target =
          decision.target === "plaintext"
            ? dim("stays plaintext")
            : formatReference(decision.target === "global" ? GLOBAL_SCOPE : scope, decision.key.key);
        info(`${decision.key.key.padEnd(28)} ${target}`);
      }
    }

    console.log("");
    for (const change of envChanges) {
      console.log(renderDiff(change.label, change.diffBefore, change.diffAfter));
    }
    if (packageWiring.changed) console.log(renderDiff("package.json", packageSource, packageWiring.contents));
    if (bunfigWiring?.changed) {
      console.log(renderDiff("bunfig.toml", bunfigSource ?? "", bunfigWiring.contents));
    }

    // --- Step 4: --dry-run stops here, before the first write ---------------
    if (options.dryRun) {
      console.log("");
      info("--dry-run: nothing was written.");
      return 0;
    }

    console.log("");
    if (!(await prompter.confirm("Apply these changes to your files and vault?", true))) {
      info("Nothing was changed.");
      return 0;
    }

    // --- Step 5: backup, then store, then rewrite ---------------------------
    // openContext() holds the data key privately; this reads the same key from
    // the same credential store rather than widening CliContext to expose it.
    const { key: dataKey } = await loadOrCreateDataKey();
    const backup = createBackup({
      scope,
      dataKey,
      files: loaded.map((entry) => ({ name: entry.info.name, contents: entry.original })),
    });
    ok(`Encrypted backup of your originals: ${backup.dir}`);

    ctx.vault.registerProject(scope, detected.root);
    let stored = 0;
    for (const decision of decisions) {
      if (decision.target === "plaintext") continue;
      ctx.vault.setSecret(
        { scope: decision.target === "global" ? GLOBAL_SCOPE : scope, key: decision.key.key },
        decision.key.value,
      );
      stored += 1;
    }
    if (stored > 0) ok(`Stored ${stored} secret${stored === 1 ? "" : "s"} in the vault.`);

    for (const change of envChanges) writeFileSync(change.path, change.after);
    if (envChanges.length > 0) ok(`Rewrote ${envChanges.map((c) => c.label).join(", ")} with references.`);

    // --- Step 6: wire -------------------------------------------------------
    if (packageWiring.changed) {
      writeFileSync(detected.packageJsonPath, packageWiring.contents);
      ok(`Wired ${packageWiring.rewrites.length} package.json script${packageWiring.rewrites.length === 1 ? "" : "s"} through \`kerstel exec\`.`);
    }
    if (bunfigWiring?.changed) {
      writeFileSync(bunfigPath, bunfigWiring.contents);
      ok(`${bunfigWiring.created ? "Created" : "Updated"} bunfig.toml with the Kerstel preload.`);
    }

    await offerGitignore(detected.root, prompter);

    // --- Step 7: self-check -------------------------------------------------
    const probeDecision = decisions.find((decision) => decision.target !== "plaintext");
    if (probeDecision) {
      const probeScope = probeDecision.target === "global" ? GLOBAL_SCOPE : scope;
      const expected = ctx.vault.getSecret({ scope: probeScope, key: probeDecision.key.key });
      if (expected !== null) {
        console.log("");
        const result = await selfCheck(detected, {
          key: probeDecision.key.key,
          reference: formatReference(probeScope, probeDecision.key.key),
          expected,
        });
        if (result === "failed") return 1;
        if (result === "passed") ok("Self-check passed: a wired process resolved a reference.");
      }
    }

    console.log("");
    ok(`${bold(scope)} is set up. Run your scripts exactly as before — \`${detected.packageManager} run <script>\` now goes through Kerstel.`);
    return 0;
  } finally {
    ctx.vault.close();
  }
}

export async function runInit(options: InitOptions, prompter: Prompter): Promise<number> {
  try {
    return await runInitSteps(options, prompter);
  } catch (error) {
    if (error instanceof NonInteractiveError) {
      fail(error.message);
      return 2;
    }
    throw error;
  }
}

function choosePrompter(options: InitOptions): Prompter | null {
  if (options.yes || options.nonInteractive) return new DefaultsPrompter();
  if (process.stdin.isTTY !== true) return null;
  return new TtyPrompter();
}

export async function initCommand(args: string[], prompterOverride?: Prompter): Promise<number> {
  const parsed = parseInitArgs(args, process.cwd());
  if ("error" in parsed) {
    fail(parsed.error);
    return 2;
  }

  const prompter = prompterOverride ?? choosePrompter(parsed);
  if (!prompter) {
    fail(
      "kerstel init asks questions, and this is not a terminal. Re-run with --yes to accept every " +
        "suggestion, or --non-interactive to fail loudly on anything it cannot decide.",
    );
    return 2;
  }

  try {
    return await runInit(parsed, prompter);
  } finally {
    // A TtyPrompter holds one readline Interface over process.stdin, and an
    // open interface keeps the event loop alive: without this close the CLI
    // would finish the wizard and then hang forever. Only a prompter WE made
    // is closed -- a caller-supplied one is the caller's to manage, and the
    // tests pass in prompters they reuse after the call returns.
    if (prompter !== prompterOverride && prompter instanceof TtyPrompter) prompter.close();
  }
}
