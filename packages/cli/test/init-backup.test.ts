import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupTimestamp, createBackup, listBackups, restoreBackup } from "../src/init/backup";
import { backupsDir } from "../src/paths";
import { generateDataKey } from "../src/vault/crypto";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

// Restore targets are created directly with mkdtempSync (isolateEnv only
// isolates KERSTEL_HOME), so they are tracked and removed the same way
// init-detect.test.ts tracks `createdRoots` -- otherwise every run leaves
// fresh directories behind in the OS temp dir.
const createdDirs: string[] = [];

function restoreTarget(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  restoreEnv();
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const FILES = [
  { name: ".env", contents: "OPENAI_API_KEY=sk-PLAINTEXT-CANARY\n# a comment\n" },
  { name: ".env.local", contents: "DATABASE_URL=postgres://u:PLAINTEXT-PW@localhost/db\n" },
];

test("backupTimestamp is filesystem-safe", () => {
  const stamp = backupTimestamp(new Date("2026-09-18T11:22:33.444Z"));
  expect(stamp).toBe("2026-09-18T11-22-33.444Z");
  expect(stamp).not.toContain(":");
});

test("createBackup then restoreBackup round-trips the originals", () => {
  isolateEnv({ prefix: "backup" });
  const key = generateDataKey();

  const result = createBackup({ scope: "my-app", dataKey: key, files: FILES });
  expect(result.files.map((f) => f.name)).toEqual([".env", ".env.local"]);
  expect(result.dir).toBe(join(backupsDir(), "my-app", result.timestamp));

  const target = restoreTarget("kerstel-restore-");
  const written = restoreBackup("my-app", result.timestamp, target, key);
  expect(written.sort()).toEqual([join(target, ".env"), join(target, ".env.local")].sort());
  for (const file of FILES) {
    expect(readFileSync(join(target, file.name), "utf8")).toBe(file.contents);
  }
});

test("nothing on disk holds the plaintext", () => {
  isolateEnv({ prefix: "backup-enc" });
  const result = createBackup({ scope: "my-app", dataKey: generateDataKey(), files: FILES });

  for (const name of readdirSync(result.dir)) {
    const raw = readFileSync(join(result.dir, name));
    expect(raw.includes(Buffer.from("PLAINTEXT-CANARY"))).toBe(false);
    expect(raw.includes(Buffer.from("PLAINTEXT-PW"))).toBe(false);
  }
});

test("the manifest records sizes and hashes, never contents", () => {
  isolateEnv({ prefix: "backup-manifest" });
  const result = createBackup({ scope: "my-app", dataKey: generateDataKey(), files: FILES });

  const manifest = JSON.parse(readFileSync(join(result.dir, "manifest.json"), "utf8")) as {
    version: number;
    scope: string;
    files: { name: string; bytes: number; sha256: string }[];
  };
  expect(manifest.version).toBe(1);
  expect(manifest.scope).toBe("my-app");
  expect(manifest.files[0]?.name).toBe(".env");
  expect(manifest.files[0]?.bytes).toBe(Buffer.byteLength(FILES[0]!.contents));
  expect(manifest.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("restoring with the wrong key fails instead of writing garbage", () => {
  isolateEnv({ prefix: "backup-wrongkey" });
  const result = createBackup({ scope: "my-app", dataKey: generateDataKey(), files: FILES });
  const target = restoreTarget("kerstel-restore-bad-");
  expect(() => restoreBackup("my-app", result.timestamp, target, generateDataKey())).toThrow();
  expect(readdirSync(target)).toEqual([]);
});

test("listBackups returns this scope's timestamps, oldest first", () => {
  isolateEnv({ prefix: "backup-list" });
  const key = generateDataKey();
  createBackup({ scope: "my-app", dataKey: key, files: FILES, timestamp: "2026-01-01T00-00-00.000Z" });
  createBackup({ scope: "my-app", dataKey: key, files: FILES, timestamp: "2026-02-01T00-00-00.000Z" });
  createBackup({ scope: "other", dataKey: key, files: FILES, timestamp: "2026-03-01T00-00-00.000Z" });

  expect(listBackups("my-app")).toEqual(["2026-01-01T00-00-00.000Z", "2026-02-01T00-00-00.000Z"]);
  expect(listBackups("nobody")).toEqual([]);
});

test.if(process.platform !== "win32")("backups are owner-only", () => {
  isolateEnv({ prefix: "backup-perms" });
  const result = createBackup({ scope: "my-app", dataKey: generateDataKey(), files: FILES });

  expect(statSync(result.dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(result.dir, ".env.enc")).mode & 0o777).toBe(0o600);
  expect(statSync(join(result.dir, "manifest.json")).mode & 0o777).toBe(0o600);
});
