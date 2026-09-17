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

async function powershell(
  script: string,
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], stdin);
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
    // The sealed blob is read from stdin, never interpolated into the script
    // text, so no key material (sealed or otherwise) ever appears on the
    // command line or in a PowerShell error's echoed source line.
    const res = await powershell(
      "Add-Type -AssemblyName System.Security; " +
        "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
        "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); " +
        "[Convert]::ToBase64String($p)",
      `${sealed}\n`,
    );
    if (res.code !== 0) return null;
    const key = Buffer.from(res.stdout.trim(), "base64");
    return key.length === 32 ? key : null;
  },

  async set(key: Buffer): Promise<void> {
    ensureHome();
    // Same stdin-only rule as get(): the raw data key is piped in via stdin
    // and read with [Console]::In.ReadToEnd(), so it never appears as a
    // command-line argument (visible to Get-Process/Task Manager/WMI/ETW) and
    // never appears in the "At line:1 char:NN + ..." source echo PowerShell
    // prints when a non-interactive command throws.
    const res = await powershell(
      "Add-Type -AssemblyName System.Security; " +
        "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
        "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); " +
        "[Convert]::ToBase64String($p)",
      `${key.toString("base64")}\n`,
    );
    if (res.code !== 0) throw new Error(`DPAPI seal failed: ${res.stderr.trim()}`);
    writeFileSync(blobFile(), res.stdout.trim(), { encoding: "utf8", mode: 0o600 });
  },

  async delete(): Promise<void> {
    rmSync(blobFile(), { force: true });
  },
};
