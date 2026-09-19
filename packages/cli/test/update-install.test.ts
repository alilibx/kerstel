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
}

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
      if (path.endsWith(`/${ASSET}`) && !release.missingAsset) return new Response(body);
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
