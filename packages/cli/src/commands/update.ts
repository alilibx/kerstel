import { realpathSync } from "node:fs";
import { stopDaemonIfRunning } from "../daemon/client";
import { isCompiledBinary } from "../daemon/spawn";
import { CancelledError, ClackPrompter, type Prompter } from "../init/prompts";
import { fail, info, ok, yellow } from "../output";
import { SYMBOLS } from "../ui/theme";
import { cliName } from "../ui/cli-name";
import { interactive } from "../ui/steps";
import { performUpdate, type UpdateOutcome } from "../update/install";
import { ProgressBar } from "../update/progress";
import { githubReleases, type ReleaseSource } from "../update/release-source";
import { assetName, compareVersions } from "../update/versions";
import { VERSION } from "../version";
import { serverBehind } from "./sync-server";

/** Everything `update` reads from the machine, injectable so tests never touch the real binary or GitHub. */
export interface UpdateDeps {
  source: ReleaseSource;
  /** The binary to replace. */
  targetPath: string;
  /** The release asset for this platform, or null when there is none. */
  asset: string | null;
  compiled: boolean;
  currentVersion: string;
  /** Stops a running daemon; resolves to whether one was running. */
  stopDaemon: () => Promise<boolean>;
  /** Whether stdout is a terminal, where the download draws a bar. Defaults to the real stream. */
  isTTY?: boolean;
  /**
   * The sync server this device installed, when it runs an older release than
   * `version`; null when there is none, it is current, or it did not answer.
   * Omitted: no server is checked.
   */
  serverBehind?: (version: string) => Promise<{ place: string; version: string } | null>;
  /** Runs `sync server update` with the CLI now installed; resolves to its exit code. */
  updateServer?: () => Promise<number>;
  /** Whether stdin and stdout are a terminal, to ask about the server. Defaults to the real streams. */
  interactive?: boolean;
  prompter?: Prompter;
}

function realDeps(): UpdateDeps {
  const targetPath = realpathSync(process.execPath);
  return {
    source: githubReleases(),
    targetPath,
    asset: assetName(process.platform, process.arch),
    compiled: isCompiledBinary(),
    currentVersion: VERSION,
    stopDaemon: stopDaemonIfRunning,
    serverBehind: (version) => serverBehind(version),
    updateServer: () => updateServerWith(targetPath),
  };
}

/**
 * The new binary updates the server, not this process: it is the old version,
 * and the installer it would upload and the version it would install must be
 * the new one's. It shows its own output and prompts on this terminal.
 */
