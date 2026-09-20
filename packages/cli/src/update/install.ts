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
  /** Called as the binary's bytes arrive. `total` is the content-length, or null when the server sent none. */
  onProgress?: (received: number, total: number | null) => void;
  /** How long a download may take to answer with headers. The body has no limit: a slow link is not an error. */
  headerTimeoutMs?: number;
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

  const headerTimeoutMs = options.headerTimeoutMs ?? 30_000;

  // The checksum file first: it is tiny, and a release that cannot verify
  // this asset should fail before the asset's tens of megabytes are pulled.
  options.onStage?.("download");
  const checksums = await download(options.source.checksumsUrl(latest), headerTimeoutMs);
  const expected = checksumFor(new TextDecoder().decode(checksums), options.asset);
  if (!expected) throw new Error(`SHA256SUMS has no entry for ${options.asset}; nothing was installed`);
  const bytes = await download(options.source.assetUrl(latest, options.asset), headerTimeoutMs, options.onProgress);

  options.onStage?.("verify");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${options.asset}; nothing was installed`);

  options.onStage?.("install");
  const dir = dirname(options.targetPath);
  const staged = join(dir, `.kerstel-update.${process.pid}`);
  // Ctrl-C between the write and the rename would otherwise leave a stray
  // binary-sized file next to kerstel forever; install.sh traps EXIT for the
  // same reason.
  const onSignal = () => {
    rmSync(staged, { force: true });
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    try {
      writeFileSync(staged, bytes);
      chmodSync(staged, 0o755);
    } catch (error) {
      throw new Error(`could not write to ${dir}; nothing was installed (${(error as Error).message})`);
    }
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
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return { kind: "updated", from, to: latest };
}

/**
 * The timeout covers the wait for headers only. Once the body is flowing it
 * may take as long as the link needs: a 60 MB binary over a slow connection
 * is a working update, not a hung one.
 */
async function download(
  url: string,
  headerTimeoutMs: number,
  onProgress?: (received: number, total: number | null) => void,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), headerTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    throw new Error(`could not download ${url}: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`could not download ${url} (HTTP ${response.status})`);
  if (!response.body) return new Uint8Array(await response.arrayBuffer());

  // Read the body chunk by chunk so the caller can draw progress; buffering
  // it whole with arrayBuffer() would say nothing until the last byte.
  const header = response.headers.get("content-length");
  const total = header !== null && /^\d+$/.test(header) ? Number(header) : null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  onProgress?.(0, total);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(received, total);
    }
  } catch (error) {
    throw new Error(`could not download ${url}: ${(error as Error).message}`);
  }
  return Buffer.concat(chunks, received);
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
