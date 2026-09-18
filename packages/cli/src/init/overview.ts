import { dim, yellow } from "../output";
import { renderTable } from "../ui/table";
import type { Suggestion } from "./classify";

export interface OverviewRow {
  key: string;
  value: string;
  source: string;
  conflicts: string[];
  target: Suggestion;
  /**
   * May the value be printed in full? The caller decides, and only for a
   * config value that stays in the file on the suggester's own say-so:
   * see `valueColumn`.
   */
  showValue: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What the overview and the one-by-one prompt show for a value: its length
 * and nothing else, unless `showValue` says it is a config value (plaintext,
 * suggested plaintext, and not kept by `--keep`, which can keep a real secret
 * in the file and would print it into CI logs under `--yes`). Spec §5.1 step 2.
 */
export function valueColumn(value: string, showValue: boolean): string {
  return showValue ? value : `•••• ${value.length} chars`;
}

/** Spec §5.1 step 2. */
export function renderOverview(rows: OverviewRow[], scope: string, fileNames: string[]): string[] {
  const groups: [Suggestion, string][] = [
    ["project", `Vault, for ${scope} only`],
    ["global", "Vault, shared by all your projects"],
    ["plaintext", `Stays in ${fileNames.join(", ")} as plain text`],
  ];
  const lines: string[] = [];
  for (const [target, title] of groups) {
    const members = rows.filter((row) => row.target === target);
    if (members.length === 0) continue;
    lines.push(`${title} (${members.length})`);
    lines.push(
      ...renderTable(
        members.map((row) => [row.key, valueColumn(row.value, row.showValue), dim(row.source)]),
        { indent: 2 },
      ),
    );
  }
  for (const row of rows.filter((r) => r.conflicts.length > 0)) {
    lines.push("");
    lines.push(
      yellow(`! ${row.key} has different values in ${[row.source, ...row.conflicts].join(" and ")};`),
      yellow(`  the ${row.source} one wins, and the others are kept in the encrypted backup.`),
    );
  }
  return lines;
}

/** Spec §5.1 step 5. */
export function renderChangeSummary(
  changes: { label: string; kind: "env" | "package" | "gitignore"; count: number }[],
): string[] {
  return changes.map(({ label, kind, count }) => {
    if (kind === "env") return `${label}: ${plural(count, "value becomes a reference", "values become references")}`;
    if (kind === "package") return `${label}: ${plural(count, "script goes through Kerstel", "scripts go through Kerstel")}`;
    return `${label}: ${plural(count, "line hiding .env files is removed", "lines hiding .env files are removed")}`;
  });
}
