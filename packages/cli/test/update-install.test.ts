import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performUpdate } from "../src/update/install";
import type { ReleaseSource } from "../src/update/release-source";

const ASSET = "kerstel-test-x64";
const dirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  assetRequests.length = 0;
  while (servers.length) servers.pop()!.stop(true);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function script(version: string): string {
  return `#!/bin/sh\necho ${version}\n`;
}

/** A "binary" at <dir>/kerstel that reports `version`. */
function installedBinary(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-update-"));
  dirs.push(dir);
  const target = join(dir, "kerstel");
  writeFileSync(target, script(version));
  chmodSync(target, 0o755);
  return target;
}

interface FakeRelease {
  latest: string | null;
  /** Bytes served for the asset. Defaults to a script reporting `latest`. */
  assetBody?: string;
  /** Checksum line served. Defaults to the real checksum of assetBody. */
  checksums?: string;
  missingAsset?: boolean;
  /** Stream the asset body in chunks this far apart, to imitate a slow link. */
  chunkDelayMs?: number;
  /** Stream without a content-length header, as a server that does not know the size would. */
  unknownLength?: boolean;
}

const assetRequests: string[] = [];

function fakeRelease(release: FakeRelease): ReleaseSource {
  const body = release.assetBody ?? script(release.latest ?? "0.0.0");
  const sum = createHash("sha256").update(body).digest("hex");
  const checksums = release.checksums ?? `${sum}  ${ASSET}\n${"0".repeat(64)}  kerstel-other\n`;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/SHA256SUMS")) return new Response(checksums);
      if (path.endsWith(`/${ASSET}`)) assetRequests.push(path);
      if (path.endsWith(`/${ASSET}`) && !release.missingAsset) {
        if (!release.chunkDelayMs) return new Response(body);
        const delay = release.chunkDelayMs;
        const stream = new ReadableStream({
          async start(controller) {
            for (const char of body) {
              await Bun.sleep(delay);
              controller.enqueue(new TextEncoder().encode(char));
            }
            controller.close();
          },
        });
        return new Response(stream, release.unknownLength ? undefined : { headers: { "content-length": String(body.length) } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  return {
    latestVersion: async () => release.latest,
    assetUrl: (version, asset) => `${base}/v${version}/${asset}`,
    checksumsUrl: (version) => `${base}/v${version}/SHA256SUMS`,
  };
}

test("reports up to date when the latest release is the running version", async () => {
  const target = installedBinary("0.1.0");
  const outcome = await performUpdate({
    source: fakeRelease({ latest: "0.1.0" }),
    currentVersion: "0.1.0",
    targetPath: target,
    asset: ASSET,
  });
  expect(outcome).toEqual({ kind: "up-to-date", version: "0.1.0" });
});

test("reports unreachable when the latest version cannot be determined", async () => {
  const target = installedBinary("0.1.0");
  const outcome = await performUpdate({
    source: fakeRelease({ latest: null }),
    currentVersion: "0.1.0",
    targetPath: target,
    asset: ASSET,
  });
  expect(outcome).toEqual({ kind: "unreachable" });
});

test("checkOnly reports the newer version and changes nothing", async () => {
  const target = installedBinary("0.1.0");
  const outcome = await performUpdate({
    source: fakeRelease({ latest: "0.1.1" }),
    currentVersion: "0.1.0",
    targetPath: target,
    asset: ASSET,
    checkOnly: true,
  });
  expect(outcome).toEqual({ kind: "available", from: "0.1.0", to: "0.1.1" });
  expect(readFileSync(target, "utf8")).toBe(script("0.1.0"));
});

test("downloads, verifies, and swaps the binary in place", async () => {
  const target = installedBinary("0.1.0");
  const outcome = await performUpdate({
    source: fakeRelease({ latest: "0.1.1" }),
    currentVersion: "0.1.0",
    targetPath: target,
    asset: ASSET,
  });
  expect(outcome).toEqual({ kind: "updated", from: "0.1.0", to: "0.1.1" });
  expect(readFileSync(target, "utf8")).toBe(script("0.1.1"));
  // Still executable, and nothing staged left behind next to it.
  expect(Bun.spawnSync([target, "--version"]).stdout.toString().trim()).toBe("0.1.1");
  expect(readdirSync(join(target, ".."))).toEqual(["kerstel"]);
});

test("a checksum mismatch installs nothing", async () => {
  const target = installedBinary("0.1.0");
  const bad = `${"f".repeat(64)}  ${ASSET}\n`;
  await expect(
    performUpdate({
      source: fakeRelease({ latest: "0.1.1", checksums: bad }),
      currentVersion: "0.1.0",
      targetPath: target,
      asset: ASSET,
    }),
  ).rejects.toThrow(/checksum mismatch/);
  expect(readFileSync(target, "utf8")).toBe(script("0.1.0"));
  expect(readdirSync(join(target, ".."))).toEqual(["kerstel"]);
});

test("a checksum file without this asset installs nothing", async () => {
  const target = installedBinary("0.1.0");
  await expect(
    performUpdate({
      source: fakeRelease({ latest: "0.1.1", checksums: `${"0".repeat(64)}  kerstel-other\n` }),
      currentVersion: "0.1.0",
      targetPath: target,
      asset: ASSET,
    }),
  ).rejects.toThrow(/no entry for kerstel-test-x64/);
  expect(readFileSync(target, "utf8")).toBe(script("0.1.0"));
  // The checksum file is read first, so a release that cannot verify this
  // asset never costs the asset download.
  expect(assetRequests).toEqual([]);
});

test("an unwritable install directory is named, and nothing is installed", async () => {
  if (process.getuid?.() === 0) return; // root writes anywhere
  const target = installedBinary("0.1.0");
  const dir = join(target, "..");
  chmodSync(dir, 0o500);
  try {
    await expect(
      performUpdate({
        source: fakeRelease({ latest: "0.1.1" }),
        currentVersion: "0.1.0",
        targetPath: target,
        asset: ASSET,
      }),
    ).rejects.toThrow(new RegExp(`could not write to ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; nothing was installed`));
  } finally {
    chmodSync(dir, 0o700);
  }
  expect(readFileSync(target, "utf8")).toBe(script("0.1.0"));
  expect(readdirSync(dir)).toEqual(["kerstel"]);
});

test("reports the binary's bytes as they arrive, from zero to the content-length, and never the checksum file's", async () => {
  const target = installedBinary("0.1.0");
  const body = script("0.1.1");
  const calls: [number, number | null][] = [];
  // A buffered Response is the one Bun.serve sends with a content-length; a
  // streamed one goes out chunked without it, which the next test covers.
  await performUpdate({
    source: fakeRelease({ latest: "0.1.1" }),
    currentVersion: "0.1.0",
    targetPath: target,
    asset: ASSET,
    onProgress: (received, total) => calls.push([received, total]),
  });
  expect(calls[0]).toEqual([0, body.length]);
  expect(calls.at(-1)).toEqual([body.length, body.length]);
  // The checksum file is a different size and downloads first; it must not show up here.
  expect(calls.every(([, total]) => total === body.length)).toBe(true);
  for (let i = 1; i < calls.length; i++) expect(calls[i]![0]).toBeGreaterThanOrEqual(calls[i - 1]![0]);
});

test("reports a null total when the server sends no content-length, and still installs", async () => {
  const target = installedBinary("0.1.0");
  const body = script("0.1.1");
  const calls: [number, number | null][] = [];
  const outcome = await performUpdate({
    source: fakeRelease({ latest: "0.1.1", chunkDelayMs: 1, unknownLength: true }),
    currentVersion: "0.1.0",
    targetPath: target,
    asset: ASSET,
    onProgress: (received, total) => calls.push([received, total]),
  });
  expect(outcome).toEqual({ kind: "updated", from: "0.1.0", to: "0.1.1" });
  expect(calls.every(([, total]) => total === null)).toBe(true);
  expect(calls.at(-1)![0]).toBe(body.length);
  expect(readFileSync(target, "utf8")).toBe(body);
});

test("a slow download still completes: the timeout covers the headers, not the body", async () => {
  const target = installedBinary("0.1.0");
  const outcome = await performUpdate({
    source: fakeRelease({ latest: "0.1.1", chunkDelayMs: 20 }),
    currentVersion: "0.1.0",
    targetPath: target,
    asset: ASSET,
    headerTimeoutMs: 150,
  });
  expect(outcome).toEqual({ kind: "updated", from: "0.1.0", to: "0.1.1" });
});

test("a missing asset installs nothing", async () => {
  const target = installedBinary("0.1.0");
  await expect(
    performUpdate({
      source: fakeRelease({ latest: "0.1.1", missingAsset: true }),
      currentVersion: "0.1.0",
      targetPath: target,
      asset: ASSET,
    }),
  ).rejects.toThrow(/could not download/);
  expect(readFileSync(target, "utf8")).toBe(script("0.1.0"));
  expect(readdirSync(join(target, ".."))).toEqual(["kerstel"]);
});

test("a download that does not report the expected version is discarded", async () => {
  const target = installedBinary("0.1.0");
  await expect(
    performUpdate({
      source: fakeRelease({ latest: "0.1.1", assetBody: script("0.0.9") }),
      currentVersion: "0.1.0",
      targetPath: target,
      asset: ASSET,
    }),
  ).rejects.toThrow(/reported 0.0.9/);
  expect(readFileSync(target, "utf8")).toBe(script("0.1.0"));
  expect(readdirSync(join(target, ".."))).toEqual(["kerstel"]);
});

test("a download that redirects to plain http is refused, and nothing is installed", async () => {
  const target = installedBinary("0.1.0");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(null, { status: 302, headers: { location: "http://mirror.example.invalid/kerstel" } }),
  });
  servers.push(server);
  const base = `http://user:hunter2@127.0.0.1:${server.port}`;
  const source: ReleaseSource = {
    latestVersion: async () => "0.2.0",
    assetUrl: (version, asset) => `${base}/v${version}/${asset}`,
    checksumsUrl: (version) => `${base}/v${version}/SHA256SUMS`,
  };
  await expect(
    performUpdate({ source, currentVersion: "0.1.0", targetPath: target, asset: ASSET }),
  ).rejects.toThrow(/https/);
  const error = await performUpdate({ source, currentVersion: "0.1.0", targetPath: target, asset: ASSET }).catch(
    (e: Error) => e,
  );
  expect(String(error)).not.toContain("hunter2");
  expect(readFileSync(target, "utf8")).toContain("0.1.0");
});
