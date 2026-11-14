import { yellow } from "../output";
import { isSafeReleaseUrl } from "../update/release-source";

/**
 * What the setup wizard and `ks sync server` share about running
 * `kerstel-server.sh`: its exit codes, the release source it downloads from,
 * and how they word what it found.
 */

/** The installer's exit code when the host runs a server another device set up. */
export const ANOTHER_DEVICES_SERVER = 3;

/** The installer's exit code when Docker is installed on the host but could not be checked, so a server may run in it. */
export const DOCKER_UNCHECKED = 4;

/** For the installer's exit 4 or `installed=unknown`. `next` says what to do once Docker and sudo work. */
export const DOCKER_NOT_CHECKED = (where: string, next: string): string =>
  `Could not check Docker on ${where} for a Kerstel server, so nothing was changed there. ` +
  `Check that Docker runs there and that sudo works, then ${next}.`;

export const warn = (message: string): void => console.log(yellow(`!  ${message}`));

/** The host of a server URL, without IPv6 brackets, in lower case. */
export function hostOfUrl(url: string): string {
  return new URL(url).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

/** The release source the installer downloads from, when KERSTEL_RELEASES_URL sets one, or a message when it can't be used. */
export function releasesUrl(): { url: string | null } | { error: string } {
  const url = process.env.KERSTEL_RELEASES_URL || null;
  if (url !== null && !isSafeReleaseUrl(url)) return { error: "KERSTEL_RELEASES_URL must be https://, or http:// to this machine." };
  return { url };
}
