import { ensureToken } from "./daemon/token";
import { installHookAssets, type HookInstallResult } from "./hook-assets";
import { ensureHome } from "./paths";
import { loadOrCreateDataKey } from "./vault/keychain";
import { openVault, type Vault } from "./vault/store";

export interface CliContext {
  vault: Vault;
  backend: string;
  token: string;
  /** True when this call created the vault key for the first time. */
  firstRun: boolean;
  /** Directory the runtime hook was installed into. */
  hookDir: string;
  /** Outcome of that install. A failure here is reported, not fatal. */
  hookInstall: HookInstallResult;
}

/** Opens the vault for a one-shot CLI command. Callers must close it. */
export async function openContext(): Promise<CliContext> {
  ensureHome();
  // Every vault-opening command refreshes the hook, so a fresh install or a
  // binary upgrade puts the right preload on disk without a separate step.
  // It is cheap: the files are compared and only rewritten when they differ.
  // It also cannot fail the command: the hook is optional, the vault is not,
  // so a write error is carried on the context for `doctor` to report.
  const hookInstall = installHookAssets();
  const { key, backend, created } = await loadOrCreateDataKey();
  return {
    vault: openVault(key),
    backend,
    token: ensureToken(),
    firstRun: created,
    hookDir: hookInstall.dir,
    hookInstall,
  };
}
