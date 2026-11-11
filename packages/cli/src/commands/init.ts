import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { openContext, type CliContext } from "../context";
import { cliCommand, isCompiledBinary } from "../daemon/spawn";
import { DESTINATION_CHOICES, explain, isSafeToDisplay, type Suggestion } from "../init/classify";
import { collectKeys, loadEnvFiles, type CollectedKey, type LoadedEnvFile } from "../init/collect";
import { createBackup, type BackupVaultValue } from "../init/backup";
import { detectProject, isBinaryBackupName, type DetectedProject } from "../init/detect";
import { walk } from "../scan/walk";
import { detectWorkspace } from "../init/workspace";
import { entries, parseDotenv, serializeDotenv, setValue, type UnsupportedValue } from "../init/dotenv-file";
import { deriveScope } from "../init/project-name";
import { maskForDisplay, maskPackageJsonForDisplay } from "../init/display";
import { renderChangeSummary, renderOverview, valueColumn } from "../init/overview";
import {
  CancelledError,
  ClackPrompter,
  DefaultsPrompter,
  NonInteractiveError,
  type Choice,
  type Prompter,
} from "../init/prompts";
import { findShadowedBinaries, shadowedBinaryMessage } from "../init/shadow";
import { LAUNCHER_DIR, LAUNCHER_RELATIVE_PATH, planLauncher } from "../init/launcher";
import { GITIGNORE_NOTE, renderDiff, skipReasonText, wirePackageJson } from "../init/wiring";
import { bold, dim, fail, info, ok, yellow } from "../output";
import { expandedNames } from "../expansions";
import {
  GLOBAL_SCOPE,
  formatEnvReference,
  formatReference,
  isShorthand,
  isValidScope,
  parseReference,
  type SecretRef,
} from "../reference";
import { vaultPath } from "../paths";
import { printBanner } from "../ui/banner";
import { cliName } from "../ui/cli-name";
import { interactive, note, step, withSpinner } from "../ui/steps";
import { renderTable } from "../ui/table";
import { theme } from "../ui/theme";
import { VERSION } from "../version";
import { readStoredReferences } from "../vault/meta";
import {
  canonicalRoot,
  checkScopeOwner,
  projectForRoot,
  readProjectRows,
  scopeCollisionMessage,
  scopeShareMessage,
} from "../vault/projects";
import type { Vault } from "../vault/store";

/**
 * Spec §8's setup wizard, presented as spec §5 of the CLI-look design:
 * an overview of every variable, "Look right?", a change summary, then apply.
 *
 * Three rules shape every line below:
 *   1. NO SECRET IS EVER PRINTED. Not in the overview, not in a diff, not in
 *      an error, not in the self-check. The user is told a value's length and
 *      shape and nothing else; the value itself only ever moves between the
 *      file, the vault and the encrypted backup. The one exception (spec §5.1
 *      step 2, `showValue` below): the overview prints a config value that
 *      stays in plain text on the suggester's own say-so and that
 *      `isSafeToDisplay` calls configuration, like PORT=3000.
 *      Diffs mask every value, every comment in an env file, and the values
 *      a package.json script sets inline (`maskPackageJsonForDisplay`).
 *   2. NOTHING IS WRITTEN BEFORE THE USER SAYS YES, and the backup is written
 *      before anything else, so every step has an undo. That includes values
 *      a teammate types in: they are held in memory until the plan is applied.
 *   3. --dry-run writes nothing at all, not even to ~/.kerstel: it never opens
 *      the vault or the credential store, having printed every diff.
 */

/**
 * A .gitignore line that would hide the launcher: the directory in any of
 * its spellings (`.kerstel`, `.kerstel/`, `/.kerstel`, `**\/.kerstel`,
 * `.kerstel/*`, `.kerstel/**`) or the file itself (`.kerstel/exec.cjs`,
 * `**\/exec.cjs`). A `!` negation is not a hide.
 */
const GITIGNORE_LAUNCHER_LINE = /^\s*(\*\*\/)?\/?(\.kerstel(\/(\*\*|\*|exec\.cjs))?\/?|\*\*\/exec\.cjs)\s*$/;

function gitignoreHidesLauncher(root: string): boolean {
  const path = join(root, ".gitignore");
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).some((line) => GITIGNORE_LAUNCHER_LINE.test(line));
  } catch {
    return false;
  }
}

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
      if (!value || value.startsWith("-")) return { error: "--scope needs a name, e.g. --scope my-app" };
      if (!isValidScope(value)) {
        return { error: `Invalid scope "${value}". Use a lowercase name of letters, digits, . _ or -.` };
      }
      options.scope = value;
    } else if (arg === "--global" || arg === "--keep") {
      const value = args[++i];
      if (!value || value.startsWith("-")) return { error: `${arg} needs a comma-separated list of KEYs` };
      const target = arg === "--global" ? options.globalKeys : options.keepKeys;
      for (const key of splitKeys(value)) target.add(key);
    } else {
      return {
        error:
          `Unknown option "${arg}". ${cliName()} init accepts: --yes, --dry-run, --scope <name>, ` +
          "--global KEY[,KEY], --keep KEY[,KEY], --non-interactive, --from-stdin.",
      };
    }
  }

  const both = [...options.keepKeys].filter((key) => options.globalKeys.has(key));
  if (both.length > 0) {
    return { error: `${both.join(", ")} cannot be in both --keep and --global. Pick one.` };
  }

  return options;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

interface SuppliedValue {
  ref: SecretRef;
  value: string;
}

/** Where `--from-stdin` values come from, read once however many packages ask. */
type SuppliedJson = () => Promise<Record<string, unknown> | null>;

function suppliedJsonReader(): SuppliedJson {
  let read: Promise<Record<string, unknown> | null> | null = null;
  return () =>
    (read ??= readStdin().then((raw) => {
      try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }));
}

/**
 * The value `--from-stdin` gives this package's KEY: the nested form
 * `{"apps/web": {"KEY": "value"}}` first (`"."` for the root), then the flat
 * form, which applies to every package that lacks the key. Monorepo spec §4 step 4.
 */
export function suppliedValue(json: Record<string, unknown>, rel: string, key: string): unknown {
  const nested = json[rel];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const value = (nested as Record<string, unknown>)[key];
    if (value !== undefined) return value;
  }
  return json[key];
}

/**
 * Spec §5.4's teammate flow: the repository carries references, this
 * machine's vault does not carry the values. Ask for them, or read them as
 * JSON.
 *
 * Only COLLECTS the values. Storing them is the caller's job, after the user
 * has approved the plan (rule 2).
 */
async function fillMissingReferences(
  missing: CollectedKey[],
  options: InitOptions,
  prompter: Prompter,
  run: { label: string; rel: string },
  readSupplied: SuppliedJson,
): Promise<SuppliedValue[] | number> {
  const at = (text: string) => (run.label ? `${run.label}: ${text}` : text);
  const files = [...new Set(missing.flatMap((key) => key.files))];
  step(
    at(
      `This machine is missing ${missing.length === 1 ? "1 value" : `${missing.length} values`} ` +
        `that ${files.join(", ")} ${files.length === 1 ? "references" : "reference"}:`,
    ),
    renderTable(missing.map((key) => [key.key, dim(formatReference(key.reference!.scope, key.reference!.key))])),
  );

  if (options.dryRun) {
    info("--dry-run: no values were requested and nothing was stored.");
    return [];
  }

  let supplied: Record<string, unknown> = {};
  if (options.fromStdin) {
    const json = await readSupplied();
    if (json === null) {
      fail('--from-stdin expects a JSON object of {"KEY": "value"} on stdin.');
      return 2;
    }
    supplied = json;
  }

  const values: SuppliedValue[] = [];
  for (const [i, key] of missing.entries()) {
    const ref = key.reference!;
    let value: unknown = suppliedValue(supplied, run.rel, key.key);
    if (value === undefined) {
      value = await prompter.text(at(`${key.key} · ${i + 1} of ${missing.length}`), {
        secret: true,
        flag: "--from-stdin",
      });
    }
    if (typeof value !== "string" || value === "") {
      fail(`No value supplied for ${formatReference(ref.scope, ref.key)}. Nothing was stored.`);
      return 2;
    }
    values.push({ ref, value });
  }

  return values;
}

