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

/**
 * `revealed` is the one value `r` decrypted, shown in place of the dots on its
 * own row. Everywhere else the column is `mask()`, which never hints at a
 * value's length.
 */
export function secretRows(secrets: SecretRow[], revealed: { reference: string; value: string } | null = null): Row[] {
  return secrets.map((s) => ({
    cells: [s.reference, revealed?.reference === s.reference ? revealed.value : mask(), when(s.updatedAt)],
    tone: "normal",
    reference: s.reference,
  }));
}
