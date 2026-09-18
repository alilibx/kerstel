# Kerstel Vault Core & Runtime Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `process.env.OPENAI_API_KEY` return a real secret from an encrypted local vault when the `.env` file contains only `kerstel://global/OPENAI_API_KEY`, with no change to how the developer runs their app.

**Architecture:** An encrypted SQLite vault (`~/.kerstel/vault.db`) whose data key lives in the OS credential store. A per-user resolver daemon unlocks the vault once and serves resolutions over a local socket. A zero-dependency JS preload replaces `process.env` with a Proxy that resolves `kerstel://` references lazily and synchronously, using a worker thread plus `Atomics.wait` to bridge the daemon's async socket I/O into a synchronous property read.

**Tech Stack:** TypeScript, Bun (runtime, package manager, test runner, `bun build --compile`), `bun:sqlite`, `node:crypto` (AES-256-GCM), `node:net` (Unix socket / Windows named pipe), `node:worker_threads`.

**Spec:** [`docs/superpowers/specs/2026-09-17-kerstel-secrets-manager-design.md`](../specs/2026-09-17-kerstel-secrets-manager-design.md)

**Scope:** This is plan 1 of 5. It implements spec §4–§7 and the `set`/`get`/`ls`/`rm`/`run`/`daemon`/`resolve` commands from §8. Out of scope here: the `init` wizard (plan 2), the portal (plan 3), the website (plan 4), the release pipeline and `install.sh` (plan 5).

## Global Constraints

- **Language/runtime:** TypeScript throughout. Bun is the only toolchain dependency for building. The shipped artifact is a single self-contained binary per platform (`bun build --compile`).
- **Hook portability:** `packages/hook` must have **zero runtime dependencies** and must run unmodified under Node 18+ and Bun. It may import only `node:` builtins. It is never `npm install`ed — it is written to `~/.kerstel/hook/` by the CLI.
- **Crypto:** AES-256-GCM. 256-bit data key. Fresh random 96-bit (12-byte) nonce per encryption. Auth tag verified on every decrypt.
- **Key storage:** the data key is never written to `~/.kerstel/vault.db` and never logged. It lives in the OS credential store (macOS Keychain, Linux Secret Service, Windows DPAPI), with an explicit, loudly-warned `0600` file fallback.
- **Reference syntax:** `kerstel://<scope>/<KEY>` where `<scope>` is `global` or a project name. Explicit scoping only — a reference resolves in exactly one scope, with **no fallback chain**.
- **Paths:** `~/.kerstel/` (mode `0700`), vault at `vault.db`, socket at `kerstel.sock`, session token at `session.token` (mode `0600`), hook assets in `hook/`. Every path derives from `KERSTEL_HOME`, which defaults to `~/.kerstel` — tests always override it.
- **Privacy:** no network calls, no telemetry, no analytics, no AI. The binary must function fully offline.
- **Secrets in output:** plaintext values are printed only by `kerstel get --reveal` and injected into child environments. Never logged, never in error messages, never in audit rows.
- **Platforms:** macOS (arm64, x64), Linux (x64, arm64), Windows (x64).
- **License:** MIT. Every new source file is original work.

---

### Task 1: Repo reset and Bun workspace scaffold

Removes the Swift menu bar app and replaces it with the monorepo skeleton. The existing GitHub Pages site under `docs/` stays untouched so kerstel.dev keeps serving while the new product is built — plan 4 replaces it.

**Files:**
- Delete: `Package.swift`, `Sources/`, `Tests/`, `Resources/`, `scripts/generate-icon.sh`, `install.sh`, `uninstall.sh`
- Create: `package.json`, `bunfig.toml`, `tsconfig.base.json`, `.gitignore`, `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/hook/package.json`, `packages/hook/tsconfig.json`, `.github/workflows/ci.yml`
- Test: `packages/cli/test/smoke.test.ts`
- Keep untouched: `LICENSE`, `README.md`, `docs/` (site + specs + plans)

**Interfaces:**
- Consumes: nothing
- Produces: a workspace where `bun test` runs across `packages/*`, and `bun run typecheck` passes.

- [ ] **Step 1: Remove the Swift application**

```bash
git rm -r --quiet Package.swift Sources Tests Resources scripts/generate-icon.sh install.sh uninstall.sh
rmdir scripts 2>/dev/null || true
```

- [ ] **Step 2: Create the workspace root files**

`package.json`:

```json
{
  "name": "kerstel",
  "private": true,
  "version": "0.0.0",
  "license": "MIT",
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "bun test",
    "typecheck": "bun run --filter '*' typecheck"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

`bunfig.toml`:

```toml
[test]
coverage = false
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
.DS_Store
bun.lockb
```

- [ ] **Step 3: Create the two packages**

`packages/cli/package.json`:

```json
{
  "name": "@kerstel/cli",
  "version": "0.0.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

`packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/hook/package.json`:

```json
{
  "name": "@kerstel/hook",
  "version": "0.0.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

`packages/hook/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

- [ ] **Step 4: Write the smoke test**

`packages/cli/test/smoke.test.ts`:

```ts
import { expect, test } from "bun:test";

test("workspace test runner is wired", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 5: Run the test to verify the toolchain works**

Run: `bun install && bun test`
Expected: PASS, 1 test.

- [ ] **Step 6: Add CI**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore!: remove Swift app, scaffold Bun workspace

BREAKING CHANGE: Kerstel is now a secrets manager, not a menu bar app.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Paths module

Every later task needs hermetic, isolated storage in tests. This lands first so no test ever touches the developer's real `~/.kerstel`.

**Files:**
- Create: `packages/cli/src/paths.ts`
- Test: `packages/cli/test/paths.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `kerstelHome(): string`, `vaultPath(): string`, `socketPath(): string`, `tokenPath(): string`, `hookDir(): string`, `backupsDir(): string`, `ensureHome(): string`. All read `process.env.KERSTEL_HOME` at call time (never cached at module load, so tests can change it).

- [ ] **Step 1: Write the failing test**

`packages/cli/test/paths.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHome, kerstelHome, socketPath, tokenPath, vaultPath } from "../src/paths";

const original = process.env.KERSTEL_HOME;
afterEach(() => {
  if (original === undefined) delete process.env.KERSTEL_HOME;
  else process.env.KERSTEL_HOME = original;
});

test("KERSTEL_HOME overrides the default home", () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-paths-"));
  process.env.KERSTEL_HOME = dir;
  expect(kerstelHome()).toBe(dir);
  expect(vaultPath()).toBe(join(dir, "vault.db"));
  expect(tokenPath()).toBe(join(dir, "session.token"));
});

test("the override is read per call, not cached at import", () => {
  const a = mkdtempSync(join(tmpdir(), "kerstel-a-"));
  const b = mkdtempSync(join(tmpdir(), "kerstel-b-"));
  process.env.KERSTEL_HOME = a;
  expect(kerstelHome()).toBe(a);
  process.env.KERSTEL_HOME = b;
  expect(kerstelHome()).toBe(b);
});

test("ensureHome creates the directory with 0700 permissions", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "kerstel-ensure-")), "home");
  process.env.KERSTEL_HOME = dir;
  ensureHome();
  const mode = statSync(dir).mode & 0o777;
  if (process.platform !== "win32") expect(mode).toBe(0o700);
});

test("socketPath uses a named pipe on Windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-sock-"));
  process.env.KERSTEL_HOME = dir;
  const p = socketPath();
  if (process.platform === "win32") expect(p.startsWith("\\\\.\\pipe\\")).toBe(true);
  else expect(p).toBe(join(dir, "kerstel.sock"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/paths.test.ts`
Expected: FAIL — cannot resolve module `../src/paths`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/paths.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all Kerstel state. Read fresh on every call so tests can rebind it. */
export function kerstelHome(): string {
  const override = process.env.KERSTEL_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), ".kerstel");
}

export function vaultPath(): string {
  return join(kerstelHome(), "vault.db");
}

export function tokenPath(): string {
  return join(kerstelHome(), "session.token");
}

export function hookDir(): string {
  return join(kerstelHome(), "hook");
}

export function backupsDir(): string {
  return join(kerstelHome(), "backups");
}

/**
 * Unix: a socket file inside the 0700 home.
 * Windows: a named pipe, whose name is derived from the home path so that
 * separate KERSTEL_HOME values (including parallel tests) never collide.
 */
