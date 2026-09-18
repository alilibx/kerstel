import { commandExists, run } from "./exec";
import { ACCOUNT_NAME, SERVICE_NAME, type KeychainBackend, type SetOptions } from "./types";

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

  async exists(): Promise<boolean> {
    // Unlike macOS, this DOES read the secret: the Secret Service CLI offers no
    // metadata-only query, so `lookup` is the only way to ask whether an item
    // is there and it returns the item's value. That is acceptable here because
    // the gap this method closes on macOS does not exist on Linux in the same
    // form -- there is no per-application data ACL that can deny a read while
    // leaving the item findable, so `lookup` succeeding and `get()` succeeding
    // are the same event. The value is discarded without being logged or
    // returned; only the yes/no leaves this function.
    const res = await run(["secret-tool", "lookup", ...ATTRS]);
    return res.code === 0 && res.stdout.trim() !== "";
  },

  async set(key: Buffer, options: SetOptions = {}): Promise<void> {
    // `secret-tool store` overwrites a matching item silently, so the refusal
    // has to be an explicit pre-check rather than a failure we can catch.
    if (!options.rotate && (await this.exists())) {
      throw new Error(
        "A Kerstel vault key is already stored in the Secret Service. Refusing to " +
          "replace it: the stored key is the only copy, and overwriting it would make " +
          "every secret in the vault permanently unreadable.",
      );
    }
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
