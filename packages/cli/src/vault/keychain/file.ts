import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, kerstelHome } from "../../paths";
import type { KeychainBackend, SetOptions } from "./types";

function keyFile(): string {
  return join(kerstelHome(), "vault.key");
}

function alreadyStored(): Error {
  return new Error(
    "A Kerstel vault key is already stored at this location. Refusing to " +
      "replace it: the stored key is the only copy, and overwriting it would make " +
      "every secret in the vault permanently unreadable.",
  );
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

  async exists(): Promise<boolean> {
    // True even for a truncated or non-base64 file, which get() reports as
    // null. That asymmetry is the point: a damaged key file is still the only
    // record of the key and must not be replaced by a fresh one.
    return existsSync(keyFile());
  },

  async set(key: Buffer, options: SetOptions = {}): Promise<void> {
    // The pre-check is kept only for the friendlier message. It cannot be what
    // enforces the rule: between this existsSync and the write below, another
    // Kerstel process racing the same first run can create the key file, and
    // this one would then overwrite the only copy of it -- the exact outcome
    // the refusal exists to prevent. The "wx" flag below is the enforcement:
    // O_EXCL makes "create only if absent" one atomic step in the kernel.
    if (!options.rotate && existsSync(keyFile())) throw alreadyStored();
    ensureHome();
    try {
      writeFileSync(keyFile(), key.toString("base64"), {
        flag: options.rotate ? "w" : "wx",
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      // Lost the race: someone created the file after our pre-check. Same
      // refusal, reached atomically.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw alreadyStored();
      throw error;
    }
  },

  async delete(): Promise<void> {
    rmSync(keyFile(), { force: true });
  },
};
