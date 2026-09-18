import { existsSync, statSync } from "node:fs";
import { openContext } from "../context";
import { isDaemonRunning } from "../daemon/client";
import { projectStatus } from "../init/status";
import { bold, info, ok, yellow } from "../output";
import { hookDir, kerstelHome, socketPath, tokenPath, vaultPath } from "../paths";

/**
 * Renders a path's ACTUAL mode next to the one Kerstel intends, flagging
 * anything looser. Reporting the intended mode would be worthless -- the whole
 * question is whether what is on disk still matches it.
 *
 * Windows is exempt: NTFS does not implement POSIX modes, and `doctor` already
 * prints that caveat once rather than flagging every path as wrong.
 */
function modeReport(path: string, expected: number): string {
  if (process.platform === "win32" || !existsSync(path)) return "";
  let actual: number;
  try {
    actual = statSync(path).mode & 0o777;
  } catch {
    return "";
  }
  const shown = actual.toString(8).padStart(4, "0");
  // Looser means any bit set that the expected mode does not grant -- group or
  // world access, typically. A stricter mode is the user's business.
  if ((actual & ~expected) !== 0) {
    return yellow(`  (mode ${shown}, expected ${expected.toString(8).padStart(4, "0")})`);
  }
  return `  (mode ${shown})`;
}

export async function doctorCommand(cwd: string = process.cwd()): Promise<number> {
  const ctx = await openContext();
  try {
    console.log(bold("Kerstel doctor"));
    info(`Home:      ${kerstelHome()}${modeReport(kerstelHome(), 0o700)}`);
    info(`Vault:     ${vaultPath()} (${ctx.vault.listSecrets().length} secrets)`);
    info(`Token:     ${tokenPath()}${modeReport(tokenPath(), 0o600)}`);
    info(`Keychain:  ${ctx.backend}`);
    info(`Socket:    ${socketPath()}${modeReport(socketPath(), 0o600)}`);
    // openContext() just tried to install these and recorded the outcome on the
    // context, so "not installed" here means the write failed (a read-only
    // home, a permissions problem). Read that result rather than re-reading
    // and re-comparing all four files off disk to learn what we were already
    // told. A reachable branch, not dead code: installHookAssets() records the
    // failure and lets the command run instead of throwing out of openContext().
    info(`Hook:      ${hookDir()}${ctx.hookInstall.installed ? "" : yellow("  (not installed)")}`);
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

    // Spec §6.3: wiring problems are diagnosed here, in the project, because
    // that is where they are: a machine can be perfectly set up and a project
    // still unwired.
    const project = projectStatus(cwd, ctx.vault, ctx.hookDir);
    if (project) {
      console.log("");
      console.log(bold("Project"));
      info(`Root:       ${project.root}`);
      info(
        `Scope:      ${project.scope ?? yellow("could not be derived — pass --scope to `kerstel init`")}`,
      );
      info(`Runtime:    ${project.runtime} (${project.packageManager})`);
      info(
        `Scripts:    ${project.scripts.wired} of ${project.scripts.wrappable} script${project.scripts.wrappable === 1 ? "" : "s"} wired through \`kerstel exec\`` +
          (project.scripts.wired < project.scripts.wrappable ? yellow("  (run `kerstel init`)") : ""),
      );
      if (project.bunfig !== "not-applicable") {
        info(
          `bunfig:     preload ${project.bunfig}` +
            (project.bunfig === "present" ? "" : yellow("  (run `kerstel init`)")),
        );
      }
      info(
        `References: ${project.references.resolvable} of ${project.references.total} reference${project.references.total === 1 ? "" : "s"} in ${project.envFiles.join(", ") || "no env files"} resolve here`,
      );
      if (project.unreadable.length > 0) {
        console.log(
          yellow(
            `!  Could not read ${project.unreadable.join(", ")}. Any reference in ` +
              `${project.unreadable.length === 1 ? "that file is" : "those files are"} missing from the count above; ` +
              "check the file's permissions.",
          ),
        );
      }
      for (const missing of project.references.unresolved) {
        console.log(yellow(`!  ${missing} has no value in this vault. Run \`kerstel init\` to supply it.`));
      }
    }

    if (await isDaemonRunning()) ok("Daemon is running.");
    else info("Daemon is not running. Start it with `kerstel daemon start`.");

    return 0;
  } finally {
    ctx.vault.close();
  }
}
