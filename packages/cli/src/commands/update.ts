import { realpathSync } from "node:fs";
import { connectDaemon, isDaemonRunning } from "../daemon/client";
import { isCompiledBinary } from "../daemon/spawn";
import { dim, fail, info, ok } from "../output";
import { cliName } from "../ui/cli-name";
import { performUpdate } from "../update/install";
import { githubReleases, type ReleaseSource } from "../update/release-source";
import { assetName, compareVersions } from "../update/versions";
import { VERSION } from "../version";

/** Everything `update` reads from the machine, injectable so tests never touch the real binary or GitHub. */
export interface UpdateDeps {
  source: ReleaseSource;
  /** The binary to replace. */
  targetPath: string;
  /** The release asset for this platform, or null when there is none. */
  asset: string | null;
  compiled: boolean;
  currentVersion: string;
}

function realDeps(): UpdateDeps {
  return {
    source: githubReleases(),
    targetPath: realpathSync(process.execPath),
    asset: assetName(process.platform, process.arch),
    compiled: isCompiledBinary(),
    currentVersion: VERSION,
  };
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
  /** Where the status line goes. Defaults to stderr. */
  stderr: (text: string) => void;
}

/**
 * `kerstel --version`. Stdout carries the bare version and nothing else, so
 * `install.sh`, the release smoke tests, and anyone's script keep working.
 * On a terminal the status goes to stderr as a second, dim line; piped, the
 * command never touches the network at all.
 */
export async function versionCommand(deps: VersionDeps): Promise<number> {
  console.log(deps.currentVersion);
  if (!deps.isTTY) return 0;
  const latest = await deps.source.latestVersion();
  // Not console.error: on a terminal Bun paints that red.
  deps.stderr(`${dim(versionStatusLine(deps.currentVersion, latest, deps.cli))}\n`);
  return 0;
}

/**
 * The old daemon is the old binary, still serving until it goes idle. Stop
 * it so the next resolution starts the new one; nothing else has to change,
 * since it starts on its own when a script needs a secret.
 */
async function stopOldDaemon(): Promise<void> {
  if (!(await isDaemonRunning())) return;
  const client = await connectDaemon();
  await client.shutdown();
  client.close();
  info("Stopped the resolver daemon; the new version starts on its own when needed.");
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

  const outcome = await performUpdate({
    source: deps.source,
    currentVersion: deps.currentVersion,
    targetPath: deps.targetPath,
    asset: deps.asset ?? "",
    checkOnly,
    onStage: (stage) => {
      if (stage === "download") info("Downloading the latest release...");
    },
  });

  switch (outcome.kind) {
    case "unreachable":
      fail("Could not reach github.com to check for updates. Try again when you're online.");
      return 1;
    case "up-to-date":
      ok(`kerstel ${outcome.version} is up to date.`);
      return 0;
    case "available":
      info(`kerstel ${outcome.to} is available (you have ${outcome.from}). Run ${cli} update to install it.`);
      return 0;
    case "updated":
      ok(`Updated kerstel from ${outcome.from} to ${outcome.to}.`);
      await stopOldDaemon();
      return 0;
  }
}
