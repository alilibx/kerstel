import { commandExists, run } from "./exec";
import { ACCOUNT_NAME, SERVICE_NAME, type KeychainBackend } from "./types";

const ATTRS = ["service", SERVICE_NAME, "account", ACCOUNT_NAME];

export const linuxBackend: KeychainBackend = {
  name: "linux",

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "linux") return false;
    if (!(await commandExists("secret-tool"))) return false;
    // A running Secret Service is required; `lookup` on a missing item exits 1
    // with empty stderr, while a missing daemon reports a D-Bus error.
    const probe = await run(["secret-tool", "lookup", ...ATTRS]);
    return !/dbus|no such|not provided/i.test(probe.stderr);
  },

  async get(): Promise<Buffer | null> {
    const res = await run(["secret-tool", "lookup", ...ATTRS]);
    if (res.code !== 0 || res.stdout.trim() === "") return null;
    const key = Buffer.from(res.stdout.trim(), "base64");
    return key.length === 32 ? key : null;
  },

  async set(key: Buffer): Promise<void> {
    const res = await run(
      ["secret-tool", "store", "--label=Kerstel vault key", ...ATTRS],
      `${key.toString("base64")}\n`,
    );
    if (res.code !== 0) throw new Error(`Secret Service write failed: ${res.stderr.trim()}`);
  },

  async delete(): Promise<void> {
    await run(["secret-tool", "clear", ...ATTRS]);
  },
};