function storeSupplied(vault: Vault, values: SuppliedValue[]): void {
  for (const { ref, value } of values) vault.setSecret(ref, value);
}

interface Decision {
  key: CollectedKey;
  /** The package this key belongs to: its scope, and its label in a workspace run ("" for a lone project). */
  scope: string;
  label: string;
  target: Suggestion;
  /** What `explain` suggested, and why. Shown in one-by-one mode. */
  suggestion: Suggestion;
  reason: string;
  /** Decided by `--keep` / `--global`: shown, never offered for change. */
  fixed: boolean;
  /** Checkouts spec §6.3: how the vault's entry at the final target compares. Null: no entry. */
  vaultEntry: "same" | "differs" | "unknown" | null;
  /** True when the vault's value stays and nothing is stored for this key. */
  keepVault: boolean;
  /** The shared vault holds this key with a different value, so it was kept out of there. */
  sharedDiffers: boolean;
}

/**
 * Rule 1 for the overview: a value is printed in full only when it stays in
 * plain text, the suggester itself called it plain text, `--keep` did not
 * force it there, and `isSafeToDisplay` calls it configuration rather than a
 * credential-shaped number or URL. Everything else -- vault-bound, a
 * secret-looking value the user moved to plain text, every `--keep` key,
 * `DB_PASSWORD=12345678`, a webhook URL -- is shown as its length.
 */
function showValue(decision: Decision): boolean {
  return (
    decision.target === "plaintext" &&
    decision.suggestion === "plaintext" &&
    !decision.fixed &&
    isSafeToDisplay(decision.key.key, decision.key.value)
  );
}

function destinationLabel(target: Suggestion, scope: string): string {
  return DESTINATION_CHOICES(scope).find((choice) => choice.value === target)!.label;
}

/**
 * What `decideTargets` may ask the vault. `has` works in a dry run (names
 * only); `value` is null there, since the dry run never opens the vault.
 */
interface VaultLookup {
  has(ref: SecretRef): boolean;
  value(ref: SecretRef): string | null;
  canCompare: boolean;
}

/** One package's plain keys, as `decideTargets` needs them. */
interface DecideInput {
  label: string;
  scope: string;
  keys: CollectedKey[];
  fileNames: string[];
}

/** `web: DATABASE_URL` in a workspace run, `DATABASE_URL` for a lone project. */
function labelled(label: string, text: string): string {
  return label ? `${label}: ${text}` : text;
}

/**
 * Monorepo spec §4 step 5: how KEY in this package compares with the same KEY
 * in the other selected packages. `same` when every package holding it has
 * this value, which is most likely one account several packages use, so the
 * shared vault is suggested. `differs` when any holds another value: there is
 * one shared copy per key, so suggesting it would hand some package another
 * package's credential, and the key stays with each package instead.
 */
function acrossPackages(
  packages: DecideInput[],
): Map<DecideInput, Map<string, { kind: "same" | "differs"; labels: string[] }>> {
  const byKey = new Map<string, { label: string; value: string }[]>();
  for (const input of packages) {
    for (const key of input.keys) byKey.set(key.key, [...(byKey.get(key.key) ?? []), { label: input.label, value: key.value }]);
  }
  const out = new Map<DecideInput, Map<string, { kind: "same" | "differs"; labels: string[] }>>();
  for (const input of packages) {
    const found = new Map<string, { kind: "same" | "differs"; labels: string[] }>();
    for (const key of input.keys) {
      const holders = byKey.get(key.key)!;
      if (holders.length < 2) continue;
      const labels = holders.map((h) => h.label);
      found.set(key.key, { kind: holders.every((h) => h.value === key.value) ? "same" : "differs", labels });
    }
    out.set(input, found);
  }
  return out;
}

/**
 * Spec §5.1 steps 2 and 3: every variable at once, grouped by where it would
 * go, then "Look right?" until the answer is yes. Checkouts spec §6.3: a key
 * the vault already holds goes where that entry is, and the overview says how
 * the file's value compares with it. Monorepo spec §4 steps 5 and 6: in a
 * workspace run, one overview with a section per package and one "Look right?"
 * over all of them.
 */
async function decideTargets(
  packages: DecideInput[],
  options: InitOptions,
  prompter: Prompter,
  vault: VaultLookup,
): Promise<Decision[]> {
  // A shared entry is another project's value as often as it is this one's:
  // it takes the key only when it holds the same value. A different value is
  // most likely a different account or database, and pointing this project at
  // it -- the default answer, and --yes -- would be a silent wrong turn. So the
  // key stays with this project, and the shared entry is left alone. Choosing
  // the shared vault yourself still asks which value stays.
  const sharedEntry = (key: CollectedKey): "same" | "differs" | "unknown" | null => {
    const ref = { scope: GLOBAL_SCOPE, key: key.key };
    if (!vault.has(ref)) return null;
    if (!vault.canCompare) return "unknown";
    return vault.value(ref) === key.value ? "same" : "differs";
  };
  const across = acrossPackages(packages);
  const decisions: Decision[] = packages.flatMap((input) =>
    input.keys.map((key): Decision => {
      const { scope, label } = input;
      const { suggestion, reason } = explain(key.key, key.value);
      const base = { key, scope, label, suggestion, vaultEntry: null, keepVault: false, sharedDiffers: false };
      if (options.keepKeys.has(key.key)) return { ...base, target: "plaintext", reason, fixed: true };
      if (options.globalKeys.has(key.key)) return { ...base, target: "global", reason, fixed: true };
      if (vault.has({ scope, key: key.key })) return { ...base, target: "project", reason: "in the vault", fixed: false };
      const shared = sharedEntry(key);
      if (shared === "same") return { ...base, target: "global", reason: "in the shared vault", fixed: false };
      if (shared === "differs") {
        const target = suggestion === "global" ? "project" : suggestion;
        // The suggestion moves with the target, so one-by-one mode does not mark
        // the shared vault "(suggested)" for a key it just kept out of there.
        return {
          ...base,
          suggestion: target,
          target,
          reason: "the shared vault holds a different value",
          fixed: false,
          sharedDiffers: true,
        };
      }
      const elsewhere = across.get(input)!.get(key.key);
      if (elsewhere && suggestion !== "plaintext") {
        const where = elsewhere.labels.join(" and ");
        if (elsewhere.kind === "same") {
          return { ...base, suggestion: "global", target: "global", reason: `same value in ${where}`, fixed: false };
        }
        return { ...base, suggestion: "project", target: "project", reason: `different values in ${where}`, fixed: false };
      }
      return { ...base, target: suggestion, reason, fixed: false };
    }),
  );

  const compare = (d: Decision): void => {
    if (d.target === "plaintext") {
      d.vaultEntry = null;
      return;
    }
    const ref = { scope: d.target === "global" ? GLOBAL_SCOPE : d.scope, key: d.key.key };
    if (!vault.has(ref)) d.vaultEntry = null;
    else if (!vault.canCompare) d.vaultEntry = "unknown";
    else d.vaultEntry = vault.value(ref) === d.key.value ? "same" : "differs";
  };
  const noteFor = (d: Decision): string | undefined =>
    d.vaultEntry === "same"
      ? "already in the vault"
      : d.vaultEntry === "differs"
        ? "differs from the vault"
        : d.vaultEntry === "unknown"
          ? "in the vault"
          : d.sharedDiffers && d.target !== "plaintext"
            ? "differs from the shared vault"
            : (d.reason.startsWith("same value in ") && d.target === "global") ||
                (d.reason.startsWith("different values in ") && d.target === "project")
              ? d.reason
              : undefined;

  const showOverview = (title: string): void => {
    decisions.forEach(compare);
    const sections = packages
      .map((input) => ({ input, rows: decisions.filter((d) => d.label === input.label && d.scope === input.scope) }))
      .filter(({ rows }) => rows.length > 0);
    const lines = sections.flatMap(({ input, rows }, i) => {
      const overview = renderOverview(
        rows.map((d) => ({
          key: d.key.key,
          value: d.key.value,
          source: d.key.source,
          conflicts: d.key.conflicts,
          target: d.target,
          showValue: showValue(d),
          note: noteFor(d),
        })),
        input.scope,
        input.fileNames,
      );
      if (!input.label) return overview;
      return [...(i > 0 ? [""] : []), bold(input.label), ...overview.map((line) => `  ${line}`)];
    });
    step(title, lines);
  };

  showOverview(
    `Found ${decisions.length === 1 ? "1 variable" : `${decisions.length} variables`}. Here's where I'd put them:`,
  );

  const open = decisions.filter((d) => !d.fixed);
  if (open.length === 0) return askVaultConflicts(decisions, prompter);

  for (;;) {
    const answer = await prompter.select(
      "Look right?",
      [
        { value: "accept", label: "Yes, use these" },
        { value: "change", label: "Let me change some" },
        { value: "each", label: "Go through them one by one" },
      ],
      "accept",
    );
    if (answer === "accept") return askVaultConflicts(decisions, prompter);

    if (answer === "change") {
      // A lone project keeps the key name as the choice's value, so scripts and
      // tests that pick keys by name still work; a workspace needs the package too.
      const id = (d: Decision): string => labelled(d.label, d.key.key);
      const picked = await prompter.multiselect(
        "Which ones do you want to change?",
        open.map((d) => ({ value: id(d), label: id(d), hint: destinationLabel(d.target, d.scope) })),
        [],
      );
      for (const name of picked) {
        const decision = open.find((d) => id(d) === name)!;
        decision.target = await prompter.select(
          `${name} · where should it go?`,
          DESTINATION_CHOICES(decision.scope),
          decision.target,
        );
      }
    } else {
      for (const [i, decision] of open.entries()) {
        const choices = DESTINATION_CHOICES(decision.scope).map((choice) =>
          choice.value === decision.suggestion ? { ...choice, hint: `${choice.hint} (suggested)` } : choice,
        );
        decision.target = await prompter.select(
          `${labelled(decision.label, decision.key.key)} · ${i + 1} of ${open.length}\n` +
            `${valueColumn(decision.key.value, showValue(decision))} · from ${decision.key.source}\n` +
            dim(decision.reason),
          choices,
          decision.target,
        );
      }
    }

    showOverview("Here's where they'll go now:");
  }
}