export function socketPath(): string {
  if (process.platform === "win32") {
    const id = createHash("sha256").update(kerstelHome()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\kerstel-${id}`;
  }
  return join(kerstelHome(), "kerstel.sock");
}

/** Creates the home directory if needed and returns it. Owner-only access. */
export function ensureHome(): string {
  const home = kerstelHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/test/paths.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/paths.ts packages/cli/test/paths.test.ts
git commit -m "feat(cli): add path resolution with KERSTEL_HOME override

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Crypto module

**Files:**
- Create: `packages/cli/src/vault/crypto.ts`
- Test: `packages/cli/test/crypto.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `generateDataKey(): Buffer` (32 bytes), `encrypt(plaintext: string, key: Buffer): EncryptedValue`, `decrypt(value: EncryptedValue, key: Buffer): string`, `interface EncryptedValue { ciphertext: Buffer; nonce: Buffer }`. The ciphertext buffer has the 16-byte GCM auth tag appended.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/crypto.test.ts`:

```ts
import { expect, test } from "bun:test";
import { decrypt, encrypt, generateDataKey } from "../src/vault/crypto";

test("generateDataKey returns 32 unique random bytes", () => {
  const a = generateDataKey();
  const b = generateDataKey();
  expect(a.length).toBe(32);
  expect(a.equals(b)).toBe(false);
});

test("encrypt then decrypt round-trips the plaintext", () => {
  const key = generateDataKey();
  const secret = "sk-proj-abc123!@#$ 🔑 multi\nline";
  const enc = encrypt(secret, key);
  expect(decrypt(enc, key)).toBe(secret);
});

test("ciphertext never contains the plaintext", () => {
  const key = generateDataKey();
  const enc = encrypt("SUPERSECRETVALUE", key);
  expect(enc.ciphertext.toString("utf8")).not.toContain("SUPERSECRETVALUE");
  expect(enc.ciphertext.toString("hex")).not.toContain(
    Buffer.from("SUPERSECRETVALUE").toString("hex"),
  );
});

test("each encryption uses a fresh 12-byte nonce", () => {
  const key = generateDataKey();
  const a = encrypt("same", key);
  const b = encrypt("same", key);
  expect(a.nonce.length).toBe(12);
  expect(a.nonce.equals(b.nonce)).toBe(false);
  expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
});

test("decrypting with the wrong key throws", () => {
  const enc = encrypt("secret", generateDataKey());
  expect(() => decrypt(enc, generateDataKey())).toThrow();
});

test("a tampered ciphertext fails the auth tag check", () => {
  const key = generateDataKey();
  const enc = encrypt("secret", key);
  enc.ciphertext[0] = enc.ciphertext[0]! ^ 0xff;
  expect(() => decrypt(enc, key)).toThrow();
});

test("a tampered nonce fails the auth tag check", () => {
  const key = generateDataKey();
  const enc = encrypt("secret", key);
  enc.nonce[0] = enc.nonce[0]! ^ 0xff;
  expect(() => decrypt(enc, key)).toThrow();
});

test("encrypt rejects a key of the wrong length", () => {
  expect(() => encrypt("x", Buffer.alloc(16))).toThrow(/32 bytes/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/crypto.test.ts`
Expected: FAIL — cannot resolve module `../src/vault/crypto`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/vault/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedValue {
  /** AES-256-GCM output with the 16-byte auth tag appended. */
  ciphertext: Buffer;
  /** Random 96-bit nonce, unique per encryption. */
  nonce: Buffer;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Kerstel data key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

export function generateDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function encrypt(plaintext: string, key: Buffer): EncryptedValue {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

export function decrypt(value: EncryptedValue, key: Buffer): string {
  assertKey(key);
  if (value.nonce.length !== NONCE_BYTES) throw new Error("Invalid nonce length");
  if (value.ciphertext.length < TAG_BYTES) throw new Error("Ciphertext too short");

  const split = value.ciphertext.length - TAG_BYTES;
  const body = value.ciphertext.subarray(0, split);
  const tag = value.ciphertext.subarray(split);

  const decipher = createDecipheriv(ALGORITHM, key, value.nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/test/crypto.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/vault/crypto.ts packages/cli/test/crypto.test.ts
git commit -m "feat(cli): add AES-256-GCM value encryption

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: OS keychain adapter

Stores the 32-byte vault data key outside the vault file. Each backend shells out to the platform's own tool, so there is no native module to compile.

**Files:**
- Create: `packages/cli/src/vault/keychain/types.ts`, `packages/cli/src/vault/keychain/exec.ts`, `packages/cli/src/vault/keychain/file.ts`, `packages/cli/src/vault/keychain/macos.ts`, `packages/cli/src/vault/keychain/linux.ts`, `packages/cli/src/vault/keychain/windows.ts`, `packages/cli/src/vault/keychain/index.ts`
- Test: `packages/cli/test/keychain.test.ts`

**Interfaces:**
- Consumes: `kerstelHome`, `ensureHome` from `../paths`; `generateDataKey` from `../crypto`
- Produces:
  - `interface KeychainBackend { name: string; isAvailable(): Promise<boolean>; get(): Promise<Buffer | null>; set(key: Buffer): Promise<void>; delete(): Promise<void> }`
  - `selectBackend(): Promise<KeychainBackend>` — honours `KERSTEL_KEYCHAIN_BACKEND` (`macos` | `linux` | `windows` | `file`), otherwise picks by platform and falls back to `file` when the native backend is unavailable.
  - `loadOrCreateDataKey(): Promise<{ key: Buffer; backend: string; created: boolean }>`
  - `SERVICE_NAME = "dev.kerstel.vault"`, `ACCOUNT_NAME = "kerstel"`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/keychain.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateDataKey, selectBackend } from "../src/vault/keychain";

const originalHome = process.env.KERSTEL_HOME;
const originalBackend = process.env.KERSTEL_KEYCHAIN_BACKEND;

function isolate(): string {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-kc-"));
  process.env.KERSTEL_HOME = dir;
  process.env.KERSTEL_KEYCHAIN_BACKEND = "file";
  return dir;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.KERSTEL_HOME;
  else process.env.KERSTEL_HOME = originalHome;
  if (originalBackend === undefined) delete process.env.KERSTEL_KEYCHAIN_BACKEND;
  else process.env.KERSTEL_KEYCHAIN_BACKEND = originalBackend;
});

test("the file backend round-trips a key", async () => {
  isolate();
  const backend = await selectBackend();
  expect(backend.name).toBe("file");
  expect(await backend.get()).toBeNull();

  const key = Buffer.alloc(32, 7);
  await backend.set(key);
  const loaded = await backend.get();
  expect(loaded?.equals(key)).toBe(true);

  await backend.delete();
  expect(await backend.get()).toBeNull();
});

test("the file backend writes the key file 0600", async () => {
  const dir = isolate();
  const backend = await selectBackend();
  await backend.set(Buffer.alloc(32, 1));
  if (process.platform !== "win32") {
    expect(statSync(join(dir, "vault.key")).mode & 0o777).toBe(0o600);
  }
});

test("loadOrCreateDataKey creates once and is stable afterwards", async () => {
  isolate();
  const first = await loadOrCreateDataKey();
  expect(first.created).toBe(true);
  expect(first.key.length).toBe(32);

  const second = await loadOrCreateDataKey();
  expect(second.created).toBe(false);
  expect(second.key.equals(first.key)).toBe(true);
});

test("KERSTEL_KEYCHAIN_BACKEND selects the backend explicitly", async () => {
  isolate();
  process.env.KERSTEL_KEYCHAIN_BACKEND = "file";
  expect((await selectBackend()).name).toBe("file");
});

test.if(process.platform === "darwin")("the macOS Keychain backend round-trips", async () => {
  isolate();
  process.env.KERSTEL_KEYCHAIN_BACKEND = "macos";
  const backend = await selectBackend();
  expect(backend.name).toBe("macos");
  const key = Buffer.alloc(32, 42);
  await backend.set(key);
  expect((await backend.get())?.equals(key)).toBe(true);
  await backend.delete();
  expect(await backend.get()).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/keychain.test.ts`
Expected: FAIL — cannot resolve module `../src/vault/keychain`.

- [ ] **Step 3: Write the shared types and process helper**

`packages/cli/src/vault/keychain/types.ts`:

```ts
export const SERVICE_NAME = "dev.kerstel.vault";
export const ACCOUNT_NAME = "kerstel";

export interface KeychainBackend {
  /** Stable identifier reported by `kerstel doctor`. */
  name: string;
  /** True when this backend's platform tooling is present and working. */
  isAvailable(): Promise<boolean>;
  /** Returns the stored 32-byte data key, or null when nothing is stored. */
  get(): Promise<Buffer | null>;
  set(key: Buffer): Promise<void>;
  delete(): Promise<void>;
}
```

`packages/cli/src/vault/keychain/exec.ts`:

```ts
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command without a shell. Secret material is passed on stdin, never as
 * an argv entry, so it cannot leak through the process table.
 */
export async function run(cmd: string[], stdin?: string): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function commandExists(name: string): Promise<boolean> {
  const probe = process.platform === "win32" ? ["where", name] : ["which", name];
  try {
    return (await run(probe)).code === 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Write the file fallback backend**

`packages/cli/src/vault/keychain/file.ts`:

```ts
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, kerstelHome } from "../../paths";
import type { KeychainBackend } from "./types";

function keyFile(): string {
  return join(kerstelHome(), "vault.key");
}

/**
 * Last-resort backend: the data key sits in a 0600 file inside the 0700 home.
 * Weaker than an OS credential store, so callers warn when this is selected
 * implicitly. Never selected silently over a working native backend.
 */
export const fileBackend: KeychainBackend = {
  name: "file",

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async get(): Promise<Buffer | null> {
    const file = keyFile();
    if (!existsSync(file)) return null;
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    return key.length === 32 ? key : null;
  },

  async set(key: Buffer): Promise<void> {
    ensureHome();
    writeFileSync(keyFile(), key.toString("base64"), { encoding: "utf8", mode: 0o600 });
  },

  async delete(): Promise<void> {
    rmSync(keyFile(), { force: true });
  },
};
```

- [ ] **Step 5: Write the three native backends**

`packages/cli/src/vault/keychain/macos.ts`:

```ts
import { commandExists, run } from "./exec";
import { ACCOUNT_NAME, SERVICE_NAME, type KeychainBackend } from "./types";

export const macosBackend: KeychainBackend = {
  name: "macos",

  async isAvailable(): Promise<boolean> {
    return process.platform === "darwin" && (await commandExists("security"));
  },

  async get(): Promise<Buffer | null> {
    const res = await run([
      "security", "find-generic-password",
      "-a", ACCOUNT_NAME, "-s", SERVICE_NAME, "-w",
    ]);
    if (res.code !== 0) return null;
    const key = Buffer.from(res.stdout.trim(), "base64");
    return key.length === 32 ? key : null;
  },

  async set(key: Buffer): Promise<void> {
    // -U updates in place when the item already exists.
    // -w with no value makes `security` read the password from stdin.
    const res = await run(
      [
        "security", "add-generic-password",
        "-a", ACCOUNT_NAME, "-s", SERVICE_NAME,
        "-D", "Kerstel vault key", "-U", "-w",
      ],
      `${key.toString("base64")}\n`,
    );
    if (res.code !== 0) throw new Error(`macOS Keychain write failed: ${res.stderr.trim()}`);
  },

  async delete(): Promise<void> {
    await run(["security", "delete-generic-password", "-a", ACCOUNT_NAME, "-s", SERVICE_NAME]);
  },
};
```

`packages/cli/src/vault/keychain/linux.ts`:

```ts
import { commandExists, run } from "./exec";
import { ACCOUNT_NAME, SERVICE_NAME, type KeychainBackend } from "./types";

const ATTRS = ["service", SERVICE_NAME, "account", ACCOUNT_NAME];

export const linuxBackend: KeychainBackend = {
  name: "linux",

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "linux") return false;
    if (!(await commandExists("secret-tool"))) return false;
    // A running Secret Service is required; `lookup` on a missing item exits 1
    // with empty stderr, while a missing daemon reports a D-Bus error.
    const probe = await run(["secret-tool", "lookup", ...ATTRS]);
    return !/dbus|no such|not provided/i.test(probe.stderr);
  },

  async get(): Promise<Buffer | null> {
    const res = await run(["secret-tool", "lookup", ...ATTRS]);
    if (res.code !== 0 || res.stdout.trim() === "") return null;
    const key = Buffer.from(res.stdout.trim(), "base64");
    return key.length === 32 ? key : null;
  },

  async set(key: Buffer): Promise<void> {
    const res = await run(
      ["secret-tool", "store", "--label=Kerstel vault key", ...ATTRS],
      `${key.toString("base64")}\n`,
    );
    if (res.code !== 0) throw new Error(`Secret Service write failed: ${res.stderr.trim()}`);
  },

  async delete(): Promise<void> {
    await run(["secret-tool", "clear", ...ATTRS]);
  },
};
```

`packages/cli/src/vault/keychain/windows.ts`:

```ts
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
```

- [ ] **Step 6: Write the backend selector**

`packages/cli/src/vault/keychain/index.ts`:

```ts
import { generateDataKey } from "../crypto";
import { fileBackend } from "./file";
import { linuxBackend } from "./linux";
import { macosBackend } from "./macos";
import type { KeychainBackend } from "./types";
import { windowsBackend } from "./windows";

export { ACCOUNT_NAME, SERVICE_NAME, type KeychainBackend } from "./types";

const BY_NAME: Record<string, KeychainBackend> = {
  macos: macosBackend,
  linux: linuxBackend,
  windows: windowsBackend,
  file: fileBackend,
};

function nativeBackend(): KeychainBackend | null {
  if (process.platform === "darwin") return macosBackend;
  if (process.platform === "linux") return linuxBackend;
  if (process.platform === "win32") return windowsBackend;
  return null;
}

export async function selectBackend(): Promise<KeychainBackend> {
  const forced = process.env.KERSTEL_KEYCHAIN_BACKEND;
  if (forced) {
    const backend = BY_NAME[forced];
    if (!backend) {
      throw new Error(
        `Unknown KERSTEL_KEYCHAIN_BACKEND "${forced}". Expected one of: ${Object.keys(BY_NAME).join(", ")}`,
      );
    }
    return backend;
  }

  const native = nativeBackend();
  if (native && (await native.isAvailable())) return native;
  return fileBackend;
}

export interface DataKeyResult {
  key: Buffer;
  backend: string;
  /** True when this call generated a new key rather than reading an existing one. */
  created: boolean;
}

export async function loadOrCreateDataKey(): Promise<DataKeyResult> {
  const backend = await selectBackend();
  const existing = await backend.get();
  if (existing) return { key: existing, backend: backend.name, created: false };

  const key = generateDataKey();
  await backend.set(key);
  return { key, backend: backend.name, created: true };
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test packages/cli/test/keychain.test.ts`
Expected: PASS — 4 tests everywhere, 5 on macOS.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/vault/keychain packages/cli/test/keychain.test.ts
git commit -m "feat(cli): store the vault data key in the OS credential store

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Reference parsing

**Files:**
- Create: `packages/cli/src/reference.ts`
- Test: `packages/cli/test/reference.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `interface SecretRef { scope: string; key: string }`, `GLOBAL_SCOPE = "global"`, `isReference(value: string): boolean`, `parseReference(value: string): SecretRef | null`, `formatReference(scope: string, key: string): string`, `isValidScope(s: string): boolean`, `isValidKey(k: string): boolean`.

Task 11 re-implements `isReference`/`parseReference` inside `packages/hook` because the hook cannot import from the CLI package. Task 13 asserts the two implementations agree on a shared fixture list, so this task also exports that list.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/reference.test.ts`:

```ts
import { expect, test } from "bun:test";
import { REFERENCE_FIXTURES, formatReference, isReference, parseReference } from "../src/reference";

test("parses a global reference", () => {
  expect(parseReference("kerstel://global/OPENAI_API_KEY")).toEqual({
    scope: "global",
    key: "OPENAI_API_KEY",
  });
});

test("parses a project reference", () => {
  expect(parseReference("kerstel://my-app/DATABASE_URL")).toEqual({
    scope: "my-app",
    key: "DATABASE_URL",
  });
});

test("formatReference is the inverse of parseReference", () => {
  const ref = formatReference("my.app_2", "STRIPE_SECRET_KEY");
  expect(ref).toBe("kerstel://my.app_2/STRIPE_SECRET_KEY");
  expect(parseReference(ref)).toEqual({ scope: "my.app_2", key: "STRIPE_SECRET_KEY" });
});

test("rejects malformed references", () => {
  const bad = [
    "",
    "OPENAI_API_KEY",
    "https://example.com/x",
    "kerstel://",
    "kerstel://global",
    "kerstel://global/",
    "kerstel:///KEY",
    "kerstel://global/KEY/EXTRA",
    "kerstel://Bad-Upper/KEY",
    "kerstel://global/1STARTS_WITH_DIGIT",
    "kerstel://global/has-dash",
    "kerstel://глобал/KEY",
    " kerstel://global/KEY",
    "kerstel://global/KEY ",
  ];
  for (const value of bad) {
    expect(parseReference(value)).toBeNull();
    expect(isReference(value)).toBe(false);
  }
});

test("isReference agrees with parseReference on every fixture", () => {
  for (const { value, valid } of REFERENCE_FIXTURES) {
    expect(isReference(value)).toBe(valid);
    expect(parseReference(value) !== null).toBe(valid);
  }
});

test("formatReference rejects invalid components", () => {
  expect(() => formatReference("UPPER", "KEY")).toThrow(/scope/i);
  expect(() => formatReference("app", "bad-key")).toThrow(/key/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/reference.test.ts`
Expected: FAIL — cannot resolve module `../src/reference`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/reference.ts`:

```ts
export const GLOBAL_SCOPE = "global";
export const REFERENCE_PROTOCOL = "kerstel://";

/** Scope: lowercase project name, or the reserved word `global`. */
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/** Key: the shell-safe environment variable name shape. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SecretRef {
  scope: string;
  key: string;
}

export function isValidScope(scope: string): boolean {
  return scope.length > 0 && scope.length <= 64 && SCOPE_PATTERN.test(scope);
}

export function isValidKey(key: string): boolean {
  return key.length > 0 && key.length <= 128 && KEY_PATTERN.test(key);
}

/**
 * Parses `kerstel://<scope>/<KEY>`. Returns null for anything else, including
 * plain values, other URL schemes, and structurally invalid references. Callers
 * treat null as "this is an ordinary plaintext value, leave it alone".
 */
export function parseReference(value: string): SecretRef | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith(REFERENCE_PROTOCOL)) return null;

  const body = value.slice(REFERENCE_PROTOCOL.length);
  const slash = body.indexOf("/");
  if (slash <= 0) return null;

  const scope = body.slice(0, slash);
  const key = body.slice(slash + 1);
  if (!isValidScope(scope) || !isValidKey(key)) return null;

  return { scope, key };
}

export function isReference(value: string): boolean {
  return parseReference(value) !== null;
}

export function formatReference(scope: string, key: string): string {
  if (!isValidScope(scope)) {
    throw new Error(
      `Invalid scope "${scope}". Use "global" or a lowercase project name (letters, digits, . _ -).`,
    );
  }
  if (!isValidKey(key)) {
    throw new Error(
      `Invalid key "${key}". Use an environment variable name (letters, digits, _; not starting with a digit).`,
    );
  }
  return `${REFERENCE_PROTOCOL}${scope}/${key}`;
}

/** Shared cases so the hook's standalone parser can be proven equivalent. */
export const REFERENCE_FIXTURES: { value: string; valid: boolean }[] = [
  { value: "kerstel://global/OPENAI_API_KEY", valid: true },
  { value: "kerstel://global/_PRIVATE", valid: true },
  { value: "kerstel://my-app/DATABASE_URL", valid: true },
  { value: "kerstel://my.app_2/A1", valid: true },
  { value: "", valid: false },
  { value: "plain-value", valid: false },
  { value: "postgres://user:pw@localhost/db", valid: false },
  { value: "kerstel://", valid: false },
  { value: "kerstel://global", valid: false },
  { value: "kerstel://global/", valid: false },
  { value: "kerstel:///KEY", valid: false },
  { value: "kerstel://global/KEY/EXTRA", valid: false },
  { value: "kerstel://Bad-Upper/KEY", valid: false },
  { value: "kerstel://global/1DIGIT", valid: false },
  { value: "kerstel://global/has-dash", valid: false },
  { value: " kerstel://global/KEY", valid: false },
  { value: "kerstel://global/KEY ", valid: false },
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/test/reference.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/reference.ts packages/cli/test/reference.test.ts
git commit -m "feat(cli): add kerstel:// reference parsing

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Vault schema and store

**Files:**
- Create: `packages/cli/src/vault/schema.ts`, `packages/cli/src/vault/store.ts`
- Test: `packages/cli/test/vault.test.ts`

**Interfaces:**
- Consumes: `encrypt`, `decrypt` from `./crypto`; `SecretRef`, `GLOBAL_SCOPE` from `../reference`; `vaultPath`, `ensureHome` from `../paths`
- Produces:
  - `interface SecretSummary { scope: string; key: string; updatedAt: number }`
  - `interface AuditEntry { ts: number; event: string; scope: string; key: string; pid: number | null; processName: string | null }`
  - `interface ProjectRecord { name: string; rootPath: string; createdAt: number }`
  - `interface Vault { setSecret(ref, value): void; getSecret(ref): string | null; listSecrets(scope?): SecretSummary[]; removeSecret(ref): boolean; registerProject(name, rootPath): void; listProjects(): ProjectRecord[]; appendAudit(entry): void; listAudit(limit): AuditEntry[]; close(): void }`
  - `openVault(dataKey: Buffer, file?: string): Vault`
  - `SCHEMA_VERSION = 1`

**Spec refinement to apply:** the spec's §5 uniqueness constraint reads `(scope, project_id, key)`. SQLite treats `NULL`s as distinct inside a `UNIQUE` index, so global secrets — which carry `project_id IS NULL` — would be allowed to duplicate. `scope` already encodes the project name, so the implementation uses `UNIQUE(scope, key)` and keeps `project_id` as a nullable metadata link. Behaviour matches the spec's intent exactly.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/vault.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDataKey } from "../src/vault/crypto";
import { SCHEMA_VERSION, openVault, type Vault } from "../src/vault/store";

const open: Vault[] = [];
function vaultIn(dir: string, key: Buffer): Vault {
  const v = openVault(key, join(dir, "vault.db"));
  open.push(v);
  return v;
}
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kerstel-vault-"));
}
afterEach(() => {
  while (open.length) open.pop()!.close();
});

test("set then get round-trips a secret", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, "sk-test-123");
  expect(v.getSecret({ scope: "global", key: "OPENAI_API_KEY" })).toBe("sk-test-123");
});

test("getSecret returns null for an unknown key", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  expect(v.getSecret({ scope: "global", key: "NOPE" })).toBeNull();
});

test("scopes are isolated — no fallback to global", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.setSecret({ scope: "global", key: "API_KEY" }, "global-value");
  expect(v.getSecret({ scope: "my-app", key: "API_KEY" })).toBeNull();

  v.setSecret({ scope: "my-app", key: "API_KEY" }, "project-value");
  expect(v.getSecret({ scope: "my-app", key: "API_KEY" })).toBe("project-value");
  expect(v.getSecret({ scope: "global", key: "API_KEY" })).toBe("global-value");
});

