import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ensureHome, tokenPath } from "../paths";

export function createToken(): string {
  return randomBytes(32).toString("base64url");
}

export function readToken(): string | null {
  const file = tokenPath();
  if (!existsSync(file)) return null;
  // Re-asserted on every read, not only at write time. This token IS the
  // access boundary -- anyone who can read it can ask the daemon for every
  // secret in the vault -- and writeFileSync's `mode` applies only when it
  // creates the file. A token written by an older build, restored from a
  // backup, or copied with `cp` keeps whatever mode it arrived with, and
  // nothing else would ever notice.
  if (process.platform !== "win32") chmodSync(file, 0o600);
  const token = readFileSync(file, "utf8").trim();
  return token.length > 0 ? token : null;
}

export function writeToken(token: string): string {
  ensureHome();
  writeFileSync(tokenPath(), token, { encoding: "utf8", mode: 0o600 });
  return token;
}

export function clearToken(): void {
  rmSync(tokenPath(), { force: true });
}

/** Returns the existing session token, creating one when absent. */
export function ensureToken(): string {
  return readToken() ?? writeToken(createToken());
}

/** Length-safe, timing-safe comparison. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
