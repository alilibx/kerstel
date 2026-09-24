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
  /** Why this source refuses to be used, naming the variable to fix; null when it is fine. */
  readonly problem?: string | null;
  /** The override's base when releases come from somewhere other than GitHub; null for the default. */
  readonly mirror?: string | null;
}

export const KERSTEL_REPO_URL = "https://github.com/alilibx/kerstel";

/** Loopback hosts: no one sits on the path between a process and its own machine. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether a URL is safe to fetch a release from: `https://`, or `http://` to
 * this machine (the test suite serves releases on 127.0.0.1). Over plain HTTP
 * anywhere else, the same origin serves the binary and its SHA256SUMS, so
 * anyone on the path can swap both and the checksum still matches.
 */
export function isSafeReleaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * Why `base`, read from `variable`, cannot be used, or null when it can. The
 * message names the variable but never echoes the URL, which may carry a
 * mirror's credentials.
 */
export function releaseBaseProblem(base: string, variable: string): string | null {
  if (isSafeReleaseUrl(base)) return null;
  return (
    `${variable} must be an https:// URL. Kerstel will not download releases over plain HTTP or another ` +
    "scheme, where anyone on the network path could replace the binary and its checksum together."
  );
}

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
  const override = options.baseUrl ?? process.env.KERSTEL_RELEASES_URL;
  const base = (override ?? KERSTEL_REPO_URL).replace(/\/$/, "");
  const problem = releaseBaseProblem(base, options.baseUrl !== undefined ? "The release URL" : "KERSTEL_RELEASES_URL");
  const timeoutMs = options.timeoutMs ?? 3000;
  return {
    problem,
    mirror: override === undefined || base === KERSTEL_REPO_URL ? null : base,
    async latestVersion() {
      // Refused, not attempted: the request itself would go over plain HTTP.
      if (problem) return null;
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
