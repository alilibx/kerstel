import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/index";

describe("parseArgs", () => {
  test("defaults, then environment, then flags", () => {
    expect(parseArgs([], {})).toEqual({
      db: "kerstel-server.db",
      hostname: "127.0.0.1",
      port: 8787,
      enrollToken: null,
      enrollTokenFile: null,
      trustProxy: false,
      tls: { mode: "off" },
    });
    expect(parseArgs([], { KERSTEL_SERVER_LISTEN: "0.0.0.0:9000", KERSTEL_SERVER_DB: "/data/x.db" })).toMatchObject({
      hostname: "0.0.0.0",
      port: 9000,
      db: "/data/x.db",
    });
    expect(parseArgs(["--listen", "[::1]:80", "--trust-proxy"], {})).toMatchObject({ hostname: "::1", port: 80, trustProxy: true });
  });

  test("takes the enroll token from a file, never from argv", () => {
    // The file is read, or created, when the server starts: see server.test.ts.
    expect(parseArgs(["--enroll-token-file", "/data/enroll-token"], {})).toMatchObject({
      enrollToken: null,
      enrollTokenFile: "/data/enroll-token",
    });
  });

  test("rejects bad input", () => {
    expect(() => parseArgs(["--listen", "8787"], {})).toThrow("host:port");
    expect(() => parseArgs(["--listen", "h:70000"], {})).toThrow("out of range");
    expect(() => parseArgs(["--db"], {})).toThrow("needs a value");
    expect(() => parseArgs(["--enroll-token", "x"], {})).toThrow("Unknown option");
    expect(parseArgs(["--version"], {})).toBe("version");
  });
});

describe("the server process", () => {
  let dir: string;
  let proc: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kerstel-server-proc-"));
  });
  afterAll(() => {
    proc?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("starts, answers health, and keeps its database private", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const db = join(dir, "server.db");
    proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "--db", db, "--listen", `127.0.0.1:${port}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    let res: Response | null = null;
    for (let i = 0; i < 50 && !res; i++) {
      try {
        res = await fetch(`http://127.0.0.1:${port}/v1/health`);
      } catch {
        await Bun.sleep(100);
      }
    }
    expect(res?.status).toBe(200);
    expect(((await res!.json()) as { version: string }).version).toMatch(/^0\.3\.0-dev$/);
    if (process.platform !== "win32") expect(statSync(db).mode & 0o777).toBe(0o600);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    proc = null;
  });
});