/** Checkouts spec §6.3: one question per key whose file value differs from the vault's. */
async function askVaultConflicts(decisions: Decision[], prompter: Prompter): Promise<Decision[]> {
  for (const d of decisions) {
    if (d.vaultEntry === "same") d.keepVault = true;
    if (d.vaultEntry !== "differs") continue;
    const reference = formatReference(d.target === "global" ? GLOBAL_SCOPE : d.scope, d.key.key);
    const answer = await prompter.select(
      `${labelled(d.label, d.key.key)}: ${reference} already holds a different value. Which one stays?`,
      [
        { value: "keep", label: "Keep the vault's value" },
        { value: "use", label: "Use this file's value" },
      ],
      "keep",
    );
    d.keepVault = answer === "keep";
  }
  return decisions;
}

interface FileChange {
  path: string;
  label: string;
  /** The bytes to write once the user has said yes. */
  after: string;
  /** How many values in this file become references. */
  count: number;
  /**
   * The two sides of the diff the user is shown: the same file with every
   * value masked (see `maskForDisplay`), so the diff is a full, honest,
   * line-for-line diff without being a printed copy of the secrets -- rule 1
   * above.
   */
  diffBefore: string;
  diffAfter: string;
}

function planEnvRewrites(loaded: LoadedEnvFile[], references: Map<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  for (const entry of loaded) {
    // Re-parse from the original bytes so a rewrite is always computed from
    // what is on disk, never from an object an earlier step already mutated.
    const copy = parseDotenv(entry.original);
    const before = entries(copy).map((pair) => pair.value);
    for (const [key, reference] of references) setValue(copy, key, reference);
    const after = serializeDotenv(copy);
    if (after === entry.original) continue;

    changes.push({
      path: entry.info.path,
      label: entry.info.name,
      after,
      count: entries(copy).filter((pair, i) => pair.value !== before[i]).length,
      diffBefore: maskForDisplay(entry.original),
      diffAfter: maskForDisplay(after),
    });
  }
  return changes;
}

/**
 * Every key in the PLANNED env files whose value is still plaintext.
 *
 * Read from the bytes init is about to write rather than inferred from the
 * decisions: `--keep`, a "plaintext" answer and a line the parser refused all
 * leave a real value behind, and the question this answers -- "is it safe to
 * commit these files?" -- may only be answered by what the files will say.
 */
function plaintextKeysRemaining(files: { name: string; contents: string }[]): string[] {
  const remaining: string[] = [];
  for (const { name, contents } of files) {
    const file = parseDotenv(contents);
    for (const pair of entries(file)) {
      if (parseReference(pair.value, pair.key) !== null) continue;
      if (!remaining.includes(pair.key)) remaining.push(pair.key);
    }
    // A line the parser could not read is a line that was never rewritten.
    for (const unsupported of file.unsupported) {
      const label = untouchedLabel(name, unsupported);
      if (!remaining.includes(label)) remaining.push(label);
    }
  }
  return remaining;
}

/**
 * Env files below `root` that this run does not rewrite, with the keys each
 * still holds in plain text. Backup copies count: `.env.*` hides `.env.bak`.
 * Found with `kerstel scan`'s walk, so `node_modules` is never entered.
 */
function plaintextOutside(root: string, rewritten: Set<string>): { path: string; keys: string[] }[] {
  const out: { path: string; keys: string[] }[] = [];
  for (const found of walk(root).files) {
    if (found.kind === "template" || rewritten.has(found.path) || isBinaryBackupName(found.name)) continue;
    let contents: string;
    try {
      contents = readFileSync(found.path, "utf8");
    } catch {
      continue;
    }
    const keys = plaintextKeysRemaining([{ name: found.name, contents }]);
    if (keys.length > 0) out.push({ path: found.path, keys });
  }
  return out;
}

/**
 * How an unsupported line is named in a list: by its key when the parser found
 * one, otherwise by file and line (`.env line 4`), so two files' fourth lines
 * do not collapse into one entry and the user knows which file to open.
 */
function untouchedLabel(fileName: string, unsupported: UnsupportedValue): string {
  return unsupported.key.startsWith("line ") ? `${fileName} ${unsupported.key}` : unsupported.key;
}

/**
 * Plain-text keys `ks move` could actually act on: parsed `KEY=value` pairs,
 * unlike `plaintextKeysRemaining`, which also lists lines the parser refused
 * to read at all. A line `ks move` never touched is not a line it can move.
 */
function movablePlaintextKeys(files: { name: string; contents: string }[]): string[] {
  const remaining: string[] = [];
  for (const { contents } of files) {
    const file = parseDotenv(contents);
    for (const pair of entries(file)) {
      if (parseReference(pair.value, pair.key) !== null) continue;
      if (!remaining.includes(pair.key)) remaining.push(pair.key);
    }
  }
  return remaining;
}

interface GitignoreChange {
  path: string;
  /** The folder holding it, and its label in a workspace run ("" for a lone project). */
  root: string;
  label: string;
  before: string;
  after: string;
  count: number;
}

/**
 * Spec §5.1 step 4, asked before anything is written; `runInitSteps` writes
 * the answer during apply. Default NO: committing `.env` is the user's call,
 * not ours. Monorepo spec §4 step 7: one question in a workspace run, whose
 * answer applies to the root's `.gitignore` and each package's own.
 */
