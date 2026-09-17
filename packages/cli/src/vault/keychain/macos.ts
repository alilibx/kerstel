import { commandExists, run } from "./exec";
import { ACCOUNT_NAME, SERVICE_NAME, type KeychainBackend } from "./types";

export const macosBackend: KeychainBackend = {
  name: "macos",

  async isAvailable(): Promise<boolean> {
    return process.platform === "darwin" && (await commandExists("security"));
  },

  async get(): Promise<Buffer | null> {
    const res = await run([
      "security", "find-generic-password",
      "-a", ACCOUNT_NAME, "-s", SERVICE_NAME, "-w",
    ]);
    if (res.code !== 0) return null;
    const key = Buffer.from(res.stdout.trim(), "base64");
    return key.length === 32 ? key : null;
  },

  async set(key: Buffer): Promise<void> {
    // -U updates in place when the item already exists.
    // -w with no value makes `security` read the password from stdin. It prompts
    // for the value twice (entry + confirmation) even when reading from a pipe,
    // so the same line is written twice.
    const value = `${key.toString("base64")}\n`;
    const res = await run(
      [
        "security", "add-generic-password",
        "-a", ACCOUNT_NAME, "-s", SERVICE_NAME,
        "-D", "Kerstel vault key", "-U", "-w",
      ],
      value + value,
    );
    if (res.code !== 0) throw new Error(`macOS Keychain write failed: ${res.stderr.trim()}`);
  },

  async delete(): Promise<void> {
    await run(["security", "delete-generic-password", "-a", ACCOUNT_NAME, "-s", SERVICE_NAME]);
  },
};
