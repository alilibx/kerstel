import { formatChain } from "../audit/chain";
import { AUDIT_ACTIONS, type AuditAction, type AuditRow } from "../vault/store";
import { auditReport, formatAuditTime, parseSince, ROTATE_HINT } from "../audit/report";
import { openContext } from "../context";
import { fail } from "../output";
import { formatReference } from "../reference";
import { cliName } from "../ui/cli-name";
import { renderTable } from "../ui/table";
import { theme } from "../ui/theme";

/**
 * `kerstel audit`: what Kerstel did with your secrets on this device.
 * Reveals first, with a rotation hint; then app reads; then changes.
 * Never prints a value.
 */

const USAGE = `Usage: ${cliName()} audit [--scope <s>] [--key <KEY>] [--action <a>] [--since <7d|24h|date>] [--limit <n>]`;
const DEFAULT_LIMIT = 50;

interface AuditOptions {
  scope?: string;
  key?: string;
  action?: AuditAction;
  since: string;
  limit: number;
}

function parseArgs(args: string[]): AuditOptions | { error: string } {
  const options: AuditOptions = { since: "7d", limit: DEFAULT_LIMIT };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!["--scope", "--key", "--action", "--since", "--limit"].includes(flag)) {
      return { error: `Unknown option ${flag}. ${USAGE}` };
    }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value. ${USAGE}` };
    if (flag === "--scope") options.scope = value;
    else if (flag === "--key") options.key = value;
    else if (flag === "--since") options.since = value;
    else if (flag === "--action") {
      if (!(AUDIT_ACTIONS as readonly string[]).includes(value)) {
        return { error: `Unknown action "${value}". Use one of: ${AUDIT_ACTIONS.join(", ")}.` };
      }
      options.action = value as AuditAction;
    } else {
      if (!/^[1-9]\d*$/.test(value)) return { error: `--limit takes a positive whole number, not "${value}".` };
      options.limit = Number(value);
    }
  }
  return options;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const reference = (row: AuditRow) => (row.key === "" ? "—" : formatReference(row.scope, row.key));

export async function auditCommand(args: string[]): Promise<number> {
  const options = parseArgs(args);
  if ("error" in options) {
    fail(options.error);
    return 2;
  }
  const now = Date.now();
  const since = parseSince(options.since, now);
  if (since === null) {
    fail(`--since takes a number of days or hours (7d, 24h) or a date (2026-11-01), not "${options.since}".`);
    return 2;
  }

  const ctx = await openContext();
  try {
    const report = auditReport(ctx.vault, {
      scope: options.scope,
      key: options.key,
      action: options.action,
      since: since.since,
      limit: options.limit,
    });
    const { counts } = report;
    if (counts.reveals + counts.appReads + counts.changes === 0) {
      console.log(
        since.label.startsWith("Since ")
          ? `Nothing recorded since ${since.label.slice(6)}.`
          : `Nothing recorded in the ${since.label.charAt(0).toLowerCase()}${since.label.slice(1)}.`,
      );
      return 0;
    }

    const out: string[] = [since.label];
    out.push(
      ...renderTable(
        [
          ["Reveals", String(counts.reveals)],
          [
            "App reads",
            `${counts.appReads} by ${plural(counts.processes, "process", "processes")} in ${plural(counts.projects, "project", "projects")}`,
          ],
          ["Changes", String(counts.changes)],
        ],
        { indent: 2, gap: 3 },
      ),
    );

    if (report.reveals.length > 0) {
      const rows = report.reveals.map(({ row }) => [formatAuditTime(row.ts), reference(row), formatChain(row.chain)]);
      const lines = renderTable(rows, { indent: 2 });
      const hintIndent = " ".repeat(2 + formatAuditTime(0).length + 2);
      out.push("", "Reveals");
      report.reveals.forEach(({ rotate }, i) => {
        out.push(theme.yellow(lines[i]!));
        if (rotate) out.push(hintIndent + theme.dim(ROTATE_HINT));
      });
    }

    if (report.appReadRows.length > 0) {
      out.push("", "App reads");
      out.push(
        ...renderTable(
          report.appReadRows.map((row) => [
            formatAuditTime(row.ts),
            row.event,
            reference(row),
            row.processName ?? "unknown",
            formatChain(row.chain),
          ]),
          { indent: 2 },
        ),
      );
    } else if (report.appReads.length > 0) {
      out.push("", "App reads");
      out.push(
        ...renderTable(
          report.appReads.map((g) => [
            g.project ?? "outside a project",
            g.process,
            g.keys.join(", "),
            plural(g.processes, "process", "processes"),
          ]),
          { indent: 2 },
        ),
      );
    }

    if (report.changes.length > 0) {
      out.push("", "Changes");
      out.push(
        ...renderTable(
          report.changes.map((row) => [formatAuditTime(row.ts), row.event, reference(row), formatChain(row.chain)]),
          { indent: 2 },
        ),
      );
    }

    for (const line of out) console.log(line);
    return 0;
  } finally {
    ctx.vault.close();
  }
}
