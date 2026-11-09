import { mask } from "../../output";
import type { SecretRow } from "../data";
import type { Row } from "../widgets/list";

/** The Secrets screen's rows: reference, the fixed-width mask, and the last update. Spec §4.4. */

function when(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const SECRETS_HEADER = ["Reference", "Value", "Updated"];

export function secretRows(secrets: SecretRow[]): Row[] {
  // mask() never hints at a value's length, so neither does this column.
  return secrets.map((s) => ({ cells: [s.reference, mask(), when(s.updatedAt)], tone: "normal", reference: s.reference }));
}
