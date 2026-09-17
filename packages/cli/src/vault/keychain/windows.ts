import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, kerstelHome } from "../../paths";
import { run } from "./exec";
import type { KeychainBackend } from "./types";

/**
 * Windows Credential Manager cannot read a secret back from the command line,
 * so the key is sealed with DPAPI (CurrentUser scope) through PowerShell and the
 * sealed blob is stored in the Kerstel home. Only this Windows user account can
 * unseal it, so the blob is useless if copied off the machine.
 */
function blobFile(): string {
  return join(kerstelHome(), "vault.key.dpapi");
}

async function powershell(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script]);
}

export const windowsBackend: KeychainBackend = {
  name: "windows",

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    const res = await powershell(
      "Add-Type -AssemblyName System.Security; 'ok'",
    );
    return res.code === 0 && res.stdout.includes("ok");
  },

  async get(): Promise<Buffer | null> {
    if (!existsSync(blobFile())) return null;
    const sealed = readFileSync(blobFile(), "utf8").trim();
    const res = await powershell(
      "Add-Type -AssemblyName System.Security; " +
        `$b=[Convert]::FromBase64String('${sealed}'); ` +
        "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); " +
        "[Convert]::ToBase64String($p)",
    );
    if (res.code !== 0) return null;
    const key = Buffer.from(res.stdout.trim(), "base64");
    return key.length === 32 ? key : null;
  },

  async set(key: Buffer): Promise<void> {
    ensureHome();
    const res = await powershell(
      "Add-Type -AssemblyName System.Security; " +
        `$b=[Convert]::FromBase64String('${key.toString("base64")}'); ` +
        "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); " +
        "[Convert]::ToBase64String($p)",
    );
    if (res.code !== 0) throw new Error(`DPAPI seal failed: ${res.stderr.trim()}`);
    writeFileSync(blobFile(), res.stdout.trim(), { encoding: "utf8", mode: 0o600 });
  },

  async delete(): Promise<void> {
    rmSync(blobFile(), { force: true });
  },
};
