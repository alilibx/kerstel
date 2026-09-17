export const SERVICE_NAME = "dev.kerstel.vault";
export const ACCOUNT_NAME = "kerstel";

export interface KeychainBackend {
  /** Stable identifier reported by `kerstel doctor`. */
  name: string;
  /** True when this backend's platform tooling is present and working. */
  isAvailable(): Promise<boolean>;
  /** Returns the stored 32-byte data key, or null when nothing is stored. */
  get(): Promise<Buffer | null>;
  set(key: Buffer): Promise<void>;
  delete(): Promise<void>;
}
