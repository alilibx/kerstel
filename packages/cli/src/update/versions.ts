/**
 * Pure helpers behind the update check: how a version is compared, how the
 * latest one is read off GitHub, and which release asset this machine runs.
 * No I/O here, so every rule is unit-tested against plain strings.
 */

/** -1, 0, or 1, comparing MAJOR.MINOR.PATCH numerically. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

/**
 * `https://github.com/<owner>/<repo>/releases/latest` answers with a redirect
 * to `.../releases/tag/v<version>`. That Location is the only thing the check
 * needs: no API, no token, no rate limit. Pre-releases never appear there,
 * and a tag with a suffix is rejected anyway so the compare stays numeric.
 */
export function versionFromReleaseUrl(location: string | null): string | null {
  if (!location) return null;
  const match = /\/releases\/tag\/v(\d+\.\d+\.\d+)$/.exec(location);
  return match ? match[1]! : null;
}

/** The asset the release workflow publishes for this platform, or null when it publishes none. */
export function assetName(platform: NodeJS.Platform, arch: NodeJS.Architecture): string | null {
  if (platform !== "darwin" && platform !== "linux") return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  return `kerstel-${platform}-${arch}`;
}
