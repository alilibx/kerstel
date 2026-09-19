import { versionFromReleaseUrl } from "./versions";

/**
 * Where releases come from. An interface so the installer and the checks are
 * tested against a local server, while the CLI talks to GitHub Releases.
 */
export interface ReleaseSource {
  /** The newest release's version, or null when it could not be determined. */
  latestVersion(): Promise<string | null>;
  assetUrl(version: string, asset: string): string;
  checksumsUrl(version: string): string;
}

export const KERSTEL_REPO_URL = "https://github.com/alilibx/kerstel";

export interface GitHubReleasesOptions {
  /** The repository page. Defaults to KERSTEL_RELEASES_URL when set, else the Kerstel repository. */
  baseUrl?: string;
  /** How long the latest-version lookup may take before it counts as unreachable. */
  timeoutMs?: number;
}

/**
 * GitHub Releases, read the same way `install.sh` reads them: the
 * `/releases/latest` page redirects to `/releases/tag/v<version>`, so one
 * request with redirects left unfollowed names the version. No API, no
 * token, no rate limit, and no JSON to parse.
 */
export function githubReleases(options: GitHubReleasesOptions = {}): ReleaseSource {
  // KERSTEL_RELEASES_URL exists for the test suite and for anyone mirroring
  // the releases: it is the only way `doctor` and `--version` are kept off
  // github.com, since neither has a flag for it.
  const base = (options.baseUrl ?? process.env.KERSTEL_RELEASES_URL ?? KERSTEL_REPO_URL).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 3000;
  return {
    async latestVersion() {
      try {
        const response = await fetch(`${base}/releases/latest`, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        return versionFromReleaseUrl(response.headers.get("location"));
      } catch {
        // Offline, DNS failure, timeout, or a refused connection: all of them
        // mean "could not check", never an error the caller has to handle.
        return null;
      }
    },
    assetUrl(version, asset) {
      return `${base}/releases/download/v${version}/${asset}`;
    },
    checksumsUrl(version) {
      return `${base}/releases/download/v${version}/SHA256SUMS`;
    },
  };
}
