import { existsSync, realpathSync } from "node:fs";
import { openContext } from "../context";
import { DESTINATION_CHOICES, isSafeToDisplay } from "../init/classify";
import { loadEnvFiles } from "../init/collect";
import { detectProject } from "../init/detect";
import { deriveScope } from "../init/project-name";
import { CancelledError, ClackPrompter, type Choice, type Prompter } from "../init/prompts";
import { MoveApplyError, MoveStaleFileError, applyMove, removeStaleTemps } from "../move/apply";
import { gitFileStatus } from "../move/git";
import { planMove, refId, type ConflictChoice, type MovePlan, type MoveRequest } from "../move/plan";
import { PLACE_LABELS, resolveProjectScope, scanRows, type Place, type ScannedRow } from "../move/scan";
import { GLOBAL_SCOPE } from "../reference";
import { dim, fail, info, ok, yellow } from "../output";
import { cliName } from "../ui/cli-name";

/** Spec: docs/superpowers/specs/2026-09-24-move-keys-between-vault-and-plaintext-design.md */

const PLACES: readonly Place[] = ["global", "project", "plaintext"];

export interface MoveOptions {
  cwd: string;
  keys: string[];
  to: Place | null;
  yes: boolean;
  replace: boolean;
  allowTracked: boolean;
}

export function parseMoveArgs(args: string[], cwd: string): MoveOptions | { error: string } {
  const options: MoveOptions = { cwd, keys: [], to: null, yes: false, replace: false, allowTracked: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--yes") options.yes = true;
    else if (arg === "--replace") options.replace = true;
    else if (arg === "--allow-tracked") options.allowTracked = true;
    else if (arg === "--to") {
      const value = args[++i];
      if (!value || !PLACES.includes(value as Place)) return { error: "--to takes global, project or plaintext." };
      options.to = value as Place;
    } else if (arg.startsWith("-")) {
      return {
        error: `Unknown option "${arg}". ${cliName()} move accepts: KEY..., --to global|project|plaintext, --yes, --replace, --allow-tracked.`,
      };
    } else options.keys.push(arg);
  }
  if (options.to !== null && options.keys.length === 0) return { error: "--to needs the keys to move." };
  return options;
}

/** realpathSync, but a root another checkout recorded may no longer exist on disk. */
function safeRealpath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function noTerminalMessage(): string {
  return (
    `${cliName()} move asks questions, and this is not a terminal. Name the keys and --to, ` +
    `for example: ${cliName()} move STRIPE_KEY --to global --yes`
  );
}

function destinationLabel(place: Place, scope: string): string {
  return DESTINATION_CHOICES(scope).find((choice) => choice.value === place)!.label;
}

/**
 * A key can have two rows in one place (`.env.local` reading `app/K_LOCAL`,
 * `.env` reading `app/K`); `ambiguous` adds the reference so the two differ.
 */
function rowHint(row: ScannedRow, ambiguous: boolean): string {
  if (row.ref) return ambiguous ? `${PLACE_LABELS[row.place]}  ${refId(row.ref)}` : PLACE_LABELS[row.place];
  if (row.value === null) return PLACE_LABELS[row.place];
  const shown = isSafeToDisplay(row.key, row.value) ? row.value : `(${row.value.length} chars)`;
  return `${PLACE_LABELS[row.place]}  ${shown}`;
}

/** Spec §4. Lengths only: never a value. */
export function renderPreview(plan: MovePlan, scope: string): string[] {
  const lines: string[] = [];
  for (const move of plan.moves) {
    const from = move.fromRef ? refId(move.fromRef) : `plain text (${move.length} chars)`;
    const to = move.toRef ? refId(move.toRef) : `plain text (${move.length} chars)`;
    lines.push(`  ${move.key} → ${destinationLabel(move.to, scope)}`);
    lines.push(`    ${move.files.join(", ")}:  ${from}  →  ${to}`);
    if (move.toRef && move.outcome === "kept") {
      lines.push(`    ${refId(move.toRef)} keeps its value; these files use it from now on`);
    }
    if (move.toRef && move.outcome === "replaced") {
      lines.push(`    ${refId(move.toRef)} is replaced; its old value is saved in the backup`);
    }
    const fromId = move.fromRef ? refId(move.fromRef) : null;
    for (const d of plan.deletions.filter((d) => refId(d.ref) === fromId)) {
      lines.push(`    ${refId(d.ref)} is removed from the vault (nothing else here uses it)`);
    }
    for (const k of plan.kept.filter((k) => refId(k.ref) === fromId)) {
      lines.push(
        k.reason === "referenced"
          ? `    ${refId(k.ref)} is kept: another file here still uses it.`
          : `    ${refId(k.ref)} is kept: ${k.ref.scope} was set up in ${k.root}, which may still use it.`,
      );
    }
  }
  for (const w of plan.mergeWarnings) {
    lines.push(
      yellow(`! ${w.key} has different values in ${[w.used, ...w.others].join(" and ")};`),
      yellow(`  the ${w.used} one wins, and the others are kept in the encrypted backup.`),
    );
  }
  for (const w of plan.gitWarnings) {
    lines.push(
      yellow(
        w.status === "tracked"
          ? `!  ${w.file} is tracked by git; ${w.key}'s value would be committed.`
          : `!  ${w.file} is not in .gitignore; ${w.key}'s value could be committed.`,
      ),
    );
  }
  return lines;
}

