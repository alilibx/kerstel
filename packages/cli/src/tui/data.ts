import { scanProjectRefs, type ProjectRefs } from "../project-refs";
import { formatReference, type SecretRef } from "../reference";
import type { Vault } from "../vault/store";

/**
 * What the UI reads from and writes to the vault. Terminal UI spec §4.2: the
 * only module that touches `Vault`, and so the only place a value is
 * decrypted, by `reveal`, which records the reveal first.
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
  /** The value, after writing the `reveal` audit row; null when the secret is gone. */
  reveal(ref: SecretRef): string | null;
  /**
   * Stores the value and returns true, unless `replace` is false and the
   * secret exists: one created elsewhere since the list loaded is never
   * overwritten without the replace question. Then it stores nothing.
   */
  store(ref: SecretRef, value: string, replace: boolean): boolean;
  /** Whether there was a secret to remove. */
  remove(ref: SecretRef): boolean;
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
    reveal(ref) {
      if (vault.getSecret(ref) === null) return null;
      // Written before the value is read for display, as `get --reveal` does:
      // a reveal that is not recorded is one the audit log denies happened.
      vault.record("reveal", ref);
      return vault.getSecret(ref);
    },
    store(ref, value, replace) {
      // By name, without decrypting anything.
      if (!replace && vault.listSecrets(ref.scope).some((s) => s.key === ref.key)) return false;
      vault.setSecret(ref, value);
      return true;
    },
    remove(ref) {
      return vault.removeSecret(ref);
    },
  };
}
