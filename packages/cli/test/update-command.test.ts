import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateCommand, versionCommand, versionStatusLine } from "../src/commands/update";
import type { ReleaseSource } from "../src/update/release-source";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

let captured: string[] = [];
const realLog = console.log;
const dirs: string[] = [];

function capture(): void {
  captured = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
}

afterEach(() => {
  console.log = realLog;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  restoreEnv();
});

function fakeBinary(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-update-cmd-"));
  dirs.push(dir);
  const path = join(dir, "kerstel");
  writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A release whose only asset is a script reporting `latest`. */
function release(latest: string | null): ReleaseSource {
  const body = `#!/bin/sh\necho ${latest}\n`;
  const sum = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (req.url.endsWith("/SHA256SUMS")) return new Response(`${sum}  kerstel-test\n`);
      return new Response(body);
    },
  });
  dirs.push(mkdtempSync(join(tmpdir(), "kerstel-update-cmd-server-")));
  const base = `http://127.0.0.1:${server.port}`;
  return {
    latestVersion: async () => latest,
    assetUrl: (v, a) => `${base}/v${v}/${a}`,
    checksumsUrl: (v) => `${base}/v${v}/SHA256SUMS`,
  };
}

function deps(latest: string | null, target: string, compiled = true) {
  return {
    source: release(latest),
    targetPath: target,
    asset: "kerstel-test",
    compiled,
    currentVersion: "0.1.0",
    stopDaemon: async () => false,
  };
}

test("update says so when already on the latest release", async () => {
  isolateEnv({ prefix: "update-cmd" });
  capture();
  const code = await updateCommand([], deps("0.1.0", fakeBinary("0.1.0")));
  expect(code).toBe(0);
  expect(captured.join("\n")).toContain("kerstel 0.1.0 is up to date");
});

test("update installs the newer release and names both versions", async () => {
  isolateEnv({ prefix: "update-cmd" });
  const target = fakeBinary("0.1.0");
  capture();
  const code = await updateCommand([], deps("0.1.1", target));
  expect(code).toBe(0);
  expect(captured.join("\n")).toContain("Updated kerstel from 0.1.0 to 0.1.1");
  expect(readFileSync(target, "utf8")).toContain("echo 0.1.1");
});

test("update still exits 0 when the old daemon cannot be stopped after the swap", async () => {
  isolateEnv({ prefix: "update-cmd" });
  const target = fakeBinary("0.1.0");
  capture();
  const code = await updateCommand([], {
    ...deps("0.1.1", target),
    stopDaemon: async () => {
      throw new Error("token mismatch");
    },
  });
  expect(code).toBe(0);
  expect(captured.join("\n")).toContain("Updated kerstel from 0.1.0 to 0.1.1");
  expect(captured.join("\n")).toMatch(/daemon.*token mismatch/);
  expect(captured.join("\n")).toContain("daemon stop");
  expect(readFileSync(target, "utf8")).toContain("echo 0.1.1");
});

test("update says when it stopped the old daemon", async () => {
  isolateEnv({ prefix: "update-cmd" });
  capture();
  const code = await updateCommand([], { ...deps("0.1.1", fakeBinary("0.1.0")), stopDaemon: async () => true });
  expect(code).toBe(0);
  expect(captured.join("\n")).toMatch(/Stopped the resolver daemon/);
});

test("a failed update surfaces as an error naming that nothing was installed", async () => {
  isolateEnv({ prefix: "update-cmd" });
  const target = fakeBinary("0.1.0");
  const source = release("0.1.1");
  const badSource: ReleaseSource = { ...source, checksumsUrl: (v) => source.assetUrl(v, "not-a-checksum-file") };
  await expect(updateCommand([], { ...deps("0.1.1", target), source: badSource })).rejects.toThrow(
    /nothing was installed/,
  );
  expect(readFileSync(target, "utf8")).toContain("echo 0.1.0");
});

test("update --check reports the newer release without installing it", async () => {
  isolateEnv({ prefix: "update-cmd" });
  const target = fakeBinary("0.1.0");
  capture();
  const code = await updateCommand(["--check"], deps("0.1.1", target));
  expect(code).toBe(0);
  expect(captured.join("\n")).toContain("kerstel 0.1.1 is available");
  expect(captured.join("\n")).toContain("update");
  expect(readFileSync(target, "utf8")).toContain("echo 0.1.0");
});

test("update exits 1 when the release page is unreachable", async () => {
  isolateEnv({ prefix: "update-cmd" });
  capture();
  const code = await updateCommand([], deps(null, fakeBinary("0.1.0")));
  expect(code).toBe(1);
  expect(captured.join("\n")).toMatch(/could not reach github\.com/i);
});

test("update refuses to install when running from source, but --check still works", async () => {
  isolateEnv({ prefix: "update-cmd" });
  const target = fakeBinary("0.1.0");
  capture();
  expect(await updateCommand([], deps("0.1.1", target, false))).toBe(1);
  expect(captured.join("\n")).toMatch(/running from source/i);
  expect(readFileSync(target, "utf8")).toContain("echo 0.1.0");

  capture();
  expect(await updateCommand(["--check"], deps("0.1.1", target, false))).toBe(0);
  expect(captured.join("\n")).toContain("kerstel 0.1.1 is available");
});

test("update rejects unknown options with exit 2", async () => {
  isolateEnv({ prefix: "update-cmd" });
  capture();
  expect(await updateCommand(["--force"], deps("0.1.1", fakeBinary("0.1.0")))).toBe(2);
  expect(captured.join("\n")).toContain("--check");
});

test("versionStatusLine tells the user whether to update", () => {
  expect(versionStatusLine("0.1.0", "0.1.0", "kerstel")).toBe("Up to date.");
  expect(versionStatusLine("0.1.0", "0.1.1", "ks")).toBe("0.1.1 is available. Run ks update.");
  expect(versionStatusLine("0.1.0", null, "kerstel")).toBe("Could not check for updates.");
});

test("version prints only the version when stdout is not a terminal, and never checks", async () => {
  let checked = 0;
  const source: ReleaseSource = {
    latestVersion: async () => {
      checked++;
      return "0.1.1";
    },
    assetUrl: () => "",
    checksumsUrl: () => "",
  };
  capture();
  const errors: string[] = [];
  const stderr = (text: string) => errors.push(text);
  expect(await versionCommand({ isTTY: false, source, currentVersion: "0.1.0", cli: "kerstel", stderr })).toBe(0);
  expect(captured).toEqual(["0.1.0"]);
  expect(errors).toEqual([]);
  expect(checked).toBe(0);
});

test("version on a terminal adds the update status on stderr, keeping stdout bare", async () => {
  const source: ReleaseSource = {
    latestVersion: async () => "0.1.1",
    assetUrl: () => "",
    checksumsUrl: () => "",
  };
  capture();
  const errors: string[] = [];
  const stderr = (text: string) => errors.push(text);
  expect(await versionCommand({ isTTY: true, source, currentVersion: "0.1.0", cli: "ks", stderr })).toBe(0);
  expect(captured).toEqual(["0.1.0"]);
  // Plain text: the caller styles it for its own stream, so stdout's colour
  // detection never leaks escape codes into a redirected stderr.
  expect(errors).toEqual(["0.1.1 is available. Run ks update."]);
});
