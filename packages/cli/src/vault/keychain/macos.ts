import { commandExists, run } from "./exec";
import { ACCOUNT_NAME, SERVICE_NAME, type KeychainBackend } from "./types";

// `security find-generic-password` on a missing item exits with errSecItemNotFound.
const ITEM_NOT_FOUND_EXIT = 44;

export const macosBackend: KeychainBackend = {
  name: "macos",

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    if (!(await commandExists("security"))) return false;
    // The binary existing is not enough: a headless/SSH session can have a
    // locked or absent login keychain, in which case every `security` call
    // fails and this backend would throw instead of the caller falling back
    // to the file backend. Probe with a real read, mirroring linux.ts's
    // approach of interpreting the result rather than trusting a bare exit
    // code. A missing item (exit 44) is the normal first-run state and still
    // means the keychain itself is reachable, so only that or success counts
    // as available; a locked/missing keychain (e.g. interaction-not-allowed)
    // reports some other exit code and correctly falls through to `false`.
    const probe = await run([
      "security", "find-generic-password",
      "-a", ACCOUNT_NAME, "-s", SERVICE_NAME, "-w",
    ]);
    return probe.code === 0 || probe.code === ITEM_NOT_FOUND_EXIT;
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
    //
    // This double-prompt behavior was found empirically on this machine (macOS
    // 26.6.2) by observing `security` hang the second read on EOF and silently
    // create the item with an empty secret when fed only one line — it is not
    // documented Apple behavior, and other `security` builds may prompt only
    // once. Writing the value twice is safe either way: a build that reads
    // once consumes the first line and never looks at the second, so this is
    // not a workaround to "clean up" — removing it can silently corrupt the
    // stored key on builds that do want the confirmation line.
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