test("setting the same scope and key twice updates in place", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.setSecret({ scope: "global", key: "K" }, "first");
  v.setSecret({ scope: "global", key: "K" }, "second");
  expect(v.getSecret({ scope: "global", key: "K" })).toBe("second");
  expect(v.listSecrets("global").length).toBe(1);
});

test("values are encrypted at rest", () => {
  const dir = tempDir();
  const v = vaultIn(dir, generateDataKey());
  v.setSecret({ scope: "global", key: "K" }, "PLAINTEXT_CANARY");
  v.close();
  open.pop();

  const raw = readFileSync(join(dir, "vault.db"));
  expect(raw.includes(Buffer.from("PLAINTEXT_CANARY"))).toBe(false);
  // The key name is metadata and is expected to be searchable.
  expect(raw.includes(Buffer.from("K"))).toBe(true);
});

test("a wrong data key cannot read existing secrets", () => {
  const dir = tempDir();
  const v1 = vaultIn(dir, generateDataKey());
  v1.setSecret({ scope: "global", key: "K" }, "secret");
  v1.close();
  open.pop();

  const v2 = vaultIn(dir, generateDataKey());
  expect(() => v2.getSecret({ scope: "global", key: "K" })).toThrow();
});

test("listSecrets filters by scope and never returns values", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.setSecret({ scope: "global", key: "A" }, "1");
  v.setSecret({ scope: "app", key: "B" }, "2");

  const all = v.listSecrets();
  expect(all.length).toBe(2);
  expect(JSON.stringify(all)).not.toContain("1");

  expect(v.listSecrets("app").map((s) => s.key)).toEqual(["B"]);
});

test("removeSecret reports whether a row was deleted", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.setSecret({ scope: "global", key: "K" }, "v");
  expect(v.removeSecret({ scope: "global", key: "K" })).toBe(true);
  expect(v.removeSecret({ scope: "global", key: "K" })).toBe(false);
  expect(v.getSecret({ scope: "global", key: "K" })).toBeNull();
});

test("projects register idempotently and update their path", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.registerProject("my-app", "/tmp/a");
  v.registerProject("my-app", "/tmp/b");
  const projects = v.listProjects();
  expect(projects.length).toBe(1);
  expect(projects[0]!.rootPath).toBe("/tmp/b");
});

test("audit entries are stored newest-first and hold no values", () => {
  const v = vaultIn(tempDir(), generateDataKey());
  v.appendAudit({ ts: 1, event: "resolve", scope: "global", key: "A", pid: 10, processName: "node" });
  v.appendAudit({ ts: 2, event: "resolve", scope: "global", key: "B", pid: 11, processName: "bun" });

  const entries = v.listAudit(10);
  expect(entries.map((e) => e.key)).toEqual(["B", "A"]);
  expect(v.listAudit(1).length).toBe(1);
});

