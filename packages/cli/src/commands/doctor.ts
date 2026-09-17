import { existsSync } from "node:fs";
import { openContext } from "../context";
import { isDaemonRunning } from "../daemon/client";
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
    info(`Hook:      ${hookDir()}${existsSync(hookDir()) ? "" : yellow("  (not installed)")}`);

    if (ctx.backend === "file") {
      console.log(
        yellow(
          "!  The data key is in a 0600 file, not an OS credential store. " +
            "Install `secret-tool` (Linux) for stronger protection.",
        ),
      );
    }

    if (await isDaemonRunning()) ok("Daemon is running.");
    else info("Daemon is not running. It starts automatically on first use.");

    return 0;
  } finally {
    ctx.vault.close();
  }
}
