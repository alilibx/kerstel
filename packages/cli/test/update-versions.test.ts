import { expect, test } from "bun:test";
import { assetName, compareVersions, versionFromReleaseUrl } from "../src/update/versions";

test("compareVersions orders by major, minor, then patch", () => {
  expect(compareVersions("0.1.0", "0.1.1")).toBe(-1);
  expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
  expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
  expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
});

test("versionFromReleaseUrl reads the tag from GitHub's /releases/latest redirect", () => {
  expect(versionFromReleaseUrl("https://github.com/alilibx/kerstel/releases/tag/v0.1.1")).toBe("0.1.1");
  expect(versionFromReleaseUrl("/releases/tag/v10.2.3")).toBe("10.2.3");
});

test("versionFromReleaseUrl rejects anything that isn't a release tag", () => {
  expect(versionFromReleaseUrl("https://github.com/alilibx/kerstel/releases")).toBeNull();
  expect(versionFromReleaseUrl("https://github.com/alilibx/kerstel/releases/tag/v0.1.1-rc.1")).toBeNull();
  expect(versionFromReleaseUrl("")).toBeNull();
  expect(versionFromReleaseUrl(null)).toBeNull();
});

test("assetName matches the release workflow's file names", () => {
  expect(assetName("darwin", "arm64")).toBe("kerstel-darwin-arm64");
  expect(assetName("darwin", "x64")).toBe("kerstel-darwin-x64");
  expect(assetName("linux", "x64")).toBe("kerstel-linux-x64");
  expect(assetName("linux", "arm64")).toBe("kerstel-linux-arm64");
});

test("assetName is null on a platform without a release binary", () => {
  expect(assetName("win32", "x64")).toBeNull();
  expect(assetName("linux", "ia32")).toBeNull();
});