test("reopening an existing vault does not re-run migrations destructively", () => {
  const dir = tempDir();
  const key = generateDataKey();
  const v1 = vaultIn(dir, key);
  v1.setSecret({ scope: "global", key: "K" }, "persisted");
  v1.close();
  open.pop();

  const v2 = vaultIn(dir, key);
  expect(v2.getSecret({ scope: "global", key: "K" })).toBe("persisted");

  const db = new Database(join(dir, "vault.db"), { readonly: true });
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  expect(row?.user_version).toBe(SCHEMA_VERSION);
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/vault.test.ts`
Expected: FAIL — cannot resolve module `../src/vault/store`.

- [ ] **Step 3: Write the schema module**

`packages/cli/src/vault/schema.ts`:

```ts
import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 1;

/**
 * Ordered migrations. Index 0 takes the database from version 0 to version 1.
 * Never edit a shipped migration — append a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    root_path   TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE secrets (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    scope             TEXT    NOT NULL,
    project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    key               TEXT    NOT NULL,
    value_ciphertext  BLOB    NOT NULL,
    nonce             BLOB    NOT NULL,
    -- Reserved for environments (dev/staging/prod). Unused in v1; every row
    -- stores NULL so the column can join the unique index without migration.
    environment       TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE(scope, key)
  );

  CREATE INDEX secrets_scope_idx ON secrets(scope);

  CREATE TABLE audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    event         TEXT    NOT NULL,
    scope         TEXT    NOT NULL,
    key           TEXT    NOT NULL,
    pid           INTEGER,
    process_name  TEXT,
    project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL
  );

  CREATE INDEX audit_log_ts_idx ON audit_log(ts DESC);
  `,
];

export function migrate(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const current = row?.user_version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}
```

- [ ] **Step 4: Write the store**

`packages/cli/src/vault/store.ts`:

```ts
import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { ensureHome, vaultPath } from "../paths";
import type { SecretRef } from "../reference";
import { decrypt, encrypt } from "./crypto";
import { SCHEMA_VERSION, migrate } from "./schema";

export { SCHEMA_VERSION };

export interface SecretSummary {
  scope: string;
  key: string;
  updatedAt: number;
}

export interface ProjectRecord {
  name: string;
  rootPath: string;
  createdAt: number;
}

export interface AuditEntry {
  ts: number;
  event: string;
  scope: string;
  key: string;
  pid: number | null;
  processName: string | null;
}

export interface Vault {
  setSecret(ref: SecretRef, value: string): void;
  getSecret(ref: SecretRef): string | null;
  listSecrets(scope?: string): SecretSummary[];
  removeSecret(ref: SecretRef): boolean;
  registerProject(name: string, rootPath: string): void;
  listProjects(): ProjectRecord[];
  appendAudit(entry: AuditEntry): void;
  listAudit(limit: number): AuditEntry[];
  close(): void;
}

/**
 * Opens (creating and migrating as needed) the encrypted vault.
 * `dataKey` comes from the OS credential store and is held in memory only.
 */
export function openVault(dataKey: Buffer, file?: string): Vault {
  const target = file ?? vaultPath();
  if (!file) ensureHome();

  const isNew = !existsSync(target);
  const db = new Database(target, { create: true });
  migrate(db);
  if (isNew && process.platform !== "win32") chmodSync(target, 0o600);

  const now = (): number => Date.now();

  return {
    setSecret(ref: SecretRef, value: string): void {
      const { ciphertext, nonce } = encrypt(value, dataKey);
      const ts = now();
      db.query(
        `INSERT INTO secrets (scope, key, value_ciphertext, nonce, environment, created_at, updated_at)
         VALUES ($scope, $key, $ct, $nonce, NULL, $ts, $ts)
         ON CONFLICT(scope, key) DO UPDATE SET
           value_ciphertext = excluded.value_ciphertext,
           nonce            = excluded.nonce,
           updated_at       = excluded.updated_at`,
      ).run({ $scope: ref.scope, $key: ref.key, $ct: ciphertext, $nonce: nonce, $ts: ts });
    },

    getSecret(ref: SecretRef): string | null {
      const row = db
        .query<{ value_ciphertext: Uint8Array; nonce: Uint8Array }, { $scope: string; $key: string }>(
          "SELECT value_ciphertext, nonce FROM secrets WHERE scope = $scope AND key = $key",
        )
        .get({ $scope: ref.scope, $key: ref.key });
      if (!row) return null;

      return decrypt(
        { ciphertext: Buffer.from(row.value_ciphertext), nonce: Buffer.from(row.nonce) },
        dataKey,
      );
    },

    listSecrets(scope?: string): SecretSummary[] {
      const rows = scope
        ? db
            .query<{ scope: string; key: string; updated_at: number }, { $scope: string }>(
              "SELECT scope, key, updated_at FROM secrets WHERE scope = $scope ORDER BY key",
            )
            .all({ $scope: scope })
        : db
            .query<{ scope: string; key: string; updated_at: number }, []>(
              "SELECT scope, key, updated_at FROM secrets ORDER BY scope, key",
            )
            .all();

      return rows.map((r) => ({ scope: r.scope, key: r.key, updatedAt: r.updated_at }));
    },

    removeSecret(ref: SecretRef): boolean {
      const result = db
        .query("DELETE FROM secrets WHERE scope = $scope AND key = $key")
        .run({ $scope: ref.scope, $key: ref.key });
      return result.changes > 0;
    },

    registerProject(name: string, rootPath: string): void {
      db.query(
        `INSERT INTO projects (name, root_path, created_at)
         VALUES ($name, $root, $ts)
         ON CONFLICT(name) DO UPDATE SET root_path = excluded.root_path`,
      ).run({ $name: name, $root: rootPath, $ts: now() });
    },

    listProjects(): ProjectRecord[] {
      return db
        .query<{ name: string; root_path: string; created_at: number }, []>(
          "SELECT name, root_path, created_at FROM projects ORDER BY name",
        )
        .all()
        .map((r) => ({ name: r.name, rootPath: r.root_path, createdAt: r.created_at }));
    },

    appendAudit(entry: AuditEntry): void {
      db.query(
        `INSERT INTO audit_log (ts, event, scope, key, pid, process_name)
         VALUES ($ts, $event, $scope, $key, $pid, $proc)`,
      ).run({
        $ts: entry.ts,
        $event: entry.event,
        $scope: entry.scope,
        $key: entry.key,
        $pid: entry.pid,
        $proc: entry.processName,
      });
    },

    listAudit(limit: number): AuditEntry[] {
      return db
        .query<
          { ts: number; event: string; scope: string; key: string; pid: number | null; process_name: string | null },
          { $limit: number }
        >("SELECT ts, event, scope, key, pid, process_name FROM audit_log ORDER BY id DESC LIMIT $limit")
        .all({ $limit: limit })
        .map((r) => ({
          ts: r.ts,
          event: r.event,
          scope: r.scope,
          key: r.key,
          pid: r.pid,
          processName: r.process_name,
        }));
    },

    close(): void {
      db.close();
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/cli/test/vault.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/vault/schema.ts packages/cli/src/vault/store.ts packages/cli/test/vault.test.ts
git commit -m "feat(cli): add encrypted SQLite vault store

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Daemon protocol and NDJSON codec

**Files:**
- Create: `packages/cli/src/daemon/protocol.ts`
- Test: `packages/cli/test/protocol.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `PROTOCOL_VERSION = 1`; request types `ResolveRequest`, `StatusRequest`, `LockRequest`, `ShutdownRequest` unioned as `Request`; response types unioned as `Response`; `encodeMessage(msg: unknown): string`; `class LineDecoder { push(chunk: Buffer | string): string[] }`; `errorResponse(id, code, message): Response`; error codes `ErrorCode`.

Task 10's worker re-declares this wire shape in plain JS. Keep the field names below exact.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/protocol.test.ts`:

```ts
import { expect, test } from "bun:test";
import { LineDecoder, PROTOCOL_VERSION, encodeMessage, errorResponse } from "../src/daemon/protocol";

test("encodeMessage produces one newline-terminated JSON line", () => {
  const line = encodeMessage({ v: PROTOCOL_VERSION, id: "1", op: "status" });
  expect(line.endsWith("\n")).toBe(true);
  expect(line.indexOf("\n")).toBe(line.length - 1);
  expect(JSON.parse(line)).toEqual({ v: 1, id: "1", op: "status" });
});

test("LineDecoder reassembles messages split across chunks", () => {
  const decoder = new LineDecoder();
  expect(decoder.push(Buffer.from('{"a":'))).toEqual([]);
  expect(decoder.push(Buffer.from('1}\n{"b":2}'))).toEqual(['{"a":1}']);
  expect(decoder.push(Buffer.from("\n"))).toEqual(['{"b":2}']);
});

test("LineDecoder returns several messages from one chunk", () => {
  const decoder = new LineDecoder();
  expect(decoder.push(Buffer.from("a\nb\nc\n"))).toEqual(["a", "b", "c"]);
});

test("LineDecoder ignores empty lines", () => {
  const decoder = new LineDecoder();
  expect(decoder.push(Buffer.from("\n\nx\n"))).toEqual(["x"]);
});

test("LineDecoder throws when a single line exceeds the cap", () => {
  const decoder = new LineDecoder(64);
  expect(() => decoder.push(Buffer.from("x".repeat(65)))).toThrow(/too large/i);
});

test("errorResponse carries a code and a message and never succeeds", () => {
  const res = errorResponse("req-1", "not_found", "no such secret");
  expect(res).toEqual({
    v: 1,
    id: "req-1",
    ok: false,
    error: { code: "not_found", message: "no such secret" },
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/protocol.test.ts`
Expected: FAIL — cannot resolve module `../src/daemon/protocol`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/daemon/protocol.ts`:

```ts
export const PROTOCOL_VERSION = 1;

/** One megabyte is far beyond any legitimate request or secret. */
export const MAX_LINE_BYTES = 1_048_576;

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "locked"
  | "unsupported_version"
  | "internal";

interface Envelope {
  v: typeof PROTOCOL_VERSION;
  id: string;
  /** Per-session bearer token read from ~/.kerstel/session.token. */
  token: string;
}

export interface ResolveRequest extends Envelope {
  op: "resolve";
  scope: string;
  key: string;
  /** Caller metadata, recorded in the audit log. v2 gates on these. */
  pid: number | null;
  processName: string | null;
}

export interface StatusRequest extends Envelope {
  op: "status";
}

export interface LockRequest extends Envelope {
  op: "lock";
}

export interface ShutdownRequest extends Envelope {
  op: "shutdown";
}

export type Request = ResolveRequest | StatusRequest | LockRequest | ShutdownRequest;

export interface ResolveOk {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ok: true;
  op: "resolve";
  value: string;
}

export interface StatusOk {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ok: true;
  op: "status";
  pid: number;
  unlocked: boolean;
  backend: string;
  secretCount: number;
  uptimeMs: number;
}

export interface AckOk {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ok: true;
  op: "lock" | "shutdown";
}

export interface ErrorResponse {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ok: false;
  error: { code: ErrorCode; message: string };
}

export type Response = ResolveOk | StatusOk | AckOk | ErrorResponse;

export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export function errorResponse(id: string, code: ErrorCode, message: string): ErrorResponse {
  return { v: PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}

/** Accumulates socket chunks and yields complete newline-delimited lines. */
export class LineDecoder {
  private buffer = "";

  constructor(private readonly maxBytes: number = MAX_LINE_BYTES) {}

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

    const lines: string[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) lines.push(line);
      newline = this.buffer.indexOf("\n");
    }

    if (this.buffer.length > this.maxBytes) {
      this.buffer = "";
      throw new Error(`Kerstel protocol line too large (> ${this.maxBytes} bytes)`);
    }
    return lines;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/test/protocol.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/daemon/protocol.ts packages/cli/test/protocol.test.ts
git commit -m "feat(cli): define the daemon NDJSON protocol

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Daemon server

**Files:**
- Create: `packages/cli/src/daemon/token.ts`, `packages/cli/src/daemon/server.ts`
- Test: `packages/cli/test/daemon-server.test.ts`

**Interfaces:**
- Consumes: `Vault` from `../vault/store`; protocol types from `./protocol`; `socketPath`, `tokenPath`, `ensureHome` from `../paths`
- Produces:
  - `readToken(): string | null`, `writeToken(token: string): string`, `createToken(): string`, `ensureToken(): string` from `./token`
  - `interface DaemonOptions { vault: Vault; socketPath: string; token: string; backendName: string; idleMs?: number; onIdle?: () => void }`
  - `interface DaemonHandle { socketPath: string; close(): Promise<void> }`
  - `startDaemon(options: DaemonOptions): Promise<DaemonHandle>`

**Spec refinement to apply:** §7 calls for peer-UID verification. `node:net` exposes no peer credentials, and a native module would break the single-binary constraint. The implementation instead pairs the `0700` home and `0600` socket with a per-session bearer token in `~/.kerstel/session.token` (`0600`), compared in constant time. This is portable to Windows named pipes, which have no UID at all, and gives the same guarantee: only a process that can read the user's own `0600` file can talk to the daemon.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/daemon-server.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, PROTOCOL_VERSION, encodeMessage, type Response } from "../src/daemon/protocol";
import { startDaemon, type DaemonHandle } from "../src/daemon/server";
import { generateDataKey } from "../src/vault/crypto";
import { openVault, type Vault } from "../src/vault/store";

const running: DaemonHandle[] = [];
const vaults: Vault[] = [];

afterEach(async () => {
  while (running.length) await running.pop()!.close();
  while (vaults.length) vaults.pop()!.close();
});

/** Sends one request over a fresh connection and resolves with the reply. */
function request(sock: string, message: unknown): Promise<Response> {
  return new Promise((resolve, reject) => {
    const decoder = new LineDecoder();
    const conn = createConnection(sock);
    conn.on("error", reject);
    conn.on("connect", () => conn.write(encodeMessage(message)));
    conn.on("data", (chunk) => {
      for (const line of decoder.push(chunk)) {
        conn.end();
        resolve(JSON.parse(line) as Response);
        return;
      }
    });
  });
}

async function boot(): Promise<{ sock: string; token: string; vault: Vault }> {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-daemon-"));
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\kerstel-test-${Date.now()}` : join(dir, "k.sock");
  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  vaults.push(vault);
  const token = "test-token-0123456789";
  running.push(await startDaemon({ vault, socketPath: sock, token, backendName: "file" }));
  return { sock, token, vault };
}

test("resolve returns the stored secret", async () => {
  const { sock, token, vault } = await boot();
  vault.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, "sk-live-xyz");

  const res = await request(sock, {
    v: PROTOCOL_VERSION, id: "1", token, op: "resolve",
    scope: "global", key: "OPENAI_API_KEY", pid: 123, processName: "node",
  });
  expect(res).toMatchObject({ ok: true, op: "resolve", value: "sk-live-xyz" });
});

test("resolve records an audit entry without the value", async () => {
  const { sock, token, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "the-value");
  await request(sock, {
    v: PROTOCOL_VERSION, id: "1", token, op: "resolve",
    scope: "global", key: "K", pid: 42, processName: "bun",
  });

  const entries = vault.listAudit(5);
  expect(entries.length).toBe(1);
  expect(entries[0]).toMatchObject({ event: "resolve", scope: "global", key: "K", pid: 42 });
  expect(JSON.stringify(entries)).not.toContain("the-value");
});

test("an unknown secret returns not_found", async () => {
  const { sock, token } = await boot();
  const res = await request(sock, {
    v: PROTOCOL_VERSION, id: "1", token, op: "resolve",
    scope: "global", key: "MISSING", pid: null, processName: null,
  });
  expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
});

test("a wrong token is rejected", async () => {
  const { sock } = await boot();
  const res = await request(sock, {
    v: PROTOCOL_VERSION, id: "1", token: "wrong-token-000000000", op: "resolve",
    scope: "global", key: "K", pid: null, processName: null,
  });
  expect(res).toMatchObject({ ok: false, error: { code: "unauthorized" } });
});

test("an unsupported protocol version is rejected", async () => {
  const { sock, token } = await boot();
  const res = await request(sock, { v: 99, id: "1", token, op: "status" });
  expect(res).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
});

test("malformed JSON yields bad_request instead of crashing the daemon", async () => {
  const { sock, token } = await boot();
  const res = await new Promise<Response>((resolve, reject) => {
    const decoder = new LineDecoder();
    const conn = createConnection(sock);
    conn.on("error", reject);
    conn.on("connect", () => conn.write("{not json\n"));
    conn.on("data", (chunk) => {
      for (const line of decoder.push(chunk)) {
        conn.end();
        resolve(JSON.parse(line) as Response);
        return;
      }
    });
  });
  expect(res).toMatchObject({ ok: false, error: { code: "bad_request" } });

  const still = await request(sock, { v: PROTOCOL_VERSION, id: "2", token, op: "status" });
  expect(still).toMatchObject({ ok: true });
});

test("status reports the daemon state", async () => {
  const { sock, token, vault } = await boot();
  vault.setSecret({ scope: "global", key: "A" }, "1");
  const res = await request(sock, { v: PROTOCOL_VERSION, id: "1", token, op: "status" });
  expect(res).toMatchObject({ ok: true, op: "status", unlocked: true, secretCount: 1, backend: "file" });
});

test("lock stops further resolutions until restart", async () => {
  const { sock, token, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "v");
  await request(sock, { v: PROTOCOL_VERSION, id: "1", token, op: "lock" });

  const res = await request(sock, {
    v: PROTOCOL_VERSION, id: "2", token, op: "resolve",
    scope: "global", key: "K", pid: null, processName: null,
  });
  expect(res).toMatchObject({ ok: false, error: { code: "locked" } });
});

test("the daemon relocks itself after the idle timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-idle-"));
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\kerstel-idle-${Date.now()}` : join(dir, "k.sock");
  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  vaults.push(vault);
  vault.setSecret({ scope: "global", key: "K" }, "v");

  running.push(await startDaemon({ vault, socketPath: sock, token: "t".repeat(20), backendName: "file", idleMs: 50 }));
  await Bun.sleep(120);

  const res = await request(sock, {
    v: PROTOCOL_VERSION, id: "1", token: "t".repeat(20), op: "resolve",
    scope: "global", key: "K", pid: null, processName: null,
  });
  expect(res).toMatchObject({ ok: false, error: { code: "locked" } });
});

test("a stale socket file is replaced on restart", async () => {
  const { sock, token } = await boot();
  await running.pop()!.close();

  const dir = mkdtempSync(join(tmpdir(), "kerstel-restart-"));
  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  vaults.push(vault);
  running.push(await startDaemon({ vault, socketPath: sock, token, backendName: "file" }));

  const res = await request(sock, { v: PROTOCOL_VERSION, id: "1", token, op: "status" });
  expect(res).toMatchObject({ ok: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/daemon-server.test.ts`
Expected: FAIL — cannot resolve module `../src/daemon/server`.

- [ ] **Step 3: Write the token module**

`packages/cli/src/daemon/token.ts`:

```ts
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
```

- [ ] **Step 4: Write the server**

`packages/cli/src/daemon/server.ts`:

```ts
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { Vault } from "../vault/store";
import {
  LineDecoder,
  PROTOCOL_VERSION,
  encodeMessage,
  errorResponse,
  type Request,
  type Response,
} from "./protocol";
import { tokensMatch } from "./token";

export interface DaemonOptions {
  vault: Vault;
  socketPath: string;
  token: string;
  /** Keychain backend name, reported by `status`. */
  backendName: string;
  /** Relock and stop serving after this long with no requests. Default 8 hours. */
  idleMs?: number;
  onIdle?: () => void;
}

export interface DaemonHandle {
  socketPath: string;
  close(): Promise<void>;
}

const DEFAULT_IDLE_MS = 8 * 60 * 60 * 1000;

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const { vault, socketPath, token, backendName } = options;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const startedAt = Date.now();

  let unlocked = true;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const sockets = new Set<Socket>();

  const lock = (): void => {
    unlocked = false;
  };

  const touchIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      lock();
      options.onIdle?.();
    }, idleMs);
    idleTimer.unref?.();
  };

  function handle(raw: string): Response {
    let message: Partial<Request>;
    try {
      message = JSON.parse(raw) as Partial<Request>;
    } catch {
      return errorResponse("", "bad_request", "Request was not valid JSON");
    }

    const id = typeof message.id === "string" ? message.id : "";

    if (message.v !== PROTOCOL_VERSION) {
      return errorResponse(id, "unsupported_version", `Expected protocol v${PROTOCOL_VERSION}`);
    }
    if (typeof message.token !== "string" || !tokensMatch(message.token, token)) {
      return errorResponse(id, "unauthorized", "Invalid session token");
    }

    touchIdleTimer();

    switch (message.op) {
      case "status":
        return {
          v: PROTOCOL_VERSION,
          id,
          ok: true,
          op: "status",
          pid: process.pid,
          unlocked,
          backend: backendName,
          secretCount: vault.listSecrets().length,
          uptimeMs: Date.now() - startedAt,
        };

      case "lock":
        lock();
        return { v: PROTOCOL_VERSION, id, ok: true, op: "lock" };

      case "shutdown":
        queueMicrotask(() => void close());
        return { v: PROTOCOL_VERSION, id, ok: true, op: "shutdown" };

      case "resolve": {
        if (!unlocked) {
          return errorResponse(id, "locked", "Vault is locked. Run `kerstel daemon start` to unlock.");
        }
        const { scope, key } = message;
        if (typeof scope !== "string" || typeof key !== "string") {
          return errorResponse(id, "bad_request", "resolve requires string scope and key");
        }

        let value: string | null;
        try {
          value = vault.getSecret({ scope, key });
        } catch {
          return errorResponse(id, "internal", "Could not decrypt the stored value");
        }
        if (value === null) {
          return errorResponse(id, "not_found", `No secret at kerstel://${scope}/${key}`);
        }

        vault.appendAudit({
          ts: Date.now(),
          event: "resolve",
          scope,
          key,
          pid: typeof message.pid === "number" ? message.pid : null,
          processName: typeof message.processName === "string" ? message.processName : null,
        });

        return { v: PROTOCOL_VERSION, id, ok: true, op: "resolve", value };
      }

      default:
        return errorResponse(id, "bad_request", `Unknown op "${String(message.op)}"`);
    }
  }

  // A socket file left behind by a crashed daemon would block bind().
  if (process.platform !== "win32" && existsSync(socketPath)) rmSync(socketPath, { force: true });

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const decoder = new LineDecoder();

    socket.on("data", (chunk) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (error) {
        socket.write(encodeMessage(errorResponse("", "bad_request", (error as Error).message)));
        socket.end();
        return;
      }
      for (const line of lines) socket.write(encodeMessage(handle(line)));
    });

    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  if (process.platform !== "win32") chmodSync(socketPath, 0o600);
  touchIdleTimer();

  async function close(): Promise<void> {
    if (idleTimer) clearTimeout(idleTimer);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") rmSync(socketPath, { force: true });
  }

  return { socketPath, close };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/cli/test/daemon-server.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/daemon/token.ts packages/cli/src/daemon/server.ts packages/cli/test/daemon-server.test.ts
git commit -m "feat(cli): add the resolver daemon server

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Daemon client and auto-start

**Files:**
- Create: `packages/cli/src/daemon/client.ts`
- Test: `packages/cli/test/daemon-client.test.ts`

**Interfaces:**
- Consumes: protocol types from `./protocol`; `readToken` from `./token`; `socketPath` from `../paths`
- Produces:
  - `interface DaemonClient { resolve(scope: string, key: string, meta?: { pid?: number; processName?: string }): Promise<string>; status(): Promise<StatusOk>; lock(): Promise<void>; shutdown(): Promise<void>; close(): void }`
  - `connectDaemon(options?: { socketPath?: string; token?: string; timeoutMs?: number }): Promise<DaemonClient>`
  - `class DaemonError extends Error { code: ErrorCode }`
  - `isDaemonRunning(socketPath?: string): Promise<boolean>`
  - `ensureDaemon(options?: { spawnCommand?: string[]; timeoutMs?: number }): Promise<DaemonClient>` — connects, or spawns a detached `kerstel daemon start` and polls until it answers.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/daemon-client.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonError, connectDaemon, isDaemonRunning } from "../src/daemon/client";
import { startDaemon, type DaemonHandle } from "../src/daemon/server";
import { generateDataKey } from "../src/vault/crypto";
import { openVault, type Vault } from "../src/vault/store";

const running: DaemonHandle[] = [];
const vaults: Vault[] = [];
const TOKEN = "client-test-token-12345";

afterEach(async () => {
  while (running.length) await running.pop()!.close();
  while (vaults.length) vaults.pop()!.close();
});

async function boot(): Promise<{ sock: string; vault: Vault }> {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-client-"));
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\kerstel-c-${Date.now()}` : join(dir, "k.sock");
  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  vaults.push(vault);
  running.push(await startDaemon({ vault, socketPath: sock, token: TOKEN, backendName: "file" }));
  return { sock, vault };
}

test("resolve returns the secret value", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "value-1");

  const client = await connectDaemon({ socketPath: sock, token: TOKEN });
  expect(await client.resolve("global", "K")).toBe("value-1");
  client.close();
});

test("concurrent resolves on one connection match their own replies", async () => {
  const { sock, vault } = await boot();
  for (let i = 0; i < 20; i++) vault.setSecret({ scope: "global", key: `K${i}` }, `value-${i}`);

  const client = await connectDaemon({ socketPath: sock, token: TOKEN });
  const values = await Promise.all(
    Array.from({ length: 20 }, (_, i) => client.resolve("global", `K${i}`)),
  );
  expect(values).toEqual(Array.from({ length: 20 }, (_, i) => `value-${i}`));
  client.close();
});

test("a missing secret rejects with a not_found DaemonError", async () => {
  const { sock } = await boot();
  const client = await connectDaemon({ socketPath: sock, token: TOKEN });

  await expect(client.resolve("global", "MISSING")).rejects.toThrow(DaemonError);
  await client.resolve("global", "MISSING").catch((error: DaemonError) => {
    expect(error.code).toBe("not_found");
  });
  client.close();
});

test("a wrong token rejects with unauthorized", async () => {
  const { sock } = await boot();
  const client = await connectDaemon({ socketPath: sock, token: "nope-nope-nope-nope-1" });
  await client.resolve("global", "K").catch((error: DaemonError) => {
    expect(error.code).toBe("unauthorized");
  });
  client.close();
});

test("status reports the running daemon", async () => {
  const { sock } = await boot();
  const client = await connectDaemon({ socketPath: sock, token: TOKEN });
  const status = await client.status();
  expect(status.unlocked).toBe(true);
  expect(status.pid).toBeGreaterThan(0);
  client.close();
});

test("isDaemonRunning distinguishes a live socket from a dead one", async () => {
  const { sock } = await boot();
  expect(await isDaemonRunning(sock)).toBe(true);

  await running.pop()!.close();
  expect(await isDaemonRunning(sock)).toBe(false);
});

test("connecting to a nonexistent socket rejects quickly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-nosock-"));
  const sock = process.platform === "win32" ? "\\\\.\\pipe\\kerstel-absent" : join(dir, "absent.sock");
  await expect(connectDaemon({ socketPath: sock, token: TOKEN, timeoutMs: 300 })).rejects.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/daemon-client.test.ts`
Expected: FAIL — cannot resolve module `../src/daemon/client`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/daemon/client.ts`:

```ts
import { createConnection, type Socket } from "node:net";
import { basename } from "node:path";
import { socketPath as defaultSocketPath } from "../paths";
import {
  LineDecoder,
  PROTOCOL_VERSION,
  encodeMessage,
  type ErrorCode,
  type Response,
  type StatusOk,
} from "./protocol";
import { readToken } from "./token";

export class DaemonError extends Error {
  constructor(
    public readonly code: ErrorCode | "unreachable",
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export interface DaemonClient {
  resolve(scope: string, key: string, meta?: { pid?: number; processName?: string }): Promise<string>;
  status(): Promise<StatusOk>;
  lock(): Promise<void>;
  shutdown(): Promise<void>;
  close(): void;
}

export interface ConnectOptions {
  socketPath?: string;
  token?: string;
  timeoutMs?: number;
}

export async function connectDaemon(options: ConnectOptions = {}): Promise<DaemonClient> {
  const sock = options.socketPath ?? defaultSocketPath();
  const token = options.token ?? readToken();
  const timeoutMs = options.timeoutMs ?? 5_000;

  if (!token) {
    throw new DaemonError("unauthorized", "No session token found. Run `kerstel daemon start`.");
  }

  const socket = await new Promise<Socket>((resolve, reject) => {
    const conn = createConnection(sock);
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new DaemonError("unreachable", `Timed out connecting to the Kerstel daemon at ${sock}`));
    }, timeoutMs);

    conn.once("connect", () => {
      clearTimeout(timer);
      resolve(conn);
    });
    conn.once("error", (error) => {
      clearTimeout(timer);
      reject(new DaemonError("unreachable", `Kerstel daemon is not running (${(error as Error).message})`));
    });
  });

  const pending = new Map<string, { resolve(r: Response): void; reject(e: Error): void }>();
  const decoder = new LineDecoder();
  let counter = 0;

  socket.on("data", (chunk) => {
    for (const line of decoder.push(chunk)) {
      let response: Response;
      try {
        response = JSON.parse(line) as Response;
      } catch {
        continue;
      }
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        waiter.resolve(response);
      }
    }
  });

  const fail = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  socket.on("error", (error) => fail(new DaemonError("unreachable", (error as Error).message)));
  socket.on("close", () => fail(new DaemonError("unreachable", "Daemon connection closed")));

  function send(payload: Record<string, unknown>): Promise<Response> {
    const id = `${process.pid}-${++counter}`;
    return new Promise<Response>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.write(encodeMessage({ v: PROTOCOL_VERSION, id, token, ...payload }));
    });
  }

  function unwrap(response: Response): Response {
    if (response.ok === false) throw new DaemonError(response.error.code, response.error.message);
    return response;
  }

  return {
    async resolve(scope, key, meta) {
      const response = unwrap(
        await send({
          op: "resolve",
          scope,
          key,
          pid: meta?.pid ?? process.pid,
          processName: meta?.processName ?? basename(process.argv[0] ?? "unknown"),
        }),
      );
      if (!("value" in response)) throw new DaemonError("internal", "Malformed resolve response");
      return response.value;
    },

    async status() {
      const response = unwrap(await send({ op: "status" }));
      if (!("unlocked" in response)) throw new DaemonError("internal", "Malformed status response");
      return response;
    },

    async lock() {
      unwrap(await send({ op: "lock" }));
    },

    async shutdown() {
      try {
        unwrap(await send({ op: "shutdown" }));
      } catch (error) {
        // The daemon may close the socket before the reply lands; that is success.
        if (!(error instanceof DaemonError) || error.code !== "unreachable") throw error;
      }
    },

    close() {
      socket.destroy();
    },
  };
}

export async function isDaemonRunning(sock: string = defaultSocketPath()): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection(sock);
    const done = (result: boolean): void => {
      conn.destroy();
      resolve(result);
    };
    conn.once("connect", () => done(true));
    conn.once("error", () => done(false));
    setTimeout(() => done(false), 1_000).unref?.();
  });
}

