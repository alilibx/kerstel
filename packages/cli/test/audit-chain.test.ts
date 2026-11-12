import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatChain, processChain, systemProcessLookup, type ProcessLookup } from "../src/audit/chain";

function table(rows: Array<[number, number, string]>): ProcessLookup {
  const map = new Map(rows.map(([pid, ppid, name]) => [pid, { ppid, name }]));
  return (pid) => map.get(pid) ?? null;
}

test("walks to the terminal and stops there", () => {
  const lookup = table([
    [100, 90, "kerstel"],
    [90, 80, "zsh"],
    [80, 70, "claude"],
    [70, 60, "zsh"],
    [60, 1, "Terminal"],
    [1, 0, "launchd"],
  ]);
  expect(processChain(100, lookup)).toEqual(["kerstel", "zsh", "claude", "zsh", "Terminal"]);
});

test("strips a login shell's dash and a path", () => {
  const lookup = table([
    [30, 20, "/usr/local/bin/node"],
    [20, 10, "/bin/-zsh"],
    [10, 1, "-zsh"],
  ]);
  expect(processChain(30, lookup)).toEqual(["node", "zsh", "zsh"]);
});

test("stops before launchd and at six names", () => {
  const short = table([
    [3, 2, "a"],
    [2, 5, "launchd"],
  ]);
  expect(processChain(3, short)).toEqual(["a"]);

  const long = table([
    [10, 9, "a"],
    [9, 8, "b"],
    [8, 7, "c"],
    [7, 6, "d"],
    [6, 5, "e"],
    [5, 4, "f"],
    [4, 3, "g"],
  ]);
  expect(processChain(10, long)).toEqual(["a", "b", "c", "d", "e", "f"]);
});

test("survives a cycle and a missing parent", () => {
  const cycle = table([
    [10, 9, "a"],
    [9, 10, "b"],
  ]);
  expect(processChain(10, cycle)).toEqual(["a", "b"]);
  expect(processChain(10, table([[10, 99, "a"]]))).toEqual(["a"]);
  expect(processChain(10, table([]))).toEqual([]);
});

test("formatChain renders unknown for null and []", () => {
  expect(formatChain(null)).toBe("unknown");
  expect(formatChain([])).toBe("unknown");
  expect(formatChain(["a", "b"])).toBe("a ← b");
});

test("systemProcessLookup never throws when ps is missing", () => {
  const empty = mkdtempSync(join(tmpdir(), "kerstel-chain-"));
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = empty;
    const chain = processChain(process.pid, systemProcessLookup());
    expect(Array.isArray(chain)).toBe(true);
    for (const name of chain) expect(typeof name).toBe("string");
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(empty, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")("systemProcessLookup finds this process", () => {
  const chain = processChain(process.pid, systemProcessLookup());
  expect(chain.length).toBeGreaterThan(0);
  expect(chain[0]).toBe("bun");
});
