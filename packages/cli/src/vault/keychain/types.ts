/**
 * Read fresh on every call, mirroring `paths.ts`'s `kerstelHome()`, so tests
 * can rebind it via `KERSTEL_KEYCHAIN_SERVICE` without touching the real,
 * machine-global Keychain item that a developer's live vault depends on.
 */
export function serviceName(): string {
  const override = process.env.KERSTEL_KEYCHAIN_SERVICE;
  if (override && override.length > 0) return override;
  return "dev.kerstel.vault";
}
export const ACCOUNT_NAME = "kerstel";

export interface SetOptions {
  /**
   * Allow replacing an item that already exists. Default false: `set()` refuses
   * to overwrite, because the stored item is the only copy of the vault's data
   * key and replacing it makes every existing secret permanently unreadable.
   * Reserved for an explicit `kerstel key rotate`; nothing else may pass true.
   */
  rotate?: boolean;
}

export interface KeychainBackend {
  /** Stable identifier reported by `kerstel doctor`. */
  name: string;
  /** True when this backend's platform tooling is present and working. */
  isAvailable(): Promise<boolean>;
  /** Returns the stored 32-byte data key, or null when nothing is stored. */
  get(): Promise<Buffer | null>;
  /**
   * True when an item is stored, decided WITHOUT reading its secret.
   *
   * This is deliberately not `get() !== null`. On macOS the two answers differ
   * in exactly the case that matters: a user who clicked "Deny" on the Keychain
   * prompt has an item that exists but whose data cannot be read, so `get()`
   * returns null while an item is very much stored. Callers use this to tell
   * "nothing here yet, safe to create" from "something is here that I cannot
   * read, do not touch it".
   *
   * When a backend cannot tell, it answers true: the safe direction is to
   * refuse to create, never to overwrite on a guess.
   */
  exists(): Promise<boolean>;
  set(key: Buffer, options?: SetOptions): Promise<void>;
  delete(): Promise<void>;
}
