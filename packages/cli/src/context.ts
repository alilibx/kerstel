import { ensureToken } from "./daemon/token";
import { ensureHome } from "./paths";
import { loadOrCreateDataKey } from "./vault/keychain";
import { openVault, type Vault } from "./vault/store";

export interface CliContext {
  vault: Vault;
  backend: string;
  token: string;
  /** True when this call created the vault key for the first time. */
  firstRun: boolean;
}

/** Opens the vault for a one-shot CLI command. Callers must close it. */
export async function openContext(): Promise<CliContext> {
  ensureHome();
  const { key, backend, created } = await loadOrCreateDataKey();
  return { vault: openVault(key), backend, token: ensureToken(), firstRun: created };
}
