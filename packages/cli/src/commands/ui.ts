import { openContext } from "../context";
import { fail } from "../output";
import { vaultData } from "../tui/data";
import { runUi } from "../tui/run";
import { processTerminal, type Terminal } from "../tui/terminal";
import { cliName } from "../ui/cli-name";
import { detectTheme, makeTheme } from "../ui/theme";

/**
 * `kerstel ui`: a full-screen view of the vault in the terminal. Terminal UI
 * spec §4. It opens the vault the way `kerstel set` does and talks to nothing
 * else: no daemon call, and nothing listening anywhere.
 */
export async function uiCommand(
  args: string[],
  deps: { terminal?: Terminal; interactive?: boolean } = {},
): Promise<number> {
  if (args.length > 0) {
    fail(`${cliName()} ui takes no arguments.`);
    return 2;
  }
  const interactive =
    deps.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true && process.env.TERM !== "dumb");
  if (!interactive) {
    fail(`${cliName()} ui needs an interactive terminal. Use ${cliName()} ls and ${cliName()} refs in a pipe.`);
    return 2;
  }
  const ctx = await openContext();
  try {
    await runUi(deps.terminal ?? processTerminal(), vaultData(ctx.vault), makeTheme(detectTheme(process.stdout)));
    return 0;
  } finally {
    ctx.vault.close();
  }
}