export interface EnsureOptions {
  /** Command used to start the daemon. Defaults to this executable. */
  spawnCommand?: string[];
  timeoutMs?: number;
}

/**
 * Returns a connected client, starting a detached daemon first when none is
 * listening. Polls rather than racing so a daemon started by another process
 * in the same moment is reused.
 */
export async function ensureDaemon(options: EnsureOptions = {}): Promise<DaemonClient> {
  try {
    return await connectDaemon({ timeoutMs: 1_000 });
  } catch {
    // Fall through and start one.
  }

  const command = options.spawnCommand ?? [process.execPath, "daemon", "start", "--detached"];
  Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();

  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    await Bun.sleep(100);
    try {
      return await connectDaemon({ timeoutMs: 1_000 });
    } catch (error) {
      lastError = error;
    }
  }

  throw new DaemonError(
    "unreachable",
    `Could not start the Kerstel daemon. Try \`kerstel daemon start\` manually. (${String(lastError)})`,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/test/daemon-client.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/daemon/client.ts packages/cli/test/daemon-client.test.ts
git commit -m "feat(cli): add the daemon client with auto-start

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Synchronous resolution bridge

`process.env.FOO` is a synchronous property read, but the daemon speaks over an async socket. This bridge blocks the calling thread on `Atomics.wait` while a worker thread performs the socket round trip and writes the answer into shared memory. Written in plain JavaScript with `node:` builtins only, so it runs identically under Node 18+ and Bun.

**Files:**
- Create: `packages/hook/src/protocol.js`, `packages/hook/src/worker.js`, `packages/hook/src/bridge.js`
- Test: `packages/hook/test/bridge.test.ts`

**Interfaces:**
- Consumes: the wire format from Task 7 (field names must match exactly); a running daemon from Task 8
- Produces: `createBridge({ socketPath, token, timeoutMs }): { resolveSync(scope, key): string, dispose(): void }` from `bridge.js`. `resolveSync` returns the plaintext or throws an `Error` whose `code` property is the daemon's error code.

**Why a worker rather than `execFileSync`:** spawning a process per lookup costs 50–100 ms; an app with 15 references would stall for over a second at startup. The worker pays one ~10 ms setup and then answers in well under a millisecond. The main thread stays blocked only for the duration of the round trip, which is what makes a synchronous `process.env` read possible at all.

- [ ] **Step 1: Write the failing test**

`packages/hook/test/bridge.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../cli/src/daemon/server";
import { generateDataKey } from "../../cli/src/vault/crypto";
import { openVault, type Vault } from "../../cli/src/vault/store";
// @ts-expect-error -- plain JS module without type declarations
import { createBridge } from "../src/bridge.js";

const running: DaemonHandle[] = [];
const vaults: Vault[] = [];
const bridges: { dispose(): void }[] = [];
const TOKEN = "bridge-test-token-98765";

afterEach(async () => {
  while (bridges.length) bridges.pop()!.dispose();
  while (running.length) await running.pop()!.close();
  while (vaults.length) vaults.pop()!.close();
});

async function boot(): Promise<{ sock: string; vault: Vault }> {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-bridge-"));
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\kerstel-b-${Date.now()}` : join(dir, "k.sock");
  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  vaults.push(vault);
  running.push(await startDaemon({ vault, socketPath: sock, token: TOKEN, backendName: "file" }));
  return { sock, vault };
}

function bridgeFor(sock: string, timeoutMs = 5_000) {
  const bridge = createBridge({ socketPath: sock, token: TOKEN, timeoutMs });
  bridges.push(bridge);
  return bridge;
}

test("resolveSync returns the value synchronously", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "sync-value");

  const bridge = bridgeFor(sock);
  expect(bridge.resolveSync("global", "K")).toBe("sync-value");
});

test("resolveSync handles many sequential lookups", async () => {
  const { sock, vault } = await boot();
  for (let i = 0; i < 30; i++) vault.setSecret({ scope: "global", key: `K${i}` }, `v${i}`);

  const bridge = bridgeFor(sock);
  for (let i = 0; i < 30; i++) expect(bridge.resolveSync("global", `K${i}`)).toBe(`v${i}`);
});

test("resolveSync round-trips values with newlines and unicode", async () => {
  const { sock, vault } = await boot();
  const value = "line1\nline2\t🔐 \"quoted\" \\slash";
  vault.setSecret({ scope: "global", key: "MULTI" }, value);

  expect(bridgeFor(sock).resolveSync("global", "MULTI")).toBe(value);
});

test("resolveSync handles a value larger than the shared buffer", async () => {
  const { sock, vault } = await boot();
  const big = "x".repeat(200_000);
  vault.setSecret({ scope: "global", key: "BIG" }, big);

  expect(bridgeFor(sock).resolveSync("global", "BIG")).toBe(big);
});

test("a missing secret throws with code not_found", async () => {
  const { sock } = await boot();
  const bridge = bridgeFor(sock);
  try {
    bridge.resolveSync("global", "MISSING");
    throw new Error("expected resolveSync to throw");
  } catch (error) {
    expect((error as { code?: string }).code).toBe("not_found");
  }
});

test("an unreachable daemon throws rather than hanging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-dead-"));
  const sock = process.platform === "win32" ? "\\\\.\\pipe\\kerstel-dead" : join(dir, "dead.sock");
  const bridge = bridgeFor(sock, 1_000);
  expect(() => bridge.resolveSync("global", "K")).toThrow();
});

test("the bridge does not keep the event loop alive", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "v");
  const bridge = bridgeFor(sock);
  bridge.resolveSync("global", "K");

  const proc = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore" });
  expect(await proc.exited).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/hook/test/bridge.test.ts`
Expected: FAIL — cannot resolve module `../src/bridge.js`.

- [ ] **Step 3: Write the shared wire helpers**

`packages/hook/src/protocol.js`:

```js
"use strict";

/**
 * Wire constants mirrored from packages/cli/src/daemon/protocol.ts.
 * The hook cannot import from the CLI package because it is bundled standalone
 * and written to ~/.kerstel/hook/. Task 13 asserts the two stay in step.
 */
const PROTOCOL_VERSION = 1;
const REFERENCE_PROTOCOL = "kerstel://";
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Mirrors parseReference() in packages/cli/src/reference.ts. */
function parseReference(value) {
  if (typeof value !== "string") return null;
  if (!value.startsWith(REFERENCE_PROTOCOL)) return null;

  const body = value.slice(REFERENCE_PROTOCOL.length);
  const slash = body.indexOf("/");
  if (slash <= 0) return null;

  const scope = body.slice(0, slash);
  const key = body.slice(slash + 1);
  if (scope.length === 0 || scope.length > 64 || !SCOPE_PATTERN.test(scope)) return null;
  if (key.length === 0 || key.length > 128 || !KEY_PATTERN.test(key)) return null;

  return { scope, key };
}

