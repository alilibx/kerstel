import { generateDataKey } from "../crypto";
import { fileBackend } from "./file";
import { linuxBackend } from "./linux";
import { macosBackend } from "./macos";
import type { KeychainBackend } from "./types";
import { windowsBackend } from "./windows";

export { ACCOUNT_NAME, SERVICE_NAME, type KeychainBackend } from "./types";

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

export async function loadOrCreateDataKey(): Promise<DataKeyResult> {
  const backend = await selectBackend();
  const existing = await backend.get();
  if (existing) return { key: existing, backend: backend.name, created: false };

  const key = generateDataKey();
  await backend.set(key);
  return { key, backend: backend.name, created: true };
}
