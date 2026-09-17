import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ensureHome, tokenPath } from "../paths";

export function createToken(): string {
  return randomBytes(32).toString("base64url");
}

export function readToken(): string | null {
  const file = tokenPath();
  if (!existsSync(file)) return null;
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
