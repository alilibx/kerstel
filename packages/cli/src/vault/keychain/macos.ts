import { commandExists, run } from "./exec";
import { ACCOUNT_NAME, serviceName, type KeychainBackend, type SetOptions } from "./types";

// `security find-generic-password` on a missing item exits with errSecItemNotFound.
const ITEM_NOT_FOUND_EXIT = 44;
// `security add-generic-password` without `-U` on an item that already exists
// exits with errSecDuplicateItem and prints "The specified item already exists
// in the keychain." Observed on this machine (macOS 26.6.2, Darwin 25.6.0).
const DUPLICATE_ITEM_EXIT = 45;

/** One argument for `security -i`'s line parser, which splits on spaces and honours double quotes. */
function quoteArg(value: string): string {
  if (/["\\\n\r]/.test(value)) {
    throw new Error(`Cannot pass ${JSON.stringify(value)} to the macOS Keychain: it contains a quote, backslash, or newline.`);
  }
  return `"${value}"`;
}

/**
 * The `security -i` command line that stores the vault key. Exported for
 * tests: the key must be on this line (stdin), never in `security`'s argv.
 */
export function addPasswordCommand(key: Buffer, service: string, rotate: boolean): string {
  const args = [
    "add-generic-password",
    "-a", quoteArg(ACCOUNT_NAME),
    "-s", quoteArg(service),
    "-D", quoteArg("Kerstel vault key"),
    ...(rotate ? ["-U"] : []),
    "-w", quoteArg(key.toString("base64")),
  ];
  return `${args.join(" ")}\n`;
}

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
    //
    // Deliberately WITHOUT `-w`: that flag makes `security` print the password
    // itself, which would pull the vault's master key through a subprocess
    // pipe on every auto-selected vault open purely to learn whether the
    // keychain answers. Without it the command still queries the same item and
    // still exits 0 / 44 / something-else, so the reachability test is
    // unchanged -- only the needless copy of the key is gone.
    const probe = await run([
      "security", "find-generic-password",
      "-a", ACCOUNT_NAME, "-s", serviceName(),
    ]);
    return probe.code === 0 || probe.code === ITEM_NOT_FOUND_EXIT;
  },

  async get(): Promise<Buffer | null> {
    const res = await run([
      "security", "find-generic-password",
      "-a", ACCOUNT_NAME, "-s", serviceName(), "-w",
    ]);
    if (res.code !== 0) return null;
    const key = Buffer.from(res.stdout.trim(), "base64");
    return key.length === 32 ? key : null;
  },

  async exists(): Promise<boolean> {
    // The metadata-only query: same lookup as get(), WITHOUT `-w`. That is the
    // whole point -- `-w` is what makes `security` ask for the item's *data*,
    // and the data is what the per-application ACL guards. A user who clicked
    // "Deny" on the Keychain prompt still has an item that this query finds
    // (exit 0) while get() is refused and returns null. Distinguishing those
    // two states is what stops loadOrCreateDataKey() reading "denied" as
    // "empty" and overwriting the only copy of the vault's data key.
    const res = await run([
      "security", "find-generic-password",
      "-a", ACCOUNT_NAME, "-s", serviceName(),
    ]);
    if (res.code === 0) return true;
    if (res.code === ITEM_NOT_FOUND_EXIT) return false;
    // Anything else (a locked keychain, interaction-not-allowed, a `security`
    // build with different codes) is "unknown". Answer true: the cost of a
    // false "exists" is a clear error the user can act on, the cost of a false
    // "absent" is an unrecoverable vault.
    return true;
  },

  async set(key: Buffer, options: SetOptions = {}): Promise<void> {
    // No `-U` unless the caller explicitly asked to rotate. `-U` updates in
    // place, which on this item means destroying the only copy of the vault's
    // data key; without it `security` refuses with errSecDuplicateItem (45) and
    // the vault stays readable. This is the second of the two layers guarding
    // that -- loadOrCreateDataKey() is the first -- so that a future caller
    // reaching set() by another route cannot reintroduce the same loss.
    //
    // The command goes to `security -i` on stdin, so the key is never an argv
    // entry. It must NOT be `add-generic-password -w` with the value piped in:
    // with no value, `-w` reads it through readpassphrase(), which prefers the
    // controlling terminal over stdin. Under a pipe (tests, CI) that looks like
    // it works, but in a real terminal `security` ignores stdin and prints
    // "password data for new item:", waiting for the user to type the key.
    const res = await run(
      ["security", "-i"],
      addPasswordCommand(key, serviceName(), options.rotate === true),
    );
    if (res.code === DUPLICATE_ITEM_EXIT) {
      throw new Error(
        "A Kerstel vault key is already stored in the macOS Keychain. Refusing to " +
          "replace it: the stored key is the only copy, and overwriting it would make " +
          "every secret in the vault permanently unreadable.",
      );
    }
    if (res.code !== 0) throw new Error(`macOS Keychain write failed: ${res.stderr.trim()}`);
  },

  async delete(): Promise<void> {
    await run(["security", "delete-generic-password", "-a", ACCOUNT_NAME, "-s", serviceName()]);
  },
};
