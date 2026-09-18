import { ensureToken } from "./daemon/token";
import { installHookAssets, type HookInstallResult } from "./hook-assets";
import { ensureHome, vaultPath } from "./paths";
import { loadOrCreateDataKey, selectBackend } from "./vault/keychain";
import {
  META_KEYCHAIN_BACKEND,
  META_KEY_CHECK,
  backendMismatchError,
  readVaultMeta,
  sealKeyCheck,
  verifyKeyCheck,
} from "./vault/meta";
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

  // ORDER MATTERS. vault_meta records which credential store minted the key,
  // and that has to be known BEFORE a key is fetched or created -- its whole
  // purpose is to decide whether doing so is safe. It cannot live behind the
  // key it describes, so it is read here with its own read-only handle. See
  // meta.ts.
  const meta = readVaultMeta(vaultPath());
  const recordedBackend = meta[META_KEYCHAIN_BACKEND];

  const backend = await selectBackend();

  // The split-brain guard. On macOS over SSH with a locked login keychain the
  // native backend reports unavailable, selection falls through to the file
  // backend, which has no key, and the next step would mint a second one --
  // leaving every existing secret undecryptable in this session and everything
  // written here undecryptable in a GUI one. Refuse before that happens.
  if (recordedBackend && recordedBackend !== backend.name) {
    throw backendMismatchError(recordedBackend, backend.name);
  }

  const { key, created } = await loadOrCreateDataKey(backend);
  const vault = openVault(key);

  try {
    const storedCheck = meta[META_KEY_CHECK];
    if (storedCheck) {
      // Catch a wrong key here, on a value that exists precisely to be a
      // canary, rather than on whichever secret the user happened to ask for.
      if (!verifyKeyCheck(storedCheck, key)) {
        throw new Error(
          "Kerstel's vault key does not match the vault: the stored check value " +
            "could not be decrypted. The key in " +
            `the "${backend.name}" credential store is not the one this vault was ` +
            "encrypted with. Refusing to continue -- run `kerstel doctor`.",
        );
      }
    } else if (created && vault.listSecrets().length > 0) {
      // A brand-new key cannot possibly decrypt secrets that were already
      // here. This is the same split-brain as above, reached by a vault that
      // predates vault_meta and so had nothing to compare backends against.
      throw backendMismatchError("another", backend.name);
    } else {
      // Nothing recorded yet: a fresh vault, or a v1 vault on its first open
      // after upgrading. Record the baseline so every later open is checked.
      vault.setMeta(META_KEYCHAIN_BACKEND, backend.name);
      vault.setMeta(META_KEY_CHECK, sealKeyCheck(key));
    }

    return {
      vault,
      backend: backend.name,
      token: ensureToken(),
      firstRun: created,
      hookDir: hookInstall.dir,
      hookInstall,
    };
  } catch (error) {
    // Every command that opens the vault closes it on every path. A throw here
    // escapes before the caller ever receives the context, so the close is
    // this function's responsibility.
    vault.close();
    throw error;
  }
}