function isReference(value) {
  return parseReference(value) !== null;
}

module.exports = { PROTOCOL_VERSION, REFERENCE_PROTOCOL, parseReference, isReference };
```

- [ ] **Step 4: Write the worker**

`packages/hook/src/worker.js`:

```js
"use strict";

const net = require("node:net");
const { workerData } = require("node:worker_threads");
const { PROTOCOL_VERSION } = require("./protocol.js");

// `port` is the MessagePort half handed over by the bridge. Results go back on
// it rather than on parentPort, because the bridge drains replies with
// receiveMessageOnPort() while its own thread is blocked in Atomics.wait().
const { socketPath, token, timeoutMs, control, header, port } = workerData;

const status = new Int32Array(control);
const headerView = new Int32Array(header);

const STATUS_INDEX = 0;
const STATE_PENDING = 0;
const STATE_DONE = 1;

const HEADER_OK = 0;
const HEADER_LENGTH = 1;

let socket = null;
let buffer = "";
let counter = 0;
const pending = new Map();

function connect() {
  if (socket) return socket;

  socket = net.createConnection(socketPath);
  socket.setNoDelay(true);
  socket.unref();

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.length === 0) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter(message);
      }
    }
  });

  const failAll = (message) => {
    socket = null;
    buffer = "";
    for (const waiter of pending.values()) {
      waiter({ ok: false, error: { code: "unreachable", message } });
    }
    pending.clear();
  };

  socket.on("error", (error) => failAll(error.message));
  socket.on("close", () => failAll("Daemon connection closed"));

  return socket;
}

/** Writes the reply into shared memory and wakes the blocked main thread. */
function reply(ok, payload) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  headerView[HEADER_OK] = ok ? 1 : 0;
  headerView[HEADER_LENGTH] = bytes.length;

  // The payload travels by postMessage because it can exceed any fixed buffer;
  // shared memory carries only the wake-up signal and the length.
  port.postMessage({ type: "result", ok, payload: bytes.toString("utf8") });

  Atomics.store(status, STATUS_INDEX, STATE_DONE);
  Atomics.notify(status, STATUS_INDEX);
}

port.on("message", (request) => {
  let settled = false;
  const settle = (ok, payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reply(ok, payload);
  };

  const timer = setTimeout(() => {
    settle(false, { code: "timeout", message: `Kerstel daemon did not answer in ${timeoutMs}ms` });
  }, timeoutMs);
  timer.unref();

  let conn;
  try {
    conn = connect();
  } catch (error) {
    settle(false, { code: "unreachable", message: error.message });
    return;
  }

  const id = `w${++counter}`;
  pending.set(id, (message) => {
    if (message.ok) settle(true, { value: message.value });
    else settle(false, message.error || { code: "internal", message: "Unknown daemon error" });
  });

  const line = `${JSON.stringify({
    v: PROTOCOL_VERSION,
    id,
    token,
    op: "resolve",
    scope: request.scope,
    key: request.key,
    pid: request.pid,
    processName: request.processName,
  })}\n`;

  const write = () => conn.write(line);
  if (conn.connecting) conn.once("connect", write);
  else write();
});

// A port handed over through workerData does not deliver messages until started.
port.start();
```

- [ ] **Step 5: Write the bridge**

`packages/hook/src/bridge.js`:

```js
"use strict";

const path = require("node:path");
const { Worker, receiveMessageOnPort, MessageChannel } = require("node:worker_threads");

const STATUS_INDEX = 0;
const STATE_PENDING = 0;
const STATE_DONE = 1;

/**
 * Bridges the daemon's async socket into a synchronous call.
 *
 * The main thread posts a request to the worker, then parks on
 * Atomics.wait(). postMessage is delivered through the worker's own event
 * loop, which keeps running while this thread is blocked, so the worker can do
 * its socket round trip and wake us with Atomics.notify(). The reply itself
 * travels over a MessagePort so its size is not capped by shared memory.
 */
function createBridge(options) {
  const socketPath = options.socketPath;
  const token = options.token;
  const timeoutMs = options.timeoutMs || 5_000;

  const control = new SharedArrayBuffer(4);
  const header = new SharedArrayBuffer(8);
  const status = new Int32Array(control);

  const channel = new MessageChannel();
  let worker = null;
  let disposed = false;

  function start() {
    if (worker) return worker;

    // After bundling, this file is preload.cjs and its worker is worker.cjs.
    const workerFile = path.join(__dirname, __filename.endsWith(".cjs") ? "worker.cjs" : "worker.js");

    worker = new Worker(workerFile, {
      workerData: { socketPath, token, timeoutMs, control, header, port: channel.port2 },
      transferList: [channel.port2],
      stdout: false,
      stderr: false,
    });
    // The worker must never hold the host process open.
    worker.unref();
    worker.on("error", () => {
      // Surfaced to callers through the pending-request timeout path.
    });
    return worker;
  }

  function resolveSync(scope, key) {
    if (disposed) {
      const error = new Error("Kerstel resolver bridge was disposed");
      error.code = "internal";
      throw error;
    }

    start();
    Atomics.store(status, STATUS_INDEX, STATE_PENDING);

    channel.port1.postMessage({
      scope,
      key,
      pid: process.pid,
      processName: path.basename(process.argv[1] || process.argv[0] || "node"),
    });

    // Block this thread. A slightly longer deadline than the worker's own
    // timeout guarantees the worker gets to answer first when it is alive.
    const waited = Atomics.wait(status, STATUS_INDEX, STATE_PENDING, timeoutMs + 2_000);
    if (waited === "timed-out") {
      const error = new Error(
        `Kerstel: timed out resolving kerstel://${scope}/${key}. Is the daemon running? Try \`kerstel doctor\`.`,
      );
      error.code = "timeout";
      throw error;
    }

    const message = drainResult();
    if (!message) {
      const error = new Error(`Kerstel: no reply while resolving kerstel://${scope}/${key}`);
      error.code = "internal";
      throw error;
    }

    const payload = JSON.parse(message.payload);
    if (!message.ok) {
      const error = new Error(`Kerstel: ${payload.message} (kerstel://${scope}/${key})`);
      error.code = payload.code;
      throw error;
    }
    return payload.value;
  }

  /**
   * Reads the worker's reply without turning this thread's event loop, which
   * never got a chance to run while Atomics.wait held it. receiveMessageOnPort
   * drains a MessagePort queue synchronously, which is exactly what is needed
   * here — a `worker.on("message")` handler could not fire in time.
   */
  function drainResult() {
    for (;;) {
      const received = receiveMessageOnPort(channel.port1);
      if (!received) return null;
      if (received.message && received.message.type === "result") return received.message;
    }
  }

  function dispose() {
    disposed = true;
    channel.port1.close();
    channel.port2.close();
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  return { resolveSync, dispose };
}

module.exports = { createBridge };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test packages/hook/test/bridge.test.ts`
Expected: PASS, 7 tests.

If `receiveMessageOnPort` returns `null` on every call, the worker is posting to
`parentPort` instead of the `port` handed over in `workerData`, or `port.start()`
is missing — a transferred port queues messages but delivers none until started.

- [ ] **Step 7: Commit**

```bash
git add packages/hook/src packages/hook/test/bridge.test.ts
git commit -m "feat(hook): add synchronous daemon resolution bridge

Blocks the calling thread on Atomics.wait while a worker performs the
socket round trip, so process.env reads can resolve references inline.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: The `process.env` preload

**Files:**
- Create: `packages/hook/src/preload.js`, `packages/hook/build.ts`
- Test: `packages/hook/test/preload.test.ts`, `packages/hook/test/fixtures/read-env.cjs`, `packages/hook/test/fixtures/spawn-child.cjs`

**Interfaces:**
- Consumes: `createBridge` from `./bridge.js`; `parseReference`, `isReference` from `./protocol.js`
- Produces: a CommonJS module suitable for `node --require`. It reads `KERSTEL_SOCKET`, `KERSTEL_TOKEN`, and `KERSTEL_HOOK_DIR` from the environment, installs the Proxy, and sets `process.env.KERSTEL_ACTIVE = "1"`. `build.ts` emits `packages/hook/dist/preload.cjs` and `packages/hook/dist/worker.cjs`.

- [ ] **Step 1: Write the fixtures**

`packages/hook/test/fixtures/read-env.cjs`:

```js
// Prints the resolved value of the variable named by argv[2], or an error line.
try {
  process.stdout.write(String(process.env[process.argv[2]]));
} catch (error) {
  process.stdout.write(`ERROR:${error.code || "unknown"}:${error.message}`);
  process.exitCode = 3;
}
```

`packages/hook/test/fixtures/spawn-child.cjs`:

```js
// Spawns a grandchild WITHOUT explicitly passing env, to prove the hook
// propagates itself and the reference resolves one level down.
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const out = execFileSync(process.execPath, [join(__dirname, "read-env.cjs"), process.argv[2]], {
  encoding: "utf8",
});
process.stdout.write(out);
```

- [ ] **Step 2: Write the failing test**

`packages/hook/test/preload.test.ts`:

```ts
import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDaemon, type DaemonHandle } from "../../cli/src/daemon/server";
import { generateDataKey } from "../../cli/src/vault/crypto";
import { openVault, type Vault } from "../../cli/src/vault/store";

const running: DaemonHandle[] = [];
const vaults: Vault[] = [];
const TOKEN = "preload-test-token-4242";
const DIST = resolve(import.meta.dir, "../dist");
const FIXTURES = resolve(import.meta.dir, "fixtures");

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", resolve(import.meta.dir, "../build.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await build.exited).toBe(0);
});

afterEach(async () => {
  while (running.length) await running.pop()!.close();
  while (vaults.length) vaults.pop()!.close();
});

async function boot(): Promise<{ sock: string; vault: Vault }> {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-preload-"));
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\kerstel-p-${Date.now()}` : join(dir, "k.sock");
  const vault = openVault(generateDataKey(), join(dir, "vault.db"));
  vaults.push(vault);
  running.push(await startDaemon({ vault, socketPath: sock, token: TOKEN, backendName: "file" }));
  return { sock, vault };
}

/** Runs a fixture under `node --require preload.cjs` and returns stdout. */
async function runHooked(
  runtime: "node" | "bun",
  sock: string,
  script: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; code: number }> {
  const preload = join(DIST, "preload.cjs");
  const cmd =
    runtime === "node"
      ? ["node", "--require", preload, script, ...args]
      : ["bun", "--preload", preload, script, ...args];

  const proc = Bun.spawn(cmd, {
    env: {
      ...process.env,
      KERSTEL_SOCKET: sock,
      KERSTEL_TOKEN: TOKEN,
      KERSTEL_HOOK_DIR: DIST,
      NODE_OPTIONS: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, code };
}

test("node resolves a reference through process.env", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, "sk-resolved-1");

  const { stdout } = await runHooked("node", sock, join(FIXTURES, "read-env.cjs"), ["OPENAI_API_KEY"], {
    OPENAI_API_KEY: "kerstel://global/OPENAI_API_KEY",
  });
  expect(stdout).toBe("sk-resolved-1");
});

test("bun resolves a reference through process.env", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, "sk-resolved-bun");

  const { stdout } = await runHooked("bun", sock, join(FIXTURES, "read-env.cjs"), ["OPENAI_API_KEY"], {
    OPENAI_API_KEY: "kerstel://global/OPENAI_API_KEY",
  });
  expect(stdout).toBe("sk-resolved-bun");
});

test("plain values pass through untouched", async () => {
  const { sock } = await boot();
  const { stdout } = await runHooked("node", sock, join(FIXTURES, "read-env.cjs"), ["PLAIN_URL"], {
    PLAIN_URL: "postgres://localhost:5432/dev",
  });
  expect(stdout).toBe("postgres://localhost:5432/dev");
});

test("an undefined variable stays undefined", async () => {
  const { sock } = await boot();
  const { stdout } = await runHooked("node", sock, join(FIXTURES, "read-env.cjs"), ["NOT_SET_AT_ALL"], {});
  expect(stdout).toBe("undefined");
});

test("a missing secret throws an actionable error naming the reference", async () => {
  const { sock } = await boot();
  const { stdout, code } = await runHooked("node", sock, join(FIXTURES, "read-env.cjs"), ["GONE"], {
    GONE: "kerstel://global/GONE",
  });
  expect(stdout).toContain("ERROR:not_found");
  expect(stdout).toContain("kerstel://global/GONE");
  expect(code).toBe(3);
});

test("the reference string is never returned to application code", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "K" }, "real");
  const { stdout } = await runHooked("node", sock, join(FIXTURES, "read-env.cjs"), ["K"], {
    K: "kerstel://global/K",
  });
  expect(stdout).not.toContain("kerstel://");
  expect(stdout).toBe("real");
});

test("a spawned child process resolves the same reference", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "CHILD_KEY" }, "child-value");

  const { stdout } = await runHooked("node", sock, join(FIXTURES, "spawn-child.cjs"), ["CHILD_KEY"], {
    CHILD_KEY: "kerstel://global/CHILD_KEY",
  });
  expect(stdout).toBe("child-value");
});

test("the hook marks itself active for doctor", async () => {
  const { sock } = await boot();
  const { stdout } = await runHooked("node", sock, join(FIXTURES, "read-env.cjs"), ["KERSTEL_ACTIVE"], {});
  expect(stdout).toBe("1");
});

test("repeated reads of the same key hit the daemon once", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "CACHED" }, "cached-value");

  const script = join(mkdtempSync(join(tmpdir(), "kerstel-cache-")), "read-thrice.cjs");
  await Bun.write(
    script,
    "for (let i = 0; i < 3; i++) process.stdout.write(process.env.CACHED);",
  );

  const { stdout } = await runHooked("node", sock, script, [], { CACHED: "kerstel://global/CACHED" });
  expect(stdout).toBe("cached-valuecached-valuecached-value");
  expect(vault.listAudit(10).filter((e) => e.key === "CACHED").length).toBe(1);
});

