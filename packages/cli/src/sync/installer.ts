import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { KERSTEL_REPO_URL, isSafeReleaseUrl } from "../update/release-source";
// Embedded into the compiled binary like the hook assets: the import is a path
// (virtual under /$bunfs/ when compiled, the real file from source).
import installerAsset from "../../../server/install/kerstel-server.sh" with { type: "file" };

/** The installer `kerstel-server.sh` this binary was built with. */
export function installerScript(): string {
  return readFileSync(installerAsset, "utf8");
}

/** SHA-256 of the embedded installer, lowercase hex. */
export function installerSha256(): string {
  // The raw bytes, as the host hashes the downloaded file.
  return createHash("sha256").update(readFileSync(installerAsset)).digest("hex");
}

/** `'…'`, with each embedded `'` written as `'\''`. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The value bare when it has nothing the shell would interpret, else quoted. */
function quoteIfNeeded(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : quote(value);
}

export interface ManualCommandFor {
  url: string;
  sha256: string;
  args: string[];
}

/**
 * One line to paste on a server host: download the installer into a private
 * file, check its SHA-256, and only then run that same file.
 *
 * The file comes from `mktemp` (a fresh name, mode 0600), so no other user can
 * plant or swap it between the check and the run. The whole line is a subshell
 * with an EXIT trap: the file is removed however the line ends, and the
 * subshell's exit status is the failing step's, which `; rm -f` after the
 * chain would have masked. It behaves the same pasted into sh, bash or zsh.
 * `sha256sum` (Linux) and `shasum` (macOS) both print `<hash>  -` for stdin.
 */
export function manualCommandFor(o: ManualCommandFor): string {
  if (o.args.some((arg) => /[\r\n]/.test(arg))) {
    throw new Error("A command argument cannot contain a line break.");
  }
  const args = o.args.map(quote).join(" ");
  return (
    `(f=$(mktemp) && trap 'rm -f "$f"' EXIT` +
    ` && curl -fsSL ${quoteIfNeeded(o.url)} -o "$f"` +
    ` && (sha256sum 2>/dev/null || shasum -a 256) < "$f" | grep -q '^${o.sha256} '` +
    ` && sh "$f"${args ? ` ${args}` : ""})`
  );
}

/**
 * Where the release matching `version` publishes `kerstel-server.sh`: under
 * `releasesUrl`, else `KERSTEL_RELEASES_URL`, else the Kerstel repository.
 */
export function installerReleaseUrl(version: string, releasesUrl?: string): string {
  const base = (releasesUrl ?? process.env.KERSTEL_RELEASES_URL ?? KERSTEL_REPO_URL).replace(/\/$/, "");
  if (!isSafeReleaseUrl(base)) {
    throw new Error("The release URL must be https://, or http:// to this machine.");
  }
  return `${base}/releases/download/v${version}/kerstel-server.sh`;
}

/** The paste-able command for the release matching `version`. */
export function manualCommand(o: {
  version: string;
  args: string[];
  releasesUrl?: string;
}): string {
  return manualCommandFor({
    url: installerReleaseUrl(o.version, o.releasesUrl),
    sha256: installerSha256(),
    args: o.args,
  });
}
