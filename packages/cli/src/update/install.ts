import { createHash } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReleaseSource } from "./release-source";
import { compareVersions } from "./versions";

export interface UpdateOptions {
  source: ReleaseSource;
  currentVersion: string;
  /** The binary to replace: the real path of the running `kerstel`. */
  targetPath: string;
  /** The release asset for this platform, such as `kerstel-darwin-arm64`. */
  asset: string;
  /** Report only; download and install nothing. */
  checkOnly?: boolean;
  /** Called as each stage begins, for a spinner or a log line. */
  onStage?: (stage: "download" | "verify" | "install") => void;
}

export type UpdateOutcome =
  | { kind: "up-to-date"; version: string }
  | { kind: "unreachable" }
  | { kind: "available"; from: string; to: string }
  | { kind: "updated"; from: string; to: string };

/**
 * The same steps as `install.sh`, in order: download the asset and the
 * checksum file, verify, stage next to the destination, then rename over
 * it. Staging in the same directory makes the swap one atomic step, even
 * while the old binary is running (the running process keeps its inode).
 * Before the swap the staged file is run once, so a download that is not
 * the release it claims to be never replaces a working install. Every
 * failure throws before anything is replaced, and removes the staged file.
 */
export async function performUpdate(options: UpdateOptions): Promise<UpdateOutcome> {
  const latest = await options.source.latestVersion();
  if (latest === null) return { kind: "unreachable" };
  if (compareVersions(options.currentVersion, latest) >= 0) {
    return { kind: "up-to-date", version: options.currentVersion };
  }
  const from = options.currentVersion;
  if (options.checkOnly) return { kind: "available", from, to: latest };

  options.onStage?.("download");
  const bytes = await download(options.source.assetUrl(latest, options.asset));
  const checksums = await download(options.source.checksumsUrl(latest));

  options.onStage?.("verify");
  const expected = checksumFor(new TextDecoder().decode(checksums), options.asset);
  if (!expected) throw new Error(`SHA256SUMS has no entry for ${options.asset}; nothing was installed`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${options.asset}; nothing was installed`);

  options.onStage?.("install");
  const staged = join(dirname(options.targetPath), `.kerstel-update.${process.pid}`);
  try {
    writeFileSync(staged, bytes);
    chmodSync(staged, 0o755);
    const reported = reportedVersion(staged);
    if (reported !== latest) {
      throw new Error(
        `the downloaded kerstel reported ${reported || "nothing"} instead of ${latest}; nothing was installed`,
      );
    }
    renameSync(staged, options.targetPath);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
  return { kind: "updated", from, to: latest };
}

async function download(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    throw new Error(`could not download ${url}: ${(error as Error).message}`);
  }
  if (!response.ok) throw new Error(`could not download ${url} (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The hash on the `<sha256>  <name>` line for `asset`, as `sha256sum` writes it. */
function checksumFor(checksums: string, asset: string): string | null {
  for (const line of checksums.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === asset && hash) return hash.toLowerCase();
  }
  return null;
}

function reportedVersion(binary: string): string {
  const run = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return run.stdout.toString().trim();
}