async function planGitignores(
  folders: { root: string; label: string }[],
  /** Keys left in plain text that removing the lines in these folders' .gitignore files would expose. */
  plaintextUnder: (roots: string[]) => string[],
  prompter: Prompter,
): Promise<GitignoreChange[]> {
  const found: { root: string; label: string; path: string; source: string; parts: string[]; hidden: string[] }[] = [];
  for (const { root, label } of folders) {
    const path = join(root, ".gitignore");
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    const parts = source.split(/(\r\n|\n)/);
    const hidden: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const text = parts[i] ?? "";
      if (GITIGNORE_ENV_LINE.test(text)) hidden.push(text.trim());
    }
    if (hidden.length > 0) found.push({ root, label, path, source, parts, hidden });
  }
  if (found.length === 0) return [];
  const plaintext = plaintextUnder(found.map((file) => file.root));

  console.log("");
  for (const file of found) {
    info(
      file.label
        ? `${file.label}: .gitignore hides env files: ${file.hidden.join(", ")}`
        : `.gitignore hides your env files: ${file.hidden.join(", ")}`,
    );
  }

  // Names only. `plaintextKeysRemaining` returns keys, never values.
  if (plaintext.length > 0) {
    console.log(
      yellow(
        `!  ${plaintext.length} key${plaintext.length === 1 ? " still holds a plaintext value" : "s still hold plaintext values"}: ` +
          `${plaintext.join(", ")} — committing these files would expose them.`,
      ),
    );
  } else {
    info("Once applied, they'll hold references, not secrets, so committing them gives teammates a living .env.example.");
  }

  const answer = await prompter.select(
    found.length === 1 && !found[0]!.label
      ? "Remove the .env lines from .gitignore so these files can be committed?"
      : `Remove the .env lines from ${found.length === 1 ? "that .gitignore" : `those ${found.length} .gitignore files`} so these files can be committed?`,
    [
      { value: "keep", label: "No, leave .gitignore as it is", hint: "Safest if any value is still plain text" },
      {
        value: "remove",
        label: "Yes, remove them",
        hint: "The files hold references, so teammates get a working .env.example",
      },
    ],
    "keep",
  );
  if (answer === "keep") {
    info("Left .gitignore alone.");
    return [];
  }

  return found.map(({ root, label, path, source, parts, hidden }) => {
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
    return { path, root, label, before: source, after: kept.join(""), count: hidden.length };
  });
}

/**
 * The closing report when the self-check fails.
 *
 * A failed self-check used to return 1 straight after a migration that had
 * entirely succeeded, so the last thing the user saw was an error with no
 * word about the secrets now in their vault, the files now holding
 * references, or the backup holding their originals. Exit 1 is right --
 * something is wrong -- but silence about the work that did land is not.
 */
export function summaryLines(options: {
  scope: string;
  packageManager: string;
  backupDir: string;
  verified: boolean;
}): string[] {
  const lines = [
    `${bold(options.scope)} is set up. Run your scripts exactly as before — \`${options.packageManager} run <script>\` now goes through Kerstel.`,
  ];
  if (options.verified) return lines;

  lines.push(
    "The migration itself completed: your values are in the vault, your .env files hold references, and your scripts are wired.",
    `Your originals are in the encrypted backup at ${options.backupDir}.`,
    `Only the self-check failed, so a wired process cannot reach the daemon yet. Run \`${cliName()} doctor\` in this directory, ` +
      `then \`${cliName()} daemon start\` to see why the daemon will not start.`,
  );
  return lines;
}

/** Spec 2026-09-24 §2.3: the way back from a choice made here. */
export function movePointer(): string {
  return `To move a key between the vault and plain text later, run ${cliName()} move.`;
}

type SelfCheckResult =
  | { status: "passed" }
  | { status: "failed"; message: string; stderr: string }
  | { status: "skipped"; message: string };

/** Carries a failed or skipped self-check out of its spinner, which shows the message. */
class SelfCheckProblem extends Error {
  constructor(readonly result: Exclude<SelfCheckResult, { status: "passed" }>) {
    super(result.message);
  }
}

/**
 * Spec §8 step 6: prove the wiring works by running a probe through it.
 *
 * The probe spawns THIS CLI (`kerstel exec -- <runtime> -e ...`) with one
 * reference in its environment and compares what the child printed to what the
 * vault holds. Neither string is ever printed -- a self-check that leaks the
 * secret it is checking would defeat the product it is checking. It prints
 * nothing itself: it runs under a spinner.
 */
