import { judge } from "../init/classify";
import type { AppReadGroup, AuditAction, AuditCounts, AuditRow, Vault } from "../vault/store";

export const ROTATE_HINT = "If you didn't reveal this yourself, consider rotating it.";

export interface AuditQuery {
  scope?: string;
  key?: string;
  action?: AuditAction;
  since: number;
  limit: number;
}

export interface RevealLine {
  row: AuditRow;
  rotate: boolean;
}

export interface AuditReport {
  counts: AuditCounts;
  reveals: RevealLine[];
  /** Used unless the action is resolve or run. */
  appReads: AppReadGroup[];
  /** Used when the action is resolve or run. */
  appReadRows: AuditRow[];
  changes: AuditRow[];
}

const CHANGE_ACTIONS: AuditAction[] = ["set", "remove", "sync", "device"];

/**
 * True only for a reveal of a credential that still exists and has not changed
 * since: the revealed value is then still the live one. Nothing is decrypted
 * for a secret that is gone or was replaced.
 */
export function shouldRotate(vault: Vault, row: AuditRow): boolean {
  if (row.event !== "reveal") return false;
  const stored = vault.listSecrets(row.scope).find((s) => s.scope === row.scope && s.key === row.key);
  if (!stored || stored.updatedAt > row.ts) return false;
  try {
    const value = vault.getSecret({ scope: row.scope, key: row.key });
    return value !== null && judge(row.key, value) === "secret";
  } catch {
    // A record that will not decrypt must not take the whole audit view down.
    return false;
  }
}

export function auditReport(vault: Vault, query: AuditQuery): AuditReport {
  const base = { scope: query.scope, key: query.key, since: query.since };
  const only = (events: AuditAction[]) => (query.action === undefined ? events : events.filter((e) => e === query.action));
  const revealEvents = only(["reveal"]);
  const readEvents = only(["resolve", "run"]);
  const changeEvents = only(CHANGE_ACTIONS);
  const filterEvents = query.action === undefined ? undefined : [query.action];

  const counts = vault.auditCounts({ ...base, events: filterEvents });
  const rows = (events: AuditAction[]) =>
    events.length === 0 ? [] : vault.listAudit({ ...base, events, limit: query.limit });
  const rowsMode = query.action === "resolve" || query.action === "run";

  return {
    counts,
    reveals: rows(revealEvents).map((row) => ({ row, rotate: shouldRotate(vault, row) })),
    appReads: readEvents.length === 0 || rowsMode ? [] : vault.appReadGroups({ ...base, limit: query.limit }),
    appReadRows: rowsMode ? rows(readEvents) : [],
    changes: rows(changeEvents),
  };
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export function parseSince(text: string, now: number): { since: number; label: string } | null {
  const rel = /^([1-9]\d*)([dh])$/.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    if (rel[2] === "d") return { since: now - n * DAY, label: `Last ${n} ${n === 1 ? "day" : "days"}` };
    return { since: now - n * HOUR, label: `Last ${n} ${n === 1 ? "hour" : "hours"}` };
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const at = new Date(y, m - 1, d);
    if (at.getFullYear() !== y || at.getMonth() !== m - 1 || at.getDate() !== d) return null;
    return { since: at.getTime(), label: `Since ${text}` };
  }
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local time as `YYYY-MM-DD HH:MM`, the one format every audit view uses. */
export function formatAuditTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