function conflictChoices(ref: string, isGlobal: boolean): Choice<ConflictChoice>[] {
  return isGlobal
    ? [
        { value: "keep", label: "Keep the shared value; this project uses it from now on" },
        {
          value: "replace",
          label: "Replace it with this project's value (every project using the shared key changes too)",
        },
      ]
    : [
        { value: "keep", label: "Keep the vault's value; these files use it from now on" },
        { value: "replace", label: `Replace it with the value being moved (anything else reading ${ref} changes too)` },
      ];
}

export async function runMove(options: MoveOptions, prompter: Prompter | null): Promise<number> {
  const direct = options.to !== null;
  if (!prompter && !direct) {
    fail(noTerminalMessage());
    return 2;
  }

  // realpathSync: on macOS the working directory (and the test runner's own
  // tmpdir) is reached through a symlink (/tmp -> /private/tmp, and likewise
  // for /var/folders). A bare string compare against the vault's recorded
  // root -- itself resolved the same way when it was registered -- would
  // false-negative "another checkout" for the SAME checkout reached through
  // the link. Same fix as uninstall.ts's removeLinks, and for the same reason.
  const detected = detectProject(safeRealpath(options.cwd));
  removeStaleTemps(detected.root);
  if (detected.envFiles.length === 0) {
    // Spec §2.2: a named key the scan can't find is reported and skipped, per
    // key; with nothing left to move that is a failure, not a no-op.
    if (options.keys.length > 0) {
      for (const key of options.keys) fail(`${key} is not in any .env file; skipped.`);
      return 1;
    }
    info(`No .env files in ${detected.root}. Nothing to move.`);
    return 0;
  }
  const loaded = loadEnvFiles(detected.envFiles);
  const fileNames = detected.envFiles.map((f) => f.name).join(", ");

  const ctx = await openContext();
  try {
    const vault = ctx.vault;
    // The scope `init` registered for this root is the best witness: with
    // only plain values in the files, the files cannot say it was `--scope
    // custom`. Without a record, the files' own references, then the name.
    const scope =
      vault.listProjects().find((p) => safeRealpath(p.rootPath) === detected.root)?.name ??
      resolveProjectScope(loaded, deriveScope({ packageName: detected.packageName, rootPath: detected.root }).scope);
    const { rows, foreign } = scanRows(loaded, scope);
    for (const f of foreign) {
      info(`${f.key} in ${f.files.join(", ")} reads ${f.reference}, another project's scope; it is not offered.`);
    }

    // Spec §4.3 "named, not offered": a vault row (project or global) whose
    // reference the vault doesn't actually hold must not reach the key menu
    // or be asked a destination. Reported once, here, before either.
    const missingRefIds = new Set<string>();
    for (const row of rows) {
      if (row.ref && vault.getSecret(row.ref) === null) {
        missingRefIds.add(row.id);
        fail(`${row.key}: ${refId(row.ref)} is not in the vault. Run ${cliName()} init to store it first.`);
      }
    }
    const offerable = rows.filter((row) => !missingRefIds.has(row.id));

    // --- Which rows ----------------------------------------------------------
    let picked: ScannedRow[];
    if (options.keys.length === 0) {
      if (offerable.length === 0) {
        info("Nothing to move.");
        return 0;
      }
      const distinctKeys = new Set(offerable.map((row) => row.key)).size;
      console.log(`  ${scope}: ${distinctKeys} variables in ${fileNames}`);
      const ids = await prompter!.multiselect(
        "Which keys?",
        offerable.map((row) => ({
          value: row.id,
          label: row.key,
          hint: rowHint(
            row,
            offerable.some((other) => other !== row && other.key === row.key && other.place === row.place),
          ),
        })),
        [],
      );
      picked = offerable.filter((row) => ids.includes(row.id));
    } else {
      picked = [];
      for (const key of options.keys) {
        const keyRows = rows.filter((row) => row.key === key);
        if (keyRows.length === 0) {
          fail(`${key} is not in ${fileNames}; skipped.`);
          continue;
        }
        // Rows with a missing vault reference were already reported above;
        // a key with no other row is simply skipped, not reported twice.
        const available = keyRows.filter((row) => !missingRefIds.has(row.id));
        if (available.length === 0) continue;
        const movable = options.to ? available.filter((row) => row.place !== options.to) : available;
        if (movable.length === 0) {
          info(`${key} is already ${PLACE_LABELS[options.to!]}; skipped.`);
          continue;
        }
        picked.push(...movable);
      }
    }

    // --- Where to ------------------------------------------------------------
    const requests: MoveRequest[] = [];
    for (const row of picked) {
      let to = options.to;
      if (to === null) {
        const choices = DESTINATION_CHOICES(scope).filter((choice) => choice.value !== row.place);
        to = await prompter!.select(`Move ${row.key} to:`, choices, choices[0]!.value);
      }
      if (to !== row.place) requests.push({ row, to });
    }
    if (requests.length === 0) {
      if (options.keys.length > 0) return 1;
      info("Nothing picked. Nothing was changed.");
      return 0;
    }

    // --- Plan, and answer conflicts --------------------------------------------
    const storedRoot = vault.listProjects().find((p) => p.name === scope)?.rootPath ?? null;
    // Same realpath normalization as `detected.root` above, so a root
    // recorded through the symlinked form of this same directory still
    // compares equal.
    const recordedRoot = storedRoot === null ? null : safeRealpath(storedRoot);
    const choices = new Map<string, ConflictChoice>();
    const makePlan = () =>
      planMove({
        scope,
        root: detected.root,
        loaded,
        requests,
        vaultValue: (ref) => vault.getSecret(ref),
        recordedRoot,
        choices,
        gitStatus: (name) => gitFileStatus(detected.root, name),
      });
    let plan = makePlan();
    for (const s of plan.skipped) {
      fail(`${s.key}: ${refId(s.ref)} is not in the vault. Run ${cliName()} init to store it first.`);
    }
    for (const u of plan.unwritable) {
      fail(
        `${u.key}: its value cannot be written as plain text in ${u.files.join(", ")} without changing it, so it stays in the vault.`,
      );
    }
    if (plan.conflicts.length > 0) {
      for (const conflict of plan.conflicts) {
        const id = refId(conflict.ref);
        const question = `${id} already holds a different value (${conflict.existingLength} chars).`;
        if (direct) {
          if (!options.replace) {
            fail(`${question} Nothing was changed; add --replace to overwrite it (the old value is saved in the backup).`);
            return 1;
          }
          choices.set(id, "replace");
        } else {
          choices.set(
            id,
            await prompter!.select(
              `${question} Which one stays?`,
              conflictChoices(id, conflict.ref.scope === GLOBAL_SCOPE),
              "keep",
            ),
          );
        }
      }
      plan = makePlan();
    }
    if (plan.moves.length === 0) return options.keys.length > 0 ? 1 : 0;

    // --- Preview and Apply? ----------------------------------------------------------
    for (const line of renderPreview(plan, scope)) console.log(line);
    if (direct && plan.gitWarnings.length > 0 && !options.allowTracked) {
      fail("Nothing was changed; add --allow-tracked to write plain text into these files anyway.");
      return 1;
    }
    if (!options.yes) {
      if (!prompter) {
        fail("Apply needs a terminal; re-run with --yes.");
        return 2;
      }
      const answer = await prompter.select(
        "Apply?",
        [
          { value: "no", label: "No" },
          { value: "yes", label: "Yes" },
        ],
        "no",
      );
      if (answer !== "yes") {
        info("Nothing was changed.");
        return 0;
      }
    }

    // --- Apply -------------------------------------------------------------------------
    let result: ReturnType<typeof applyMove>;
    try {
      result = applyMove(plan, { vault, dataKey: ctx.dataKey, scope, root: detected.root, recordedRoot });
    } catch (error) {
      if (error instanceof MoveApplyError || error instanceof MoveStaleFileError) {
        fail(error.message);
        return 1;
      }
      throw error;
    }
    ok(`Backed up ${plan.files.map((f) => f.name).join(", ")}`);
    for (const move of plan.moves) {
      ok(
        move.toRef
          ? `${move.key} now reads ${refId(move.toRef)}`
          : `${move.key} is plain text again in ${move.files.join(", ")}`,
      );
    }
    for (const ref of result.deleted) info(`Removed ${refId(ref)} from the vault.`);
    for (const problem of result.problems) fail(problem);
    if (plan.noReferencesLeft) {
      info(`Nothing here reads the vault any more; ${cliName()} uninstall removes the wiring.`);
    }
    console.log(dim(`  Backup: ${result.backup.dir}`));
    return 0;
  } catch (error) {
    if (error instanceof CancelledError) {
      fail(error.message);
      return 130;
    }
    throw error;
  } finally {
    ctx.vault.close();
  }
}

export async function moveCommand(args: string[], prompterOverride?: Prompter | null): Promise<number> {
  const parsed = parseMoveArgs(args, process.cwd());
  if ("error" in parsed) {
    fail(parsed.error);
    return 2;
  }
  const prompter =
    prompterOverride !== undefined ? prompterOverride : process.stdin.isTTY === true ? new ClackPrompter() : null;
  return runMove(parsed, prompter);
}