async function updateServerWith(binary: string): Promise<number> {
  const proc = Bun.spawn([binary, "sync", "server", "update"], {
    // Keeps `ks` in the hints when the user typed `ks`.
    argv0: process.argv0,
    env: process.env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  return proc.exited;
}

/**
 * After `update` leaves this Kerstel at `version`: says when the server this
 * device installed runs an older release, and on a terminal offers to update
 * it (Yes by default). `--check` changes nothing, so it only says so. A server
 * that does not answer is not mentioned. Resolves to the exit code.
 */
async function checkServer(version: string, deps: UpdateDeps, checkOnly: boolean): Promise<number> {
  if (!deps.serverBehind) return 0;
  const behind = await deps.serverBehind(version);
  if (behind === null) return 0;
  const cli = cliName();
  info(`The sync server on ${behind.place} runs ${behind.version}; this Kerstel is ${version}.`);
  const terminal = deps.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (checkOnly || !terminal || !deps.updateServer) {
    info(`Run ${cli} sync server update to update it.`);
    return 0;
  }
  let answer: "yes" | "no";
  try {
    answer = await (deps.prompter ?? new ClackPrompter()).select(
      "Update the server now?",
      [
        { value: "yes", label: "Yes, update it" },
        { value: "no", label: "No, not now" },
      ],
      "yes",
    );
  } catch (error) {
    if (error instanceof CancelledError) answer = "no";
    else throw error;
  }
  if (answer !== "yes") {
    info(`Update it later with ${cli} sync server update.`);
    return 0;
  }
  return deps.updateServer();
}

/** The dim line under `--version` on a terminal. */
export function versionStatusLine(current: string, latest: string | null, cli: string): string {
  if (latest === null) return "Could not check for updates.";
  if (compareVersions(current, latest) < 0) return `${latest} is available. Run ${cli} update.`;
  return "Up to date.";
}

export interface VersionDeps {
  isTTY: boolean;
  source: ReleaseSource;
  currentVersion: string;
  cli: string;
  /** Receives the plain status line; the caller styles it for its own stream and adds the newline. */
  stderr: (line: string) => void;
}

/**
 * `kerstel --version`. Stdout carries the bare version and nothing else, so
 * `install.sh`, the release smoke tests, and anyone's script keep working.
 * On a terminal the status goes to stderr as a second line; piped, the
 * command never touches the network at all.
 */
export async function versionCommand(deps: VersionDeps): Promise<number> {
  console.log(deps.currentVersion);
  if (!deps.isTTY) return 0;
  if (deps.source.problem) {
    deps.stderr(deps.source.problem);
    return 0;
  }
  const latest = await deps.source.latestVersion();
  deps.stderr(versionStatusLine(deps.currentVersion, latest, deps.cli));
  return 0;
}

/**
 * The old daemon is the old binary, still serving until it goes idle. Stop
 * it so the next resolution starts the new one; nothing else has to change,
 * since it starts on its own when a script needs a secret. The update is
 * already installed by now, so a daemon that will not stop is a warning
 * with the command to retry, never a failed update.
 */
async function stopOldDaemon(stopDaemon: () => Promise<boolean>, cli: string): Promise<void> {
  try {
    if (await stopDaemon()) info("Stopped the resolver daemon; the new version starts on its own when needed.");
  } catch (error) {
    console.log(
      `${yellow(SYMBOLS.warn)}  Could not stop the old resolver daemon (${(error as Error).message}). ` +
        `Run ${cli} daemon stop so the new version takes over.`,
    );
  }
}

export async function updateCommand(args: string[], deps: UpdateDeps = realDeps()): Promise<number> {
  let checkOnly = false;
  for (const arg of args) {
    if (arg === "--check") checkOnly = true;
    else {
      fail(`Unknown option "${arg}". ${cliName()} update accepts: --check.`);
      return 2;
    }
  }

  const cli = cliName();
  if (!checkOnly && !deps.compiled) {
    fail(`Kerstel is running from source, so there is no binary to replace. Pull the repository instead.`);
    return 1;
  }
  if (!checkOnly && deps.asset === null) {
    fail(`There is no release binary for ${process.platform} on ${process.arch}. Build from source instead.`);
    return 1;
  }

  // Before any request: a refused override would otherwise read as "offline".
  if (deps.source.problem) {
    fail(deps.source.problem);
    return 1;
  }
  if (deps.source.mirror) info(`Using releases from ${deps.source.mirror}`);

  // The bar redraws one line with `\r`, which only reads well on a terminal;
  // piped, the stage lines alone are the record, as with install.sh.
  const tty = deps.isTTY ?? interactive();
  const bar = tty ? new ProgressBar((text) => process.stdout.write(text)) : null;
  let outcome: UpdateOutcome;
  try {
    outcome = await performUpdate({
      source: deps.source,
      currentVersion: deps.currentVersion,
      targetPath: deps.targetPath,
      asset: deps.asset ?? "",
      checkOnly,
      onStage: (stage) => {
        bar?.finish();
        if (stage === "download") info("Downloading the latest release...");
        if (stage === "verify") info("Verifying the checksum...");
        if (stage === "install") info("Installing...");
      },
      onProgress: (received, total) => bar?.update(received, total),
    });
  } finally {
    // A download that fails midway leaves the bar's line open otherwise.
    bar?.finish();
  }

  switch (outcome.kind) {
    case "unreachable":
      fail(
        `Could not reach ${deps.source.mirror ?? "github.com"} to check for updates. Try again when you're online.`,
      );
      return 1;
    case "up-to-date":
      ok(`kerstel ${outcome.version} is up to date.`);
      // The CLI may be current while the server it installed is not.
      return checkServer(outcome.version, deps, checkOnly);
    case "available":
      info(`kerstel ${outcome.to} is available (you have ${outcome.from}). Run ${cli} update to install it.`);
      return 0;
    case "updated":
      ok(`Updated kerstel from ${outcome.from} to ${outcome.to}.`);
      await stopOldDaemon(deps.stopDaemon, cli);
      return checkServer(outcome.to, deps, checkOnly);
  }
}
