import { openContext } from "../context";
import { isDaemonRunning } from "../daemon/client";
import { hookAssetsInstalled } from "../hook-assets";
import { bold, info, ok, yellow } from "../output";
import { hookDir, kerstelHome, socketPath, vaultPath } from "../paths";

export async function doctorCommand(): Promise<number> {
  const ctx = await openContext();
  try {
    console.log(bold("Kerstel doctor"));
    info(`Home:      ${kerstelHome()}`);
    info(`Vault:     ${vaultPath()} (${ctx.vault.listSecrets().length} secrets)`);
    info(`Keychain:  ${ctx.backend}`);
    info(`Socket:    ${socketPath()}`);
    // openContext() just tried to install these, so "not installed" here means
    // the write failed (a read-only home, a permissions problem). That is now a
    // reachable branch rather than dead code: installHookAssets() records the
    // failure and lets the command run instead of throwing out of openContext().
    info(`Hook:      ${hookDir()}${hookAssetsInstalled() ? "" : yellow("  (not installed)")}`);
    if (ctx.hookInstall.error) {
      console.log(
        yellow(
          `!  Could not install the runtime hook: ${ctx.hookInstall.error}\n` +
            "   Everything else still works; `kerstel run -- <command>` resolves " +
            "references without the hook.",
        ),
      );
    }

    if (ctx.backend === "file") {
      console.log(
        yellow(
          "!  The data key is in a 0600 file, not an OS credential store. " +
            "Install `secret-tool` (Linux) for stronger protection.",
        ),
      );
    }

    if (process.platform === "win32") {
      console.log(
        yellow(
          "!  On Windows the 0700/0600 permission bits Kerstel sets are inert: NTFS does " +
            "not implement POSIX modes. Your home directory is protected by the user " +
            "profile's inherited ACL, and the named pipe carries libuv's default security " +
            "descriptor.",
        ),
      );
    }

    if (await isDaemonRunning()) ok("Daemon is running.");
    else info("Daemon is not running. Start it with `kerstel daemon start`.");

    return 0;
  } finally {
    ctx.vault.close();
  }
}