async function selfCheck(
  detected: DetectedProject,
  probe: { key: string; reference: string; expected: string },
  /** True when this run wrote the launcher or found it current, so it is the thing to probe through. */
  throughLauncher: boolean,
): Promise<SelfCheckResult> {
  const runtime = detected.runtime === "bun" ? "bun" : "node";
  const expression = `process.stdout.write(String(process.env.${probe.key}))`;
  // Spec 2026-09-21 §5.5: through the launcher just written, which finds this
  // binary on PATH. From source there is no `kerstel` on PATH for it to find,
  // so the probe calls the CLI entry point directly, as it did before.
  // Only through a launcher this run wrote or verified. A project whose
  // scripts are all lifecycle or refused has none, and a file that happens to
  // sit at that path unverified (stale, edited, someone else's) must not
  // decide whether the migration passed; then the probe calls the CLI as it
  // always did.
  const compiled = isCompiledBinary() && throughLauncher;
  const command = compiled
    ? [runtime, LAUNCHER_RELATIVE_PATH, "--", runtime, "-e", expression]
    : cliCommand(["exec", "--", runtime, "-e", expression]);
  const pathForProbe = compiled ? `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` : process.env.PATH;

  try {
    const child = Bun.spawn(command, {
      cwd: detected.root,
      env: { ...process.env, [probe.key]: probe.reference, ...(pathForProbe === undefined ? {} : { PATH: pathForProbe }) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (code === 0 && stdout === probe.expected) return { status: "passed" };

    // stderr is the child's diagnostics, never the resolved value: the probe
    // writes the value to stdout, which is deliberately not echoed anywhere.
    return {
      status: "failed",
      message:
        `Self-check failed: a ${runtime} process wired through ${compiled ? "the launcher" : "`kerstel exec`"} did not receive the ` +
        `value behind ${probe.reference}. Run \`${cliName()} doctor\` in this directory.`,
      stderr: stderr.trim(),
    };
  } catch (error) {
    return {
      status: "skipped",
      message:
        `Self-check skipped: could not run "${runtime}" (${(error as Error).message}). ` +
        "Your scripts are wired; run one to confirm.",
    };
  }
}

/** The script the closing note tells the user to run: `dev`, else the first one init wired. */
function scriptToRun(packageJson: Record<string, unknown>, wired: string[]): string {
  const scripts = packageJson.scripts;
  if (scripts && typeof scripts === "object" && "dev" in scripts) return "dev";
  return wired[0] ?? "<script>";
}

/** One package in this run: a lone project, or one selected member of a workspace. */
interface PackageRun {
  detected: DetectedProject;
  /** "" for a lone project; in a workspace run the folder relative to the root, or "(root)". */
  label: string;
  /** The key for this package in nested `--from-stdin` JSON: its relative path, "." for the root. */
  rel: string;
  scope: string;
  fileNames: string[];
  loaded: LoadedEnvFile[];
  keys: CollectedKey[];
}

/** What applying one package will write. */
interface PackagePlan {
  run: PackageRun;
  supplied: SuppliedValue[];
  decisions: Decision[];
  envChanges: FileChange[];
  packageSource: string;
  packageWiring: ReturnType<typeof wirePackageJson>;
  wiredClaim: string;
  anyWired: boolean;
  launcher: ReturnType<typeof planLauncher> | null;
  plannedFiles: { name: string; contents: string }[];
  nothingToDo: boolean;
}

/**
 * Detect and parse one package, printing its warnings. Returns an exit code
 * when the run has to stop here.
 */
function preparePackage(
  detected: DetectedProject,
  where: { label: string; rel: string; workspace: boolean },
  scopeOverride: string | undefined,
  projects: ReturnType<typeof readProjectRows>,
): PackageRun | number {
  const at = (text: string) => labelled(where.label, text);
  if (!detected.packageJson) {
    fail(
      detected.packageJsonError === "invalid"
        ? `${detected.packageJsonPath} is not valid JSON. Fix it, then re-run \`${cliName()} init\`.`
        : `No readable package.json in ${detected.root}. Run \`${cliName()} init\` from your project root ` +
            "(Kerstel wires package scripts, so it needs one).",
    );
    return 2;
  }

  // Before anything is derived, shown, or written: the wiring this wizard is
  // about to propose hands every script to whatever `kerstel` npm finds first,
  // and npm looks in node_modules/.bin before PATH. See init/shadow.ts.
  const shadowed = findShadowedBinaries(detected.root);
  if (shadowed.length > 0) {
    fail(at(shadowedBinaryMessage(shadowed)));
    return 1;
  }

  // Checkouts spec §6.2. The projects table is readable without the key, so
  // this runs under --dry-run too, before anything is shown or written.
  const scope =
    scopeOverride ??
    projectForRoot(projects, detected.root)?.name ??
    deriveScope({ packageName: detected.packageName, rootPath: detected.root }).scope;
  const owner = checkScopeOwner(projects, scope, detected.root, detected.packageName);
  if (owner.kind === "different-package" && scopeOverride === undefined) {
    fail(
      !where.workspace
        ? scopeCollisionMessage(scope, owner)
        : where.rel === "."
          ? scopeCollisionMessage(scope, owner, "Re-run here with --scope <name> to give the root package its own.")
          : scopeCollisionMessage(
              scope,
              owner,
              `Run \`${cliName()} init --scope <name>\` inside ${where.rel} to give it its own, then run init here again.`,
            ),
    );
    return 2;
  }

  const fileNames = detected.envFiles.map((file) => file.name);
  step(
    at(
      [`Setting up ${scope}`, `${detected.framework ?? detected.runtime} on ${detected.packageManager}`]
        .concat(fileNames.length > 0 ? [fileNames.join(", ")] : [])
        .join(" · "),
    ),
  );
  if (owner.kind === "another-checkout") info(at(`Another checkout of ${scope} is at ${owner.roots.join(", ")}.`));
  if (owner.kind === "different-package") info(at(scopeShareMessage(scope, owner)));

  // Before the empty check: a project whose only .env is a broken symlink has
  // an env file, and "no .env files here" would be the wrong thing to say.
  for (const name of detected.unreadableEnvFiles) {
    console.log(yellow(`!  ${at(`${name} could not be read (a broken symlink?), so it was skipped.`)}`));
  }
  // A backup copy is not migrated (no loader reads it, and its stale values
  // would otherwise outrank the live file), but it most likely still holds
  // the plaintext this migration is removing, so it is named rather than hidden.
  for (const name of detected.backupEnvFiles) {
    console.log(
      yellow(
        `!  ${at(`${name} looks like a backup copy, so it was skipped. It may still hold plaintext: delete it once you no longer need it, or rename it if it is a real env file.`)}`,
      ),
    );
  }

  if (detected.envFiles.length === 0 && detected.unreadableEnvFiles.length > 0) {
    fail(`No readable .env files here. Fix or remove the ones above, then re-run \`${cliName()} init\`.`);
    return 1;
  }
  if (detected.envFiles.length === 0) {
    fail(
      "No .env files here. There is nothing to migrate yet -- create one, or store secrets " +
        `directly with \`${cliName()} set <scope>/<KEY>\`.`,
    );
    return 1;
  }

  // --- Parse ----------------------------------------------------------------
  const loaded = loadEnvFiles(detected.envFiles);
  for (const entry of loaded) {
    for (const unsupported of entry.file.unsupported) {
      console.log(
        yellow(
          `!  ${at(`${entry.info.name}:${unsupported.line} — ${unsupported.key} left untouched because ${unsupported.reason}.`)}`,
        ),
      );
    }
  }

  const keys = collectKeys(loaded);
  // A plaintext key's conflict is named in the overview. A reference that
  // differs between files never reaches the overview, so it is named here.
  for (const key of keys) {
    if (key.conflicts.length === 0 || key.reference === null) continue;
    console.log(
      yellow(
        `!  ${at(
          `${key.key} differs between ${key.source} and ${key.conflicts.join(", ")}. Kerstel keeps the ` +
            `${key.source} reference and points every file at it; the others survive only in the encrypted ` +
            "backup. (Kerstel has no environments yet.)",
        )}`,
      ),
    );
  }

  return { detected, label: where.label, rel: where.rel, scope, fileNames, loaded, keys };
}

/** `--keep` and `--global` name keys; say which of them no selected package can use. */
function warnUnusedKeyFlags(runs: PackageRun[], options: InitOptions): void {
  const keys = runs.flatMap((run) => run.keys);
  const known = new Set(keys.map((key) => key.key));
  const plainSomewhere = new Set(keys.filter((key) => key.reference === null).map((key) => key.key));
  for (const [flag, named] of [
    ["--keep", options.keepKeys],
    ["--global", options.globalKeys],
  ] as const) {
    const unknown = [...named].filter((key) => !known.has(key));
    if (unknown.length > 0) {
      console.log(yellow(`!  ${flag} names ${unknown.join(", ")}, which no env file defines. Ignored.`));
    }
    // Flags decide where a PLAINTEXT value goes; a reference has already gone.
    const migrated = [...named].filter((key) => known.has(key) && !plainSomewhere.has(key));
    if (migrated.length > 0) {
      console.log(yellow(`!  ${flag} names ${migrated.join(", ")}, already a reference. Ignored.`));
    }
  }
}

/**
 * Monorepo spec §4 steps 1 and 2: at a workspace root, which packages to set
 * up. Null when `cwd` is not a workspace root, so `init` sets up the folder
 * as one project, as it always has.
 */
async function pickWorkspacePackages(
  options: InitOptions,
  prompter: Prompter,
): Promise<{ root: string; packages: DetectedProject[] } | number | null> {
  const workspace = detectWorkspace(options.cwd, (message) => console.log(yellow(`!  ${message}`)));
  if (!workspace) return null;
  const rel = (dir: string) => relative(workspace.root, dir) || "(root)";

  if (workspace.packages.length === 0) {
    fail("No package in this workspace has a .env file.");
    return 1;
  }
  const n = workspace.packages.length;
  step(`Workspace: ${n} package${n === 1 ? "" : "s"} with .env files`);
  const all = workspace.packages.map((p) => p.root);
  const picked =
    options.yes || options.nonInteractive
      ? all
      : await prompter.multiselect(
          "Which packages should Kerstel set up?",
          workspace.packages.map((p) => ({
            value: p.root,
            label: rel(p.root),
            hint: [p.envFiles.map((f) => f.name).join(", "), p.packageName].filter(Boolean).join(" · "),
          })),
          all,
        );
  if (picked.length === 0) {
    info("Nothing selected. Nothing was changed.");
    return 0;
  }
  // Monorepo spec §4 step 1: --scope names the package in this folder.
  if (options.scope !== undefined && !picked.includes(workspace.root)) {
    fail(
      "--scope names the package in this folder, and the root is not being set up. " +
        `Run ${cliName()} init --scope <name> inside the package you want to rename.`,
    );
    return 2;
  }
  return { root: workspace.root, packages: workspace.packages.filter((p) => picked.includes(p.root)) };
}

/**
 * The wizard proper. Wrapped by `runInit` below, which is what everything
 * calls: a NonInteractiveError raised anywhere in here means the same thing
 * (this run cannot answer its own question) and deserves the same exit code
 * whether it reached us through `initCommand` or straight from a test.
 */
async function runInitSteps(options: InitOptions, prompter: Prompter): Promise<number> {
  printBanner(theme, VERSION);

  // --- Detect ---------------------------------------------------------------
  const workspace = await pickWorkspacePackages(options, prompter);
  if (typeof workspace === "number") return workspace;

  const projects = readProjectRows(vaultPath());
  const runs: PackageRun[] = [];
  if (workspace === null) {
    const run = preparePackage(detectProject(options.cwd), { label: "", rel: ".", workspace: false }, options.scope, projects);
    if (typeof run === "number") return run;
    runs.push(run);
  } else {
    for (const detected of workspace.packages) {
      const rel = relative(workspace.root, detected.root);
      const run = preparePackage(
        detected,
        { label: rel || "(root)", rel: rel || ".", workspace: true },
        rel === "" ? options.scope : undefined,
        projects,
      );
      if (typeof run === "number") return run;
      runs.push(run);
    }
    // Two members whose names slugify alike would otherwise share one scope's
    // secrets without anyone choosing that.
    const byScope = new Map<string, string[]>();
    for (const run of runs) byScope.set(run.scope, [...(byScope.get(run.scope) ?? []), run.label]);
    for (const [scope, labels] of byScope) {
      if (labels.length < 2) continue;
      fail(
        `${labels.join(" and ")} would both use the scope "${scope}". Run \`${cliName()} init --scope <name>\` ` +
          "inside one of them to give it its own, then run init here again.",
      );
      return 2;
    }
  }
  warnUnusedKeyFlags(runs, options);

  // --dry-run never opens the vault: opening it creates ~/.kerstel, installs
  // the hook, and can mint a data key. The names of stored secrets are readable
  // without the key, and that is all a dry run needs.
  const storedNames = options.dryRun ? readStoredReferences(vaultPath()) : null;
  const ctx = options.dryRun ? null : await openContext();
  try {
    const inVault = (ref: SecretRef): boolean =>
      ctx ? ctx.vault.getSecret(ref) !== null : storedNames!.has(`${ref.scope}/${ref.key}`);

    // --- Teammate flow ------------------------------------------------------
    const readSupplied = suppliedJsonReader();
    const supplied = new Map<PackageRun, SuppliedValue[]>();
    for (const run of runs) {
      const missing = run.keys.filter((key) => key.reference !== null && !inVault(key.reference));
      let values: SuppliedValue[] = [];
      if (missing.length > 0) {
        const result = await fillMissingReferences(missing, options, prompter, run, readSupplied);
        if (typeof result === "number") return result;
        values = result;
      }
      supplied.set(run, values);
    }

    // --- Overview and "Look right?" -----------------------------------------
    const lookup: VaultLookup = {
      has: inVault,
      value: (ref) => (ctx ? ctx.vault.getSecret(ref) : null),
      canCompare: ctx !== null,
    };
    const inputs = runs.map((run) => ({
      label: run.label,
      scope: run.scope,
      keys: run.keys.filter((key) => key.reference === null),
      fileNames: run.fileNames,
    }));
    const allDecisions = inputs.some((input) => input.keys.length > 0)
      ? await decideTargets(inputs, options, prompter, lookup)
      : [];

    // One reference holds one value. Two packages writing different values to
    // the same one -- both choosing the shared vault, `--global` over values
    // that differ, or nested `--from-stdin` -- would leave whichever applied
    // last, silently, and hand the other package the wrong credential.
    const writes = new Map<string, { label: string; value: string }[]>();
    const write = (ref: SecretRef, label: string, value: string): void => {
      const id = formatReference(ref.scope, ref.key);
      writes.set(id, [...(writes.get(id) ?? []), { label, value }]);
    };
    for (const run of runs) for (const { ref, value } of supplied.get(run)!) write(ref, run.label, value);
    for (const d of allDecisions) {
      if (d.target === "plaintext" || d.keepVault) continue;
      write({ scope: d.target === "global" ? GLOBAL_SCOPE : d.scope, key: d.key.key }, d.label, d.key.value);
    }
    const clashes = [...writes].filter(([, ws]) => new Set(ws.map((w) => w.value)).size > 1);
    if (clashes.length > 0) {
      for (const [ref, ws] of clashes) {
        fail(
          `${[...new Set(ws.map((w) => w.label))].join(" and ")} would store different values in ${ref}, ` +
            "so one package would read the other's. Keep the key with each package, or give them the same value.",
        );
      }
      info("Nothing was changed.");
      return 2;
    }

    // --- Plan -----------------------------------------------------------------
    const plans: PackagePlan[] = runs.map((run) => {
      const at = (text: string) => labelled(run.label, text);
      const decisions = allDecisions.filter((d) => d.label === run.label && d.scope === run.scope);
      // A variable another line copies with `${NAME}` keeps its key in the
      // reference, or the copy would name a different key (spec §5.1).
      const expanded = expandedNames(run.loaded.map((entry) => entry.original));
      const references = new Map<string, string>();
      for (const decision of decisions) {
        if (decision.target === "plaintext") continue;
        const target = decision.target === "global" ? GLOBAL_SCOPE : run.scope;
        const name = decision.key.key;
        references.set(name, formatEnvReference(name, target, name, expanded.has(name)));
      }
      for (const key of run.keys.filter((k) => k.reference !== null)) {
        // Already-migrated keys keep their existing reference, which the
        // rewrite planner needs so an unchanged file is detected as unchanged.
        // The one exception is a shorthand that a line added since now copies
        // with `${NAME}`: it gets its key written out, for the same reason as
        // above. A `kerstel://` line already names its key and stays as it is.
        const ref = key.reference!;
        const value =
          isShorthand(key.value) && expanded.has(key.key) ? formatEnvReference(key.key, ref.scope, ref.key, true) : key.value;
        references.set(key.key, value);
      }
      const envChanges = planEnvRewrites(run.loaded, references).map((change) => ({
        ...change,
        label: at(change.label),
      }));

      const packageSource = readFileSync(run.detected.packageJsonPath, "utf8");
      const packageWiring = wirePackageJson(packageSource);
      // A script the wirer REFUSES is named whether or not anything else
      // changes: the user may expect it to be hooked, and a run that migrates
      // the env files and says nothing about it would leave that script reading
      // literal references. Lifecycle and already-wired scripts are the expected
      // shape of a package.json and are not worth a line.
      const refused = packageWiring.skipped.filter(
        (skip) => skip.reason !== "lifecycle" && skip.reason !== "already-wired" && skip.reason !== "not-a-string",
      );
      for (const skip of refused) {
        console.log(yellow(`!  ${at(`Script "${skip.name}" is not wired through Kerstel: ${skipReasonText(skip.reason)}.`)}`));
      }
      const wiredClaim = refused.length > 0 ? "the scripts Kerstel can wire are wired" : "your scripts are wired";

      // Spec 2026-09-21 §4.1: the launcher is written whenever a script runs
      // through it, and rewritten whenever the file on disk is not the one this
      // Kerstel writes. A project with nothing wired gets no launcher.
      const anyWired = packageWiring.changed || packageWiring.skipped.some((skip) => skip.reason === "already-wired");
      const launcher = anyWired ? planLauncher(run.detected.root) : null;
      if (launcher?.status.kind === "foreign") {
        console.log(
          yellow(
            `!  ${at(`${LAUNCHER_RELATIVE_PATH} exists but is not Kerstel's launcher (no marker line). Your scripts are about to run through that path, so it will be replaced.`)}`,
          ),
        );
      }
      if (launcher && gitignoreHidesLauncher(run.detected.root)) {
        console.log(
          yellow(
            `!  ${at(`.gitignore hides ${LAUNCHER_DIR}/, so the launcher would not reach your deploy host. Remove that line before committing.`)}`,
          ),
        );
      }

      const plannedFiles = run.loaded.map((entry) => ({
        name: entry.info.name,
        contents: envChanges.find((change) => change.path === entry.info.path)?.after ?? entry.original,
      }));
      return {
        run,
        supplied: supplied.get(run)!,
        decisions,
        envChanges,
        packageSource,
        packageWiring,
        wiredClaim,
        anyWired,
        launcher,
        plannedFiles,
        nothingToDo: envChanges.length === 0 && !packageWiring.changed && !launcher,
      };
    });

    if (plans.every((plan) => plan.nothingToDo)) {
      for (const plan of plans) reportNothingToDo(plan, ctx?.vault ?? null);
      return 0;
    }

    const plaintext = plans.flatMap((plan) =>
      plaintextKeysRemaining(plan.plannedFiles).map((key) => labelled(plan.run.label, key)),
    );
    // A `.env` line in .gitignore hides every env file below it, not only the
    // ones this run rewrites: a package left unselected, a nested
    // `docker/.env`, a `.env.bak`. Their plaintext counts too.
    const rewritten = new Set(runs.flatMap((run) => run.loaded.map((entry) => entry.info.path)));
    const base = workspace?.root ?? runs[0]!.detected.root;
    const untouchedFiles = plaintextOutside(base, rewritten);

    // --- .gitignore: asked now, written during apply --------------------------
    const gitignoreFolders = runs.map((run) => ({ root: run.detected.root, label: run.label }));
    if (workspace && !runs.some((run) => run.detected.root === workspace.root)) {
      gitignoreFolders.unshift({ root: workspace.root, label: "(root)" });
    }
    const gitignores = options.dryRun
      ? []
      : await planGitignores(gitignoreFolders, (roots) => [
          ...plaintext,
          ...untouchedFiles
            .filter((file) => roots.some((root) => file.path.startsWith(`${root}${sep}`)))
            .flatMap((file) => file.keys.map((key) => `${relative(base, file.path)}: ${key}`)),
        ], prompter);

    // --- What will change -------------------------------------------------------
    step(
      "Here's what will change:",
      renderChangeSummary([
        ...plans.flatMap((plan) => [
          ...plan.envChanges.map((change) => ({ label: change.label, kind: "env" as const, count: change.count })),
          ...(plan.packageWiring.changed
            ? [
                {
                  label: labelled(plan.run.label, "package.json"),
                  kind: "package" as const,
                  count: plan.packageWiring.rewrites.length,
                },
              ]
            : []),
          ...(plan.launcher
            ? [
                {
                  label: labelled(plan.run.label, LAUNCHER_RELATIVE_PATH),
                  kind: "launcher" as const,
                  count: plan.launcher.status.kind === "missing" ? 0 : plan.launcher.status.kind === "foreign" ? 2 : 1,
                },
              ]
            : []),
        ]),
        ...gitignores.map((g) => ({ label: labelled(g.label, ".gitignore"), kind: "gitignore" as const, count: g.count })),
      ]),
    );

    const printDiffs = (): void => {
      console.log("");
      for (const plan of plans) {
        const at = (text: string) => labelled(plan.run.label, text);
        for (const change of plan.envChanges) {
          console.log(renderDiff(change.label, change.diffBefore, change.diffAfter));
        }
        if (plan.packageWiring.changed) {
          console.log(
            renderDiff(
              at("package.json"),
              maskPackageJsonForDisplay(plan.packageSource),
              maskPackageJsonForDisplay(plan.packageWiring.contents),
            ),
          );
        }
        // Program text, not a secret: shown in full.
        if (plan.launcher) {
          console.log(renderDiff(at(LAUNCHER_RELATIVE_PATH), plan.launcher.before ?? "", plan.launcher.after));
        }
      }
      for (const g of gitignores) console.log(renderDiff(labelled(g.label, ".gitignore"), g.before, g.after));
    };

    // --dry-run stops here, before the first write.
    if (options.dryRun) {
      printDiffs();
      console.log("");
      info("--dry-run: nothing was written.");
      return 0;
    }

    let applyChoices: Choice<"apply" | "diff" | "cancel">[] = [
      { value: "apply", label: "Apply" },
      { value: "diff", label: "Show the full diff first" },
      { value: "cancel", label: "Cancel" },
    ];
    for (;;) {
      const answer = await prompter.select("Apply these changes?", applyChoices, "apply");
      if (answer === "apply") break;
      if (answer === "cancel") {
        info("Nothing was changed.");
        return 0;
      }
      printDiffs();
      applyChoices = applyChoices.filter((choice) => choice.value !== "diff");
    }

    // Past the dry-run return, so the vault is open.
    const context = ctx!;

    // --- Apply, package by package ------------------------------------------------
    // Monorepo spec §4 step 9: a package that fails stops the run with the
    // package named; those already applied stay applied, and running init
    // again is safe, since every step is idempotent.
    const applied: PackagePlan[] = [];
    for (const plan of plans) {
      const gitignore = gitignores.find((g) => g.root === plan.run.detected.root) ?? null;
      let result: number;
      try {
        result = await applyPackage(plan, gitignore, context);
      } catch (error) {
        if (!plan.run.label) throw error;
        fail(`${plan.run.label}: ${(error as Error).message}`);
        result = 1;
      }
      if (result !== 0) {
        if (applied.length > 0) {
          info(
            `${applied.map((p) => p.run.label).join(", ")} ${applied.length === 1 ? "is" : "are"} set up. ` +
              `Fix ${plan.run.label}, then run ${cliName()} init here again to finish.`,
          );
        }
        return result;
      }
      applied.push(plan);
    }
    // The root's .gitignore, when the root is not one of the packages set up.
    for (const g of gitignores.filter((g) => !runs.some((run) => run.detected.root === g.root))) {
      await withSpinner(`Updating ${labelled(g.label, ".gitignore")}`, `Updated ${labelled(g.label, ".gitignore")}`, async () =>
        writeFileSync(g.path, g.after),
      );
    }

    // --- Outro ----------------------------------------------------------------------
    const anyPlaintextLeft = plaintext.length > 0;
    const movable = plans.some((plan) => movablePlaintextKeys(plan.plannedFiles).length > 0);
    const closing: string[] = [];
    if (workspace === null) {
      const plan = plans[0]!;
      const script = scriptToRun(
        plan.run.detected.packageJson!,
        plan.packageWiring.rewrites.map((rewrite) => rewrite.name),
      );
      closing.push(`${plan.run.scope} is ready. Run ${plan.run.detected.packageManager} run ${script} as usual.`);
    } else {
      for (const plan of plans) {
        const wired = plan.packageWiring.rewrites.map((rewrite) => rewrite.name);
        closing.push(
          `${plan.run.label}: ${plan.run.scope} is ready` +
            (wired.length > 0 ? `, with ${wired.join(", ")} wired.` : "."),
        );
      }
      closing.push(`Run your scripts as usual, in each package or from the root.`);
    }
    closing.push(`${cliName()} doctor checks the setup any time.`);
    if (!anyPlaintextLeft) {
      closing.push("Your .env files hold only references now, so they're safe to commit.");
    } else if (movable) {
      closing.push(movePointer());
    }
    note(closing.join("\n"), "Next steps");
    return 0;
  } finally {
    ctx?.vault.close();
  }
}

/** A package whose files and scripts need no change: register it and say so. */
function reportNothingToDo(plan: PackagePlan, vault: Vault | null): void {
  const { run, decisions } = plan;
  const at = (text: string) => labelled(run.label, text);
  // Values a teammate just typed are the whole point of this run, and there
  // is no plan to approve, so the typing was the approval.
  if (vault) {
    vault.registerProject(run.scope, canonicalRoot(run.detected.root), run.detected.packageName);
    storeSupplied(vault, plan.supplied);
    for (const { ref } of plan.supplied) ok(at(`Stored ${formatReference(ref.scope, ref.key)}`));
  }
  // "Already migrated" is a claim about the FILE. A project where keys were
  // kept in plaintext on purpose also has nothing to change, and telling
  // that user every value is a reference would be false about the one thing
  // they came here to check. Keys are NAMED; values still never are.
  const kept = decisions.filter((d) => d.target === "plaintext").map((d) => d.key.key);
  const untouched = [
    ...new Set(run.loaded.flatMap((entry) => entry.file.unsupported.map((u) => untouchedLabel(entry.info.name, u)))),
  ];

  if (kept.length + untouched.length > 0) {
    const clauses: string[] = [];
    if (kept.length > 0) {
      clauses.push(
        `${kept.length} ${kept.length === 1 ? "key stays" : "keys stay"} in plaintext by ` + `your choice: ${kept.join(", ")}`,
      );
    }
    if (untouched.length > 0) {
      clauses.push(
        `${untouched.length} ${untouched.length === 1 ? "key is" : "keys are"} in plaintext ` +
          `Kerstel cannot rewrite: ${untouched.join(", ")}`,
      );
    }
    info(at(`Nothing to change: ${plan.wiredClaim}; ${clauses.join("; ")}.`));
    if (kept.length > 0) info(movePointer());
    return;
  }

  ok(at(`Already migrated: every value in ${run.fileNames.join(", ")} is a reference, and ${plan.wiredClaim}.`));
  info(movePointer());
}

/**
 * Apply one package: backup, store, rewrite, launcher, package.json, its own
 * .gitignore, then the self-check. 0 when it is set up, 1 when the self-check
 * failed after the migration landed.
 */
async function applyPackage(plan: PackagePlan, gitignore: GitignoreChange | null, ctx: CliContext): Promise<number> {
  const { run, decisions, envChanges, packageWiring, launcher } = plan;
  const { vault } = ctx;
  const at = (text: string) => labelled(run.label, text);

  if (plan.nothingToDo && !gitignore) {
    vault.registerProject(run.scope, canonicalRoot(run.detected.root), run.detected.packageName);
    storeSupplied(vault, plan.supplied);
    if (plan.supplied.length > 0) ok(at(`Stored ${plan.supplied.length} value${plan.supplied.length === 1 ? "" : "s"}.`));
    else ok(at(`Nothing to change: ${plan.wiredClaim}.`));
    return 0;
  }

  // --- Apply: backup, then store, then rewrite --------------------------------
  const backup = await withSpinner(
    at("Backing up your originals"),
    (result) => at(`Encrypted backup of your originals: ${result.dir}`),
    async () => {
      // The key the vault is already open with. Fetching it again from the
      // credential store, as this once did, was a second subprocess pipe
      // carrying the key and, on Linux, a second chance for a failing bus to
      // read as "no key stored" (see CliContext.dataKey).
      // Checkouts spec §6.3: whichever value loses a keep/use question is
      // saved in the backup's vault section (move spec §5.1), so uninstall
      // names it rather than deleting its only copy unseen.
      const losers: BackupVaultValue[] = [];
      for (const decision of decisions) {
        if (decision.vaultEntry !== "differs") continue;
        const ref = { scope: decision.target === "global" ? GLOBAL_SCOPE : run.scope, key: decision.key.key };
        const value = decision.keepVault ? decision.key.value : vault.getSecret(ref);
        if (value !== null) losers.push({ ...ref, value });
      }
      return createBackup({
        scope: run.scope,
        dataKey: ctx.dataKey,
        files: run.loaded.map((entry) => ({ name: entry.info.name, contents: entry.original })),
        vault: losers,
      });
    },
  );

  // Checkouts spec §6.3: a key whose vault value stays becomes a reference but is not stored.
  const toStore = decisions.filter((decision) => decision.target !== "plaintext" && !decision.keepVault);
  const storedCount = plan.supplied.length + toStore.length;
  await withSpinner(
    at("Storing values in the vault"),
    at(
      storedCount > 0
        ? `Stored ${storedCount} secret${storedCount === 1 ? "" : "s"} in the vault.`
        : `Registered ${run.scope} with the vault.`,
    ),
    async () => {
      vault.registerProject(run.scope, canonicalRoot(run.detected.root), run.detected.packageName);
      storeSupplied(vault, plan.supplied);
      for (const decision of toStore) {
        vault.setSecret(
          { scope: decision.target === "global" ? GLOBAL_SCOPE : run.scope, key: decision.key.key },
          decision.key.value,
        );
      }
    },
  );

  if (envChanges.length > 0) {
    await withSpinner(
      at("Rewriting your env files"),
      `Rewrote ${envChanges.map((c) => c.label).join(", ")} with references.`,
      async () => {
        for (const change of envChanges) writeFileSync(change.path, change.after);
      },
    );
  }

  if (launcher) {
    await withSpinner(
      at(`Writing ${LAUNCHER_RELATIVE_PATH}`),
      at(
        launcher.before === null
          ? `Wrote ${LAUNCHER_RELATIVE_PATH}, the launcher your scripts run through. Commit it.`
          : `Rewrote ${LAUNCHER_RELATIVE_PATH}, the launcher your scripts run through.`,
      ),
      async () => {
        mkdirSync(dirname(launcher.path), { recursive: true });
        writeFileSync(launcher.path, launcher.after);
      },
    );
  }

  if (packageWiring.changed) {
    const n = packageWiring.rewrites.length;
    await withSpinner(
      at("Wiring package.json"),
      at(`Wired ${n} package.json script${n === 1 ? "" : "s"} through the Kerstel launcher.`),
      async () => writeFileSync(run.detected.packageJsonPath, packageWiring.contents),
    );
  }

  if (gitignore) {
    await withSpinner(at("Updating .gitignore"), at("Updated .gitignore"), async () =>
      writeFileSync(gitignore.path, gitignore.after),
    );
  }

  // --- Self-check ---------------------------------------------------------------
  // Any vault-bound key will do, stored now or kept: `expected` is read from the vault.
  const probeDecision = decisions.find((decision) => decision.target !== "plaintext");
  if (!probeDecision) return 0;
  const probeScope = probeDecision.target === "global" ? GLOBAL_SCOPE : run.scope;
  const expected = vault.getSecret({ scope: probeScope, key: probeDecision.key.key });
  if (expected === null) return 0;

  let result: SelfCheckResult;
  try {
    result = await withSpinner(
      at("Checking that a wired process can read the vault"),
      at("Self-check passed: a wired process resolved a reference."),
      async () => {
        const outcome = await selfCheck(
          run.detected,
          {
            key: probeDecision.key.key,
            // The form init writes, so the probe exercises the hook's
            // shorthand: the key comes from the variable's name.
            reference: formatEnvReference(probeDecision.key.key, probeScope, probeDecision.key.key),
            expected,
          },
          // Written above when it was not current, so wired means current now.
          plan.anyWired,
        );
        if (outcome.status !== "passed") throw new SelfCheckProblem(outcome);
        return outcome;
      },
    );
  } catch (error) {
    if (!(error instanceof SelfCheckProblem)) throw error;
    result = error.result;
    // In a terminal the spinner has already shown the message.
    if (!interactive()) {
      if (result.status === "failed") fail(at(result.message));
      else console.log(yellow(`!  ${at(result.message)}`));
    }
  }

  if (result.status === "failed") {
    if (result.stderr.length > 0) console.log(dim(result.stderr));
    const [summary, ...notes] = summaryLines({
      scope: run.scope,
      packageManager: run.detected.packageManager,
      backupDir: backup.dir,
      verified: false,
    });
    console.log("");
    ok(summary as string);
    for (const line of notes) console.log(yellow(`!  ${line}`));
    return 1;
  }
  return 0;
}

export async function runInit(options: InitOptions, prompter: Prompter): Promise<number> {
  try {
    return await runInitSteps(options, prompter);
  } catch (error) {
    if (error instanceof CancelledError) {
      fail(error.message);
      return 130;
    }
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
  return new ClackPrompter();
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
      `${cliName()} init asks questions, and this is not a terminal. Re-run with --yes to accept every ` +
        "suggestion, or --non-interactive to fail loudly on anything it cannot decide.",
    );
    return 2;
  }

  return runInit(parsed, prompter);
}
