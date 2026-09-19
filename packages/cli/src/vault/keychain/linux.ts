import { commandExists, run, type ExecResult } from "./exec";
import { ACCOUNT_NAME, serviceName, type KeychainBackend, type SetOptions } from "./types";

/** Rebuilt on every call so a test-time `KERSTEL_KEYCHAIN_SERVICE` override is honoured. */
function attrs(): string[] {
  return ["service", serviceName(), "account", ACCOUNT_NAME];
}

/**
 * What one `secret-tool lookup` said about the item.
 *
 * `secret-tool` has no metadata-only query, so `lookup` is the only way to ask
 * whether an item exists, and its exit code alone cannot say why it found
 * nothing. A missing item exits 1 with NOTHING on stderr. A D-Bus hiccup, an
 * agent that is still starting, or a session with no bus also exit non-zero,
 * with a message. Reading all of those as "absent" is what let a transient
 * failure mint a fresh key over the only copy of the real one: `store`
 * overwrites silently. So only the exact shape of "not found" is absent;
 * everything else is unknown, and the caller treats unknown as present.
 */
export function interpretLookup(result: ExecResult): "present" | "absent" | "unknown" {
  if (result.code === 0) return result.stdout.trim() === "" ? "unknown" : "present";
  if (result.code === 1 && result.stderr.trim() === "") return "absent";
  return "unknown";
}

export const linuxBackend: KeychainBackend = {
  name: "linux",

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "linux") return false;
    if (!(await commandExists("secret-tool"))) return false;
    // A running Secret Service is required; `lookup` on a missing item exits 1
    // with empty stderr, while a missing daemon reports a D-Bus error.
    const probe = await run(["secret-tool", "lookup", ...attrs()]);
    return !/dbus|no such|not provided/i.test(probe.stderr);
  },

  async get(): Promise<Buffer | null> {
    const res = await run(["secret-tool", "lookup", ...attrs()]);
    if (res.code !== 0 || res.stdout.trim() === "") return null;
    const key = Buffer.from(res.stdout.trim(), "base64");
    return key.length === 32 ? key : null;
  },

  async exists(): Promise<boolean> {
    // Unlike macOS, this DOES read the secret: the Secret Service CLI offers no
    // metadata-only query, so `lookup` is the only way to ask whether an item
    // is there and it returns the item's value. The value is discarded without
    // being logged or returned; only the yes/no leaves this function.
    //
    // The gap this closes is different from macOS's. There is no per-app ACL
    // here, so "stored but denied" does not happen; what does happen is a
    // failing bus. `interpretLookup` keeps that from reading as "absent": the
    // cost of a false "exists" is a clear error the user can act on, the cost
    // of a false "absent" is a vault nobody can open again.
    let res: ExecResult;
    try {
      res = await run(["secret-tool", "lookup", ...attrs()]);
    } catch {
      return true;
    }
    return interpretLookup(res) !== "absent";
  },

  async set(key: Buffer, options: SetOptions = {}): Promise<void> {
    // UNCLOSEABLE RACE, documented rather than papered over.
    //
    // `secret-tool store` overwrites a matching item silently and offers no
    // create-if-absent mode, so unlike file.ts and windows.ts -- which get
    // atomicity from O_EXCL via the "wx" flag -- there is no single operation
    // here that both checks and writes. A concurrent Kerstel racing this one
    // can still have its key replaced. Closing it properly needs the
    // libsecret API (SECRET_SCHEMA + a create-only call), which means a native
    // module, which the single-self-contained-binary constraint rules out.
    //
    // What is done instead: the window is narrowed to the gap between the
    // check immediately below and the store on the next line, rather than
    // spanning the caller's own decision-making. Best effort, and honest about
    // being only that.
    if (!options.rotate && (await this.exists())) {
      throw new Error(
        "A Kerstel vault key is already stored in the Secret Service. Refusing to " +
          "replace it: the stored key is the only copy, and overwriting it would make " +
          "every secret in the vault permanently unreadable.",
      );
    }
    const res = await run(
      ["secret-tool", "store", "--label=Kerstel vault key", ...attrs()],
      `${key.toString("base64")}\n`,
    );
    if (res.code !== 0) throw new Error(`Secret Service write failed: ${res.stderr.trim()}`);
  },

  async delete(): Promise<void> {
    await run(["secret-tool", "clear", ...attrs()]);
  },
};
