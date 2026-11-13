import { formatChain } from "../../audit/chain";
import { formatAuditTime, ROTATE_HINT } from "../../audit/report";
import { formatReference } from "../../reference";
import type { AuditAction } from "../../vault/store";
import type { AuditView } from "../data";
import type { Row } from "../widgets/list";

/**
 * The Audit screen: the `kerstel audit` summary, then one row per audit entry,
 * newest first, reveals marked. A row holds names and times, never a value.
 */

/** Rows added by `n`, and the first page. */
export const AUDIT_PAGE = 200;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function auditRows(view: AuditView, action: AuditAction | null): Row[] {
  const { counts } = view;
  const summary =
    `Last 7 days: ${plural(counts.reveals, "reveal", "reveals")} · ` +
    `${plural(counts.appReads, "app read", "app reads")} by ${plural(counts.processes, "process", "processes")} ` +
    `in ${plural(counts.projects, "project", "projects")} · ${plural(counts.changes, "change", "changes")}`;
  const rows: Row[] = [{ cells: [action ? `${summary} (showing ${action})` : summary], tone: "heading" }];
  for (const { row, rotate } of view.entries) {
    const keyed = row.key !== "";
    const reference = keyed ? formatReference(row.scope, row.key) : undefined;
    rows.push({
      cells: [formatAuditTime(row.ts), row.event, reference ?? "—", formatChain(row.chain)],
      tone: row.event === "reveal" ? "problem" : "normal",
      reference,
    });
    if (rotate) rows.push({ cells: ["", "", ROTATE_HINT, ""], tone: "dim" });
  }
  if (view.more) rows.push({ cells: [`n for ${AUDIT_PAGE} more`], tone: "dim" });
  return rows;
}
