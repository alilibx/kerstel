import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, kerstelHome } from "../../paths";
import type { KeychainBackend } from "./types";

function keyFile(): string {
  return join(kerstelHome(), "vault.key");
}

/**
 * Last-resort backend: the data key sits in a 0600 file inside the 0700 home.
 * Weaker than an OS credential store, so callers warn when this is selected
 * implicitly. Never selected silently over a working native backend.
 */
export const fileBackend: KeychainBackend = {
  name: "file",

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async get(): Promise<Buffer | null> {
    const file = keyFile();
    if (!existsSync(file)) return null;
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    return key.length === 32 ? key : null;
  },

  async set(key: Buffer): Promise<void> {
    ensureHome();
    writeFileSync(keyFile(), key.toString("base64"), { encoding: "utf8", mode: 0o600 });
  },

  async delete(): Promise<void> {
    rmSync(keyFile(), { force: true });
  },
};
