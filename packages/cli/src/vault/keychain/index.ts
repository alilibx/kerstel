import { generateDataKey } from "../crypto";
import { fileBackend } from "./file";
import { linuxBackend } from "./linux";
import { macosBackend } from "./macos";
import type { KeychainBackend } from "./types";
import { windowsBackend } from "./windows";

export {
  ACCOUNT_NAME,
  SERVICE_NAME,
  type KeychainBackend,
  type SetOptions,
} from "./types";

const BY_NAME: Record<string, KeychainBackend> = {
  macos: macosBackend,
  linux: linuxBackend,
  windows: windowsBackend,
  file: fileBackend,
};

function nativeBackend(): KeychainBackend | null {
  if (process.platform === "darwin") return macosBackend;
  if (process.platform === "linux") return linuxBackend;
  if (process.platform === "win32") return windowsBackend;
  return null;
}

export async function selectBackend(): Promise<KeychainBackend> {
  const forced = process.env.KERSTEL_KEYCHAIN_BACKEND;
  if (forced) {
    const backend = BY_NAME[forced];
    if (!backend) {
      throw new Error(
        `Unknown KERSTEL_KEYCHAIN_BACKEND "${forced}". Expected one of: ${Object.keys(BY_NAME).join(", ")}`,
      );
    }
    return backend;
  }

  const native = nativeBackend();
  if (native && (await native.isAvailable())) return native;
  return fileBackend;
}

export interface DataKeyResult {
  key: Buffer;
  backend: string;
  /** True when this call generated a new key rather than reading an existing one. */
  created: boolean;
}

/**
 * @param override A backend to use instead of the auto-selected one. Present so
 * tests can drive the "stored but unreadable" path, which no real backend can
 * be put into on demand.
 */
export async function loadOrCreateDataKey(override?: KeychainBackend): Promise<DataKeyResult> {
  const backend = override ?? (await selectBackend());
  const existing = await backend.get();
  if (existing) return { key: existing, backend: backend.name, created: false };

  // A null from get() is NOT proof that nothing is stored. On macOS a user who
  // clicked "Deny" on the Keychain prompt produces exactly this: the item is
  // there, the read is refused, get() reports null. Creating a key here and
  // storing it would replace the only copy of the real one and make every
  // secret already in the vault permanently unreadable. So ask the separate
  // question -- is an item present? -- and refuse to create when the answer is
  // anything but a definite no.
  if (await backend.exists()) {
    throw new Error(
      `Kerstel could not read its vault key from the ${backend.name} credential store ` +
        "even though one is stored. On macOS, re-run and click \"Always Allow\" on the " +
        "Keychain prompt, or run `kerstel doctor`. Kerstel will never overwrite a " +
        "stored key automatically.",
    );
  }

  const key = generateDataKey();
  await backend.set(key);
  return { key, backend: backend.name, created: true };
}
