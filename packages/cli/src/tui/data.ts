import { scanProjectRefs, type ProjectRefs } from "../project-refs";
import { formatReference } from "../reference";
import type { Vault } from "../vault/store";

/**
 * What the UI reads from the vault. Terminal UI spec §4.2: the only module
 * that touches `Vault`, and so the only place a value could be decrypted. This
 * release decrypts nothing: the Secrets screen shows a fixed mask.
 */

export interface SecretRow {
  scope: string;
  key: string;
  /** `ks:<scope>/<KEY>`. */
  reference: string;
  updatedAt: number;
}

export interface Loaded {
  secrets: SecretRow[];
  refs: ProjectRefs;
}

export interface UiData {
  load(): Loaded;
}

/** `global` first, then each project scope alphabetically, then keys. Spec §4.4. */
export function sortSecrets(rows: SecretRow[]): SecretRow[] {
  const rank = (scope: string) => (scope === "global" ? 0 : 1);
  return [...rows].sort(
    (a, b) =>
      rank(a.scope) - rank(b.scope) ||
      (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

export function vaultData(vault: Vault): UiData {
  return {
    load() {
      const summaries = vault.listSecrets();
      const secrets = sortSecrets(
        summaries.map((s) => ({
          scope: s.scope,
          key: s.key,
          reference: formatReference(s.scope, s.key),
          updatedAt: s.updatedAt,
        })),
      );
      const refs = scanProjectRefs(vault.listProjects(), new Set(summaries.map((s) => `${s.scope}/${s.key}`)));
      return { secrets, refs };
    },
  };
}
