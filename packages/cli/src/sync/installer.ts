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
  return sha256(installerScript());
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `'…'`, with each embedded `'` written as `'\''`. */
function quote(value: string): string {
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
  tmpPath: string;
}

/**
 * One line to paste on a server host: download the installer, check its
 * SHA-256, and only then run it. `sha256sum` (Linux) and `shasum` (macOS)
 * both print `<hash>  -` for stdin.
 */
export function manualCommandFor(o: ManualCommandFor): string {
  const tmp = quoteIfNeeded(o.tmpPath);
  const args = o.args.map(quote).join(" ");
  return (
    `curl -fsSL ${quoteIfNeeded(o.url)} -o ${tmp}` +
    ` && (sha256sum 2>/dev/null || shasum -a 256) < ${tmp} | grep -q '^${o.sha256} '` +
    ` && sh ${tmp}${args ? ` ${args}` : ""}`
  );
}

/** The paste-able command for the release matching `version`. */
export function manualCommand(o: {
  version: string;
  args: string[];
  releasesUrl?: string;
  tmpPath?: string;
}): string {
  const base = (o.releasesUrl ?? process.env.KERSTEL_RELEASES_URL ?? KERSTEL_REPO_URL).replace(/\/$/, "");
  if (!isSafeReleaseUrl(base)) {
    throw new Error("The release URL must be https://, or http:// to this machine.");
  }
  return manualCommandFor({
    url: `${base}/releases/download/v${o.version}/kerstel-server.sh`,
    sha256: installerSha256(),
    args: o.args,
    tmpPath: o.tmpPath ?? "/tmp/kerstel-server.sh",
  });
}