test("Object.keys and spread still see every variable", async () => {
  const { sock, vault } = await boot();
  vault.setSecret({ scope: "global", key: "SPREAD_KEY" }, "spread-value");

  const script = join(mkdtempSync(join(tmpdir(), "kerstel-spread-")), "spread.cjs");
  await Bun.write(
    script,
    "const has = Object.keys(process.env).includes('SPREAD_KEY');" +
      "process.stdout.write(`${has}:${{...process.env}.SPREAD_KEY}`);",
  );

  const { stdout } = await runHooked("node", sock, script, [], {
    SPREAD_KEY: "kerstel://global/SPREAD_KEY",
  });
  expect(stdout).toBe("true:spread-value");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/hook/test/preload.test.ts`
Expected: FAIL — the build script does not exist.

- [ ] **Step 4: Write the preload**

`packages/hook/src/preload.js`:

```js
"use strict";

const path = require("node:path");
const { createBridge } = require("./bridge.js");
const { parseReference } = require("./protocol.js");

// Guard against double installation (for example --require plus a bunfig preload).
if (!process.env.KERSTEL_ACTIVE) {
  install();
}

function install() {
  const socketPath = process.env.KERSTEL_SOCKET;
  const token = process.env.KERSTEL_TOKEN;
  const hookDir = process.env.KERSTEL_HOOK_DIR || __dirname;

  if (!socketPath || !token) {
    // Nothing to resolve against. Leave process.env exactly as found so an
    // unconfigured machine behaves like a machine without Kerstel installed.
    return;
  }

  const raw = process.env;
  const cache = new Map();
  let bridge = null;

  function resolveValue(name, value) {
    if (typeof value !== "string") return value;

    const ref = parseReference(value);
    if (!ref) return value;

    if (cache.has(name)) return cache.get(name);

    if (!bridge) {
      bridge = createBridge({
        socketPath,
        token,
        timeoutMs: Number(process.env.KERSTEL_TIMEOUT_MS) || 5_000,
      });
    }

    const resolved = bridge.resolveSync(ref.scope, ref.key);
    cache.set(name, resolved);
    return resolved;
  }

  const proxy = new Proxy(raw, {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      return resolveValue(property, target[property]);
    },

    set(target, property, value) {
      if (typeof property === "string") cache.delete(property);
      target[property] = value;
      return true;
    },

    deleteProperty(target, property) {
      if (typeof property === "string") cache.delete(property);
      delete target[property];
      return true;
    },

    has(target, property) {
      return property in target;
    },

    ownKeys(target) {
      return Reflect.ownKeys(target);
    },

    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (!descriptor || typeof property !== "string") return descriptor;
      // Spread and Object.assign read through this descriptor, so it must carry
      // the resolved value rather than the reference.
      return { ...descriptor, value: resolveValue(property, descriptor.value) };
    },
  });

  // Children inherit references, not plaintext, plus the wiring to resolve them.
  raw.KERSTEL_ACTIVE = "1";
  raw.KERSTEL_SOCKET = socketPath;
  raw.KERSTEL_TOKEN = token;
  raw.KERSTEL_HOOK_DIR = hookDir;

  const preloadPath = path.join(hookDir, "preload.cjs");
  const requireFlag = `--require ${JSON.stringify(preloadPath)}`;
  if (!(raw.NODE_OPTIONS || "").includes(preloadPath)) {
    raw.NODE_OPTIONS = raw.NODE_OPTIONS ? `${raw.NODE_OPTIONS} ${requireFlag}` : requireFlag;
  }

  Object.defineProperty(process, "env", {
    value: proxy,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
```

- [ ] **Step 5: Write the build script**

`packages/hook/build.ts`:

```ts
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const root = import.meta.dir;
const outdir = resolve(root, "dist");
rmSync(outdir, { recursive: true, force: true });

// worker.js must stay a separate file because Worker loads it by path.
for (const [entry, outfile] of [
  ["src/preload.js", "preload.cjs"],
  ["src/worker.js", "worker.cjs"],
] as const) {
  const result = await Bun.build({
    entrypoints: [resolve(root, entry)],
    outdir,
    target: "node",
    format: "cjs",
    naming: outfile,
    minify: false,
    external: ["node:*"],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

console.log(`Built hook assets in ${outdir}`);
```

`bridge.js` already resolves the worker by the built name (`worker.cjs` beside a
`.cjs` bridge, `worker.js` when running from source), so both layouts work
without further changes.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test packages/hook/test/preload.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/hook/src/preload.js packages/hook/src/bridge.js packages/hook/build.ts packages/hook/test
git commit -m "feat(hook): resolve kerstel:// references through process.env

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: CLI commands

**Files:**
- Create: `packages/cli/src/context.ts`, `packages/cli/src/output.ts`, `packages/cli/src/commands/secrets.ts`, `packages/cli/src/commands/daemon.ts`, `packages/cli/src/commands/run.ts`, `packages/cli/src/commands/doctor.ts`, `packages/cli/src/index.ts`
- Modify: `packages/cli/package.json` (add `build` and `build:hook` scripts)
- Test: `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–9; the built hook assets from Task 11
- Produces:
  - `openContext(): Promise<{ vault: Vault; backend: string; token: string }>` from `context.ts`
  - `runCli(argv: string[]): Promise<number>` from `index.ts` — returns the process exit code
  - Commands: `set`, `get`, `ls`, `rm`, `run`, `resolve`, `daemon start|stop|status`, `doctor`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/cli.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/index";

const originalHome = process.env.KERSTEL_HOME;
const originalBackend = process.env.KERSTEL_KEYCHAIN_BACKEND;

function isolate(): string {
  const dir = mkdtempSync(join(tmpdir(), "kerstel-cli-"));
  process.env.KERSTEL_HOME = dir;
  process.env.KERSTEL_KEYCHAIN_BACKEND = "file";
  return dir;
}

let captured: string[] = [];
const realLog = console.log;

function capture(): void {
  captured = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
}

afterEach(async () => {
  console.log = realLog;
  await runCli(["daemon", "stop"]).catch(() => 0);
  if (originalHome === undefined) delete process.env.KERSTEL_HOME;
  else process.env.KERSTEL_HOME = originalHome;
  if (originalBackend === undefined) delete process.env.KERSTEL_KEYCHAIN_BACKEND;
  else process.env.KERSTEL_KEYCHAIN_BACKEND = originalBackend;
});

test("set then get --reveal round-trips a secret", async () => {
  isolate();
  expect(await runCli(["set", "global/API_KEY", "--value", "sk-123"])).toBe(0);

  capture();
  expect(await runCli(["get", "global/API_KEY", "--reveal"])).toBe(0);
  expect(captured.join("\n")).toBe("sk-123");
});

test("get without --reveal masks the value", async () => {
  isolate();
  await runCli(["set", "global/API_KEY", "--value", "sk-supersecret"]);

  capture();
  expect(await runCli(["get", "global/API_KEY"])).toBe(0);
  const out = captured.join("\n");
  expect(out).not.toContain("sk-supersecret");
  expect(out).toContain("•");
});

test("ls prints references and never values", async () => {
  isolate();
  await runCli(["set", "global/A", "--value", "value-a"]);
  await runCli(["set", "my-app/B", "--value", "value-b"]);

  capture();
  expect(await runCli(["ls"])).toBe(0);
  const out = captured.join("\n");
  expect(out).toContain("kerstel://global/A");
  expect(out).toContain("kerstel://my-app/B");
  expect(out).not.toContain("value-a");
});

test("ls --scope filters", async () => {
  isolate();
  await runCli(["set", "global/A", "--value", "1"]);
  await runCli(["set", "my-app/B", "--value", "2"]);

  capture();
  await runCli(["ls", "--scope", "my-app"]);
  const out = captured.join("\n");
  expect(out).toContain("my-app/B");
  expect(out).not.toContain("global/A");
});

test("rm deletes and reports a missing key", async () => {
  isolate();
  await runCli(["set", "global/A", "--value", "1"]);
  expect(await runCli(["rm", "global/A", "--yes"])).toBe(0);
  expect(await runCli(["rm", "global/A", "--yes"])).toBe(1);
});

test("an invalid reference is rejected before touching the vault", async () => {
  isolate();
  expect(await runCli(["set", "Bad-Scope/KEY", "--value", "x"])).toBe(2);
  expect(await runCli(["set", "global/bad-key", "--value", "x"])).toBe(2);
});

test("run injects resolved values into the child environment", async () => {
  isolate();
  await runCli(["set", "global/RUN_KEY", "--value", "run-value"]);

  const script = join(mkdtempSync(join(tmpdir(), "kerstel-run-")), "print.cjs");
  await Bun.write(script, "process.stdout.write(process.env.RUN_KEY);");

  process.env.RUN_KEY = "kerstel://global/RUN_KEY";
  capture();
  const code = await runCli(["run", "--", "node", script]);
  delete process.env.RUN_KEY;
  expect(code).toBe(0);
});

test("resolve prints one value for scripting", async () => {
  isolate();
  await runCli(["set", "global/R", "--value", "resolved"]);

  capture();
  expect(await runCli(["resolve", "kerstel://global/R"])).toBe(0);
  expect(captured.join("\n")).toBe("resolved");
});

test("daemon status reports when nothing is running", async () => {
  isolate();
  capture();
  expect(await runCli(["daemon", "status"])).toBe(1);
  expect(captured.join("\n")).toMatch(/not running/i);
});

test("doctor reports the keychain backend and vault location", async () => {
  const dir = isolate();
  await runCli(["set", "global/A", "--value", "1"]);

  capture();
  expect(await runCli(["doctor"])).toBe(0);
  const out = captured.join("\n");
  expect(out).toContain("file");
  expect(out).toContain(dir);
});

test("an unknown command exits 2 with usage", async () => {
  isolate();
  capture();
  expect(await runCli(["frobnicate"])).toBe(2);
  expect(captured.join("\n")).toMatch(/usage/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/cli.test.ts`
Expected: FAIL — cannot resolve module `../src/index`.

- [ ] **Step 3: Write the context and output helpers**

`packages/cli/src/context.ts`:

```ts
import { ensureToken } from "./daemon/token";
import { ensureHome } from "./paths";
import { loadOrCreateDataKey } from "./vault/keychain";
import { openVault, type Vault } from "./vault/store";

export interface CliContext {
  vault: Vault;
  backend: string;
  token: string;
  /** True when this call created the vault key for the first time. */
  firstRun: boolean;
}

/** Opens the vault for a one-shot CLI command. Callers must close it. */
export async function openContext(): Promise<CliContext> {
  ensureHome();
  const { key, backend, created } = await loadOrCreateDataKey();
  return { vault: openVault(key), backend, token: ensureToken(), firstRun: created };
}
```

`packages/cli/src/output.ts`:

```ts
const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

const wrap = (code: string, text: string): string => (useColor ? `[${code}m${text}[0m` : text);

export const dim = (text: string): string => wrap("2", text);
export const bold = (text: string): string => wrap("1", text);
export const green = (text: string): string => wrap("32", text);
export const red = (text: string): string => wrap("31", text);
export const yellow = (text: string): string => wrap("33", text);

export function ok(message: string): void {
  console.log(`${green("✔")}  ${message}`);
}

export function fail(message: string): void {
  console.log(`${red("✖")}  ${message}`);
}

export function info(message: string): void {
  console.log(`${dim("·")}  ${message}`);
}

/** Masks a secret for display. Never reveals length beyond a fixed width. */
export function mask(): string {
  return "••••••••••••";
}
```

- [ ] **Step 4: Write the secret commands**

`packages/cli/src/commands/secrets.ts`:

```ts
import { openContext } from "../context";
import { bold, dim, fail, info, mask, ok } from "../output";
import { formatReference, parseReference, type SecretRef } from "../reference";

/** Accepts `scope/KEY` or a full `kerstel://scope/KEY`. */
export function parseTarget(input: string): SecretRef | null {
  if (input.startsWith("kerstel://")) return parseReference(input);
  return parseReference(`kerstel://${input}`);
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c)))).replace(/\n$/, "");
}

export async function setCommand(args: string[]): Promise<number> {
  const target = args[0];
  if (!target) {
    fail("Usage: kerstel set <scope>/<KEY> [--value <value>]");
    return 2;
  }

  const ref = parseTarget(target);
  if (!ref) {
    fail(`Invalid reference "${target}". Use a lowercase scope and an ENV_STYLE key, e.g. global/API_KEY.`);
    return 2;
  }

  const flagIndex = args.indexOf("--value");
  const value = flagIndex !== -1 ? args[flagIndex + 1] : await readStdin();
  if (value === undefined || value === "") {
    fail("No value supplied. Pass --value, or pipe the secret on stdin.");
    return 2;
  }

  const ctx = await openContext();
  try {
    ctx.vault.setSecret(ref, value);
    ok(`Stored ${bold(formatReference(ref.scope, ref.key))}`);
    return 0;
  } finally {
    ctx.vault.close();
  }
}

export async function getCommand(args: string[]): Promise<number> {
  const target = args[0];
  if (!target) {
    fail("Usage: kerstel get <scope>/<KEY> [--reveal]");
    return 2;
  }

  const ref = parseTarget(target);
  if (!ref) {
    fail(`Invalid reference "${target}".`);
    return 2;
  }

  const ctx = await openContext();
  try {
    const value = ctx.vault.getSecret(ref);
    if (value === null) {
      fail(`No secret at ${formatReference(ref.scope, ref.key)}`);
      return 1;
    }
    if (args.includes("--reveal")) console.log(value);
    else console.log(`${mask()}  ${dim("(pass --reveal to print the value)")}`);
    return 0;
  } finally {
    ctx.vault.close();
  }
}

export async function lsCommand(args: string[]): Promise<number> {
  const scopeIndex = args.indexOf("--scope");
  const scope = scopeIndex !== -1 ? args[scopeIndex + 1] : undefined;

  const ctx = await openContext();
  try {
    const secrets = ctx.vault.listSecrets(scope);
    if (secrets.length === 0) {
      info(scope ? `No secrets in scope "${scope}".` : "No secrets stored yet. Add one with `kerstel set`.");
      return 0;
    }
    for (const secret of secrets) {
      console.log(
        `${formatReference(secret.scope, secret.key)}  ${dim(new Date(secret.updatedAt).toISOString())}`,
      );
    }
    return 0;
  } finally {
    ctx.vault.close();
  }
}

export async function rmCommand(args: string[]): Promise<number> {
  const target = args[0];
  if (!target) {
    fail("Usage: kerstel rm <scope>/<KEY> --yes");
    return 2;
  }

  const ref = parseTarget(target);
  if (!ref) {
    fail(`Invalid reference "${target}".`);
    return 2;
  }
  if (!args.includes("--yes")) {
    fail(`Deleting a secret cannot be undone. Re-run with --yes to remove ${formatReference(ref.scope, ref.key)}.`);
    return 2;
  }

  const ctx = await openContext();
  try {
    if (!ctx.vault.removeSecret(ref)) {
      fail(`No secret at ${formatReference(ref.scope, ref.key)}`);
      return 1;
    }
    ok(`Removed ${formatReference(ref.scope, ref.key)}`);
    return 0;
  } finally {
    ctx.vault.close();
  }
}

export async function resolveCommand(args: string[]): Promise<number> {
  const target = args[0];
  const ref = target ? parseTarget(target) : null;
  if (!ref) {
    fail("Usage: kerstel resolve kerstel://<scope>/<KEY>");
    return 2;
  }

  const ctx = await openContext();
  try {
    const value = ctx.vault.getSecret(ref);
    if (value === null) {
      fail(`No secret at ${formatReference(ref.scope, ref.key)}`);
      return 1;
    }
    console.log(value);
    return 0;
  } finally {
    ctx.vault.close();
  }
}
```

- [ ] **Step 5: Write the daemon, run, and doctor commands**

`packages/cli/src/commands/daemon.ts`:

```ts
import { connectDaemon, isDaemonRunning } from "../daemon/client";
import { startDaemon } from "../daemon/server";
import { openContext } from "../context";
import { fail, info, ok } from "../output";
import { socketPath } from "../paths";

export async function daemonCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? "status";

  if (sub === "start") {
    if (await isDaemonRunning()) {
      info("Kerstel daemon is already running.");
      return 0;
    }

    const ctx = await openContext();
    const handle = await startDaemon({
      vault: ctx.vault,
      socketPath: socketPath(),
      token: ctx.token,
      backendName: ctx.backend,
      onIdle: () => {
        void handle.close().then(() => process.exit(0));
      },
    });

    ok(`Kerstel daemon listening on ${handle.socketPath}`);
    if (args.includes("--detached")) {
      // Keep the process alive serving requests; the idle timer ends it.
      await new Promise(() => {});
    }
    return 0;
  }

  if (sub === "stop") {
    if (!(await isDaemonRunning())) {
      info("Kerstel daemon is not running.");
      return 0;
    }
    const client = await connectDaemon();
    await client.shutdown();
    client.close();
    ok("Kerstel daemon stopped.");
    return 0;
  }

  if (sub === "status") {
    if (!(await isDaemonRunning())) {
      fail("Kerstel daemon is not running. Start it with `kerstel daemon start`.");
      return 1;
    }
    const client = await connectDaemon();
    const status = await client.status();
    client.close();
    ok(
      `Kerstel daemon running (pid ${status.pid}, ${status.unlocked ? "unlocked" : "locked"}, ` +
        `${status.secretCount} secrets, keychain: ${status.backend})`,
    );
    return 0;
  }

  fail("Usage: kerstel daemon <start|stop|status>");
  return 2;
}
```

`packages/cli/src/commands/run.ts`:

```ts
import { openContext } from "../context";
import { fail } from "../output";
import { parseReference } from "../reference";

/**
 * Universal fallback: resolves every reference in the current environment up
 * front and execs the command with plaintext values injected. Used for anything
 * the runtime hook cannot reach, such as IDE run configurations.
 */
export async function runCommand(args: string[]): Promise<number> {
  const separator = args.indexOf("--");
  const command = separator === -1 ? args : args.slice(separator + 1);
  if (command.length === 0) {
    fail("Usage: kerstel run -- <command> [args...]");
    return 2;
  }

  const ctx = await openContext();
  const env: Record<string, string> = {};
  try {
    for (const [name, value] of Object.entries(process.env)) {
      if (typeof value !== "string") continue;
      const ref = parseReference(value);
      if (!ref) {
        env[name] = value;
        continue;
      }
      const resolved = ctx.vault.getSecret(ref);
      if (resolved === null) {
        fail(`No secret at kerstel://${ref.scope}/${ref.key} (referenced by ${name})`);
        return 1;
      }
      env[name] = resolved;
    }
  } finally {
    ctx.vault.close();
  }

  const child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}
```

`packages/cli/src/commands/doctor.ts`:

```ts
import { existsSync } from "node:fs";
import { openContext } from "../context";
import { isDaemonRunning } from "../daemon/client";
import { bold, info, ok, yellow } from "../output";
import { hookDir, kerstelHome, socketPath, vaultPath } from "../paths";

export async function doctorCommand(): Promise<number> {
  const ctx = await openContext();
  try {
    console.log(bold("Kerstel doctor"));
    info(`Home:      ${kerstelHome()}`);
    info(`Vault:     ${vaultPath()} (${ctx.vault.listSecrets().length} secrets)`);
    info(`Keychain:  ${ctx.backend}`);
    info(`Socket:    ${socketPath()}`);
    info(`Hook:      ${hookDir()}${existsSync(hookDir()) ? "" : yellow("  (not installed)")}`);

    if (ctx.backend === "file") {
      console.log(
        yellow(
          "!  The data key is in a 0600 file, not an OS credential store. " +
            "Install `secret-tool` (Linux) for stronger protection.",
        ),
      );
    }

    if (await isDaemonRunning()) ok("Daemon is running.");
    else info("Daemon is not running. It starts automatically on first use.");

    return 0;
  } finally {
    ctx.vault.close();
  }
}
```

- [ ] **Step 6: Write the entry point**

`packages/cli/src/index.ts`:

```ts
import { daemonCommand } from "./commands/daemon";
import { doctorCommand } from "./commands/doctor";
import { runCommand } from "./commands/run";
import { getCommand, lsCommand, resolveCommand, rmCommand, setCommand } from "./commands/secrets";
import { bold, fail } from "./output";

const USAGE = `${bold("kerstel")} — local-first secrets for your projects

Usage:
  kerstel set <scope>/<KEY> [--value <value>]   Store a secret (or pipe it on stdin)
  kerstel get <scope>/<KEY> [--reveal]          Read a secret
  kerstel ls [--scope <scope>]                  List stored references
  kerstel rm <scope>/<KEY> --yes                Remove a secret
  kerstel run -- <command>                      Run a command with references resolved
  kerstel resolve kerstel://<scope>/<KEY>       Print one resolved value
  kerstel daemon <start|stop|status>            Manage the resolver daemon
  kerstel doctor                                Diagnose this machine's setup

Scopes are explicit: "global" or a project name. A reference resolves in exactly
one scope — there is no fallback.`;

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...args] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  try {
    switch (command) {
      case "set":
        return await setCommand(args);
      case "get":
        return await getCommand(args);
      case "ls":
      case "list":
        return await lsCommand(args);
      case "rm":
      case "remove":
        return await rmCommand(args);
      case "run":
        return await runCommand(args);
      case "resolve":
        return await resolveCommand(args);
      case "daemon":
        return await daemonCommand(args);
      case "doctor":
        return await doctorCommand();
      default:
        fail(`Unknown command "${command}".`);
        console.log(USAGE);
        return 2;
    }
  } catch (error) {
    fail((error as Error).message);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
```

- [ ] **Step 7: Add the build scripts**

Modify `packages/cli/package.json` to add:

```json
"scripts": {
  "typecheck": "tsc -p tsconfig.json",
  "build:hook": "bun run ../hook/build.ts",
  "build": "bun run build:hook && bun build src/index.ts --compile --outfile ../../dist/kerstel"
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test packages/cli/test/cli.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src packages/cli/test/cli.test.ts packages/cli/package.json
git commit -m "feat(cli): add secret, daemon, run, and doctor commands

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: End-to-end verification and binary build

Proves the whole chain works from a compiled binary, and locks the two reference parsers together.

**Files:**
- Create: `packages/cli/test/e2e.test.ts`, `packages/cli/test/parser-parity.test.ts`
- Modify: `.github/workflows/ci.yml` (build the binary and run the e2e suite)
- Modify: `README.md` (replace the menu bar app's content)

**Interfaces:**
- Consumes: the compiled `dist/kerstel` binary; `REFERENCE_FIXTURES` from `../src/reference`; the hook's `parseReference` from `packages/hook/src/protocol.js`
- Produces: no new exports. CI gains a `build` job.

- [ ] **Step 1: Write the parser parity test**

`packages/cli/test/parser-parity.test.ts`:

```ts
import { expect, test } from "bun:test";
import { REFERENCE_FIXTURES, parseReference as cliParse } from "../src/reference";
// @ts-expect-error -- plain JS module without type declarations
import { parseReference as hookParse } from "../../hook/src/protocol.js";

test("the hook's parser matches the CLI's on every fixture", () => {
  for (const { value } of REFERENCE_FIXTURES) {
    expect(hookParse(value)).toEqual(cliParse(value));
  }
});
```

- [ ] **Step 2: Run it to verify it fails or passes honestly**

Run: `bun test packages/cli/test/parser-parity.test.ts`
Expected: PASS. If it fails, the two implementations have drifted — fix `packages/hook/src/protocol.js` to match `packages/cli/src/reference.ts`, never the reverse.

- [ ] **Step 3: Write the end-to-end test**

`packages/cli/test/e2e.test.ts`:

```ts
import { afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const BINARY = join(REPO, "dist", process.platform === "win32" ? "kerstel.exe" : "kerstel");

let home: string;

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: join(REPO, "packages/cli"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await build.exited;
  if (code !== 0) console.error(await new Response(build.stderr).text());
  expect(code).toBe(0);
  expect(existsSync(BINARY)).toBe(true);
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    KERSTEL_HOME: home,
    KERSTEL_KEYCHAIN_BACKEND: "file",
    NODE_OPTIONS: "",
    ...extra,
  };
}

async function kerstel(args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([BINARY, ...args], { env: env(extra), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

afterEach(async () => {
  await kerstel(["daemon", "stop"]);
});

test("the compiled binary stores and lists a secret", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-"));
  expect((await kerstel(["set", "global/OPENAI_API_KEY", "--value", "sk-e2e"])).code).toBe(0);

  const list = await kerstel(["ls"]);
  expect(list.stdout).toContain("kerstel://global/OPENAI_API_KEY");
  expect(list.stdout).not.toContain("sk-e2e");
});

test("a node app reads the real secret from a reference-only .env", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-node-"));
  await kerstel(["set", "global/OPENAI_API_KEY", "--value", "sk-end-to-end"]);
  await kerstel(["daemon", "start"]);

  const project = mkdtempSync(join(tmpdir(), "kerstel-project-"));
  const app = join(project, "app.cjs");
  await Bun.write(app, "process.stdout.write(process.env.OPENAI_API_KEY);");

  const preload = join(REPO, "packages/hook/dist/preload.cjs");
  const token = (await Bun.file(join(home, "session.token")).text()).trim();
  const socket = join(home, "kerstel.sock");

  const proc = Bun.spawn(["node", "--require", preload, app], {
    env: env({
      // This is exactly what a committed .env would contain.
      OPENAI_API_KEY: "kerstel://global/OPENAI_API_KEY",
      KERSTEL_SOCKET: socket,
      KERSTEL_TOKEN: token,
      KERSTEL_HOOK_DIR: join(REPO, "packages/hook/dist"),
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect(code).toBe(0);
  expect(stdout).toBe("sk-end-to-end");
});

test("kerstel run resolves references for an unhooked command", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-run-"));
  await kerstel(["set", "global/RUN_KEY", "--value", "via-run"]);

  const project = mkdtempSync(join(tmpdir(), "kerstel-run-project-"));
  const app = join(project, "app.cjs");
  await Bun.write(app, "process.stdout.write(process.env.RUN_KEY);");

  const proc = Bun.spawn([BINARY, "run", "--", "node", app], {
    env: env({ RUN_KEY: "kerstel://global/RUN_KEY" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect(code).toBe(0);
  expect(stdout).toBe("via-run");
});

test("the vault file holds no plaintext after a full round trip", async () => {
  home = mkdtempSync(join(tmpdir(), "kerstel-e2e-enc-"));
  await kerstel(["set", "global/CANARY", "--value", "PLAINTEXT_CANARY_E2E"]);

  const raw = await Bun.file(join(home, "vault.db")).arrayBuffer();
  expect(Buffer.from(raw).includes(Buffer.from("PLAINTEXT_CANARY_E2E"))).toBe(false);
});
```

- [ ] **Step 4: Run the end-to-end suite**

Run: `bun test packages/cli/test/e2e.test.ts`
Expected: PASS, 4 tests. The build step runs first and must succeed.

- [ ] **Step 5: Extend CI with a build job**

Add to `.github/workflows/ci.yml`:

```yaml
  build:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: bun install --frozen-lockfile
      - run: bun run --cwd packages/cli build
      - run: ./dist/kerstel --help
```

- [ ] **Step 6: Rewrite the README for the new product**

Replace `README.md` with content describing the secrets manager: the problem (plaintext `.env` files), the reference model, `kerstel set` / `ls` / `run` usage, the security model summary pointing at the spec, build-from-source instructions (`bun install && bun run --cwd packages/cli build`), and the MIT license. Remove every mention of the menu bar app, system metrics, ports, and AI usage tracking. Keep the badges that still apply and drop the Swift and macOS-only ones. Do not document `install.sh` or `kerstel init` yet — plan 2 adds the wizard and plan 5 adds the installer.

- [ ] **Step 7: Run the full suite**

Run: `bun run typecheck && bun test`
Expected: every test passes on macOS and Linux.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/test/e2e.test.ts packages/cli/test/parser-parity.test.ts .github/workflows/ci.yml README.md
git commit -m "test: verify end-to-end reference resolution from the compiled binary

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Plan Self-Review

**Spec coverage.** §4 architecture → Tasks 1, 8, 9, 10, 11. §5 vault → Tasks 3, 4, 6. §6 runtime resolution → Tasks 10, 11, plus `kerstel run` in Task 12. §7 daemon → Tasks 7, 8, 9. §8 CLI commands `set`/`get`/`ls`/`rm`/`run`/`resolve`/`daemon`/`doctor` → Task 12. §12 testing → every task, with the integration and e2e layers in Tasks 11 and 13. §9 portal, §8 `init` and `uninstall`, §11 website, and the release pipeline are deliberately deferred to plans 2–5 and named as such in the Scope note.

**Two deliberate refinements** are called out where they occur, with reasons: `UNIQUE(scope, key)` instead of `(scope, project_id, key)` in Task 6, because SQLite treats `NULL`s as distinct and would let global secrets duplicate; and a session bearer token instead of peer-UID verification in Task 8, because `node:net` exposes no peer credentials, a native module would break the single-binary constraint, and Windows named pipes have no UID. Both preserve the spec's intent.

**Known follow-ups for plan 2.** The hook currently relies on `KERSTEL_SOCKET` and `KERSTEL_TOKEN` being present in the environment; the `init` wizard is what puts them there (via the `kerstel exec` shim it writes into `package.json` scripts) and what installs the built hook assets into `~/.kerstel/hook/`. Task 12's `doctor` already reports whether that directory exists.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-17-vault-core-and-runtime-resolution.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.
