import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditCommand } from "../src/commands/audit";
import { auditReport, parseSince, ROTATE_HINT, shouldRotate } from "../src/audit/report";
import { generateDataKey } from "../src/vault/crypto";
import { loadOrCreateDataKey } from "../src/vault/keychain";
import { openVault, type AuditEntry, type Vault } from "../src/vault/store";
import { captureLog } from "./helpers/capture-log";
import { isolateEnv, restoreEnv } from "./helpers/isolate-env";

const open: Vault[] = [];
const dirs: string[] = [];
let log: ReturnType<typeof captureLog> | null = null;

afterEach(() => {
  log?.restore();
  log = null;
  while (open.length) open.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  restoreEnv();
});

function memVault(): Vault {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "kerstel-audit-cmd-")));
  dirs.push(d);
  const v = openVault(generateDataKey(), join(d, "vault.db"));
  open.push(v);
  return v;
}

async function seedHome(fn: (v: Vault) => void): Promise<void> {
  isolateEnv({ prefix: "audit-cmd" });
  const v = openVault((await loadOrCreateDataKey()).key);
  fn(v);
  v.close();
}

const NOW = Date.now();
const row = (over: Partial<AuditEntry>): AuditEntry => ({
  ts: NOW - 1000,
  event: "reveal",
  scope: "global",
  key: "OPENAI_API_KEY",
  pid: 100,
  processName: "kerstel",
  chain: ["kerstel", "zsh", "claude"],
  ...over,
});

async function run(args: string[]): Promise<{ code: number; text: string }> {
  log = captureLog();
  const code = await auditCommand(args);
  const text = log.text();
  log.restore();
  log = null;
  return { code, text };
}

const CREDENTIAL = "sk-live-4f9a8c7d6e5b3a2109876543210fedcba";

test("parseSince", () => {
  const now = new Date(2026, 10, 13, 12, 0).getTime();
  expect(parseSince("7d", now)).toEqual({ since: now - 7 * 86_400_000, label: "Last 7 days" });
  expect(parseSince("1d", now)?.label).toBe("Last 1 day");
  expect(parseSince("24h", now)).toEqual({ since: now - 24 * 3_600_000, label: "Last 24 hours" });
  expect(parseSince("2026-11-01", now)).toEqual({ since: new Date(2026, 10, 1).getTime(), label: "Since 2026-11-01" });
  expect(parseSince("soon", now)).toBeNull();
  expect(parseSince("2026-13-45", now)).toBeNull();
});

test("shouldRotate is true only for an unchanged credential that still exists", () => {
  const v = memVault();
  v.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, CREDENTIAL);
  v.setSecret({ scope: "global", key: "LOG_LEVEL" }, "debug");
  const after = Date.now() + 10;
  const mk = (key: string, ts: number) => ({
    id: 1, ts, event: "reveal" as const, scope: "global", key, pid: 1, processName: "kerstel", chain: null, project: null,
  });
  expect(shouldRotate(v, mk("OPENAI_API_KEY", after))).toBe(true);
  expect(shouldRotate(v, mk("LOG_LEVEL", after))).toBe(false);
  // changed after the reveal
  expect(shouldRotate(v, mk("OPENAI_API_KEY", 1))).toBe(false);
  expect(shouldRotate(v, { ...mk("OPENAI_API_KEY", after), event: "set" })).toBe(false);
});

test("shouldRotate never decrypts a secret that no longer exists", () => {
  const v = memVault();
  let reads = 0;
  const real = v.getSecret.bind(v);
  v.getSecret = (ref) => {
    reads++;
    return real(ref);
  };
  const r = { id: 1, ts: Date.now(), event: "reveal" as const, scope: "global", key: "GONE_KEY", pid: 1, processName: "kerstel", chain: null, project: null };
  expect(shouldRotate(v, r)).toBe(false);
  expect(reads).toBe(0);
});

test("kerstel audit lists reveals first with the hint, groups app reads, and lists changes", async () => {
  await seedHome((v) => {
    v.registerProject("web", "/tmp/kerstel-audit-web");
    v.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, CREDENTIAL);
    v.appendAudit(row({ ts: Date.now() + 50 })); // after the secret was stored, so it is still the live value
    v.appendAudit(row({ event: "resolve", scope: "web", key: "DATABASE_URL", processName: "node", pid: 7, cwd: "/tmp/kerstel-audit-web" }));
    v.appendAudit(row({ event: "resolve", scope: "web", key: "OPENAI_API_KEY", processName: "node", pid: 8, cwd: "/tmp/kerstel-audit-web" }));
    v.appendAudit(row({ event: "set", chain: ["kerstel", "zsh", "Terminal"] }));
    v.appendAudit(row({ event: "device", scope: "", key: "", chain: null }));
  });
  const { code, text } = await run([]);
  expect(code).toBe(0);
  const lines = text.split("\n");
  expect(lines[0]).toBe("Last 7 days");
  expect(text).toContain("Reveals     1");
  expect(text).toContain("App reads   2 by 2 processes in 1 project");
  // the setSecret above wrote a set row of its own
  expect(text).toContain("Changes     3");
  const iR = lines.indexOf("Reveals");
  const iA = lines.indexOf("App reads");
  const iC = lines.indexOf("Changes");
  expect(iR).toBeGreaterThan(0);
  expect(iA).toBeGreaterThan(iR);
  expect(iC).toBeGreaterThan(iA);
  expect(lines[iR + 1]).toMatch(/^ {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}ks:global\/OPENAI_API_KEY {2}kerstel ← zsh ← claude$/);
  expect(lines[iR + 2]).toBe(`${" ".repeat(20)}${ROTATE_HINT}`);
  expect(lines[iA + 1]).toBe("  web  node  DATABASE_URL, OPENAI_API_KEY  2 processes");
  expect(text).toMatch(/ {2}set {2,}ks:global\/OPENAI_API_KEY {2}kerstel ← zsh ← Terminal/);
  expect(text).toMatch(/ {2}device {2,}— {2,}unknown/);
});

test("the value of a revealed credential appears nowhere in the output", async () => {
  await seedHome((v) => {
    v.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, CREDENTIAL);
    v.appendAudit(row({ ts: Date.now() + 50 }));
  });
  const { text } = await run([]);
  expect(text).toContain("ks:global/OPENAI_API_KEY");
  expect(text).toContain(ROTATE_HINT);
  expect(text).not.toContain(CREDENTIAL);
  expect(text).not.toContain("4f9a8c7d");
});

test("rows from before this version show unknown", async () => {
  await seedHome((v) => v.appendAudit(row({ chain: null })));
  const { text } = await run([]);
  expect(text).toMatch(/ks:global\/OPENAI_API_KEY {2}unknown/);
});

test("--action resolve lists rows instead of groups", async () => {
  await seedHome((v) => {
    v.appendAudit(row({ event: "resolve", scope: "web", key: "DATABASE_URL", processName: "node", pid: 7 }));
    v.appendAudit(row({ event: "set" }));
  });
  const { code, text } = await run(["--action", "resolve"]);
  expect(code).toBe(0);
  expect(text).toMatch(/\d{2}:\d{2} {2}resolve {2}ks:web\/DATABASE_URL {2}node {2}kerstel ← zsh ← claude/);
  expect(text).toContain("Changes     0");
  expect(text).not.toContain("outside a project");
  expect(text.split("\n")).not.toContain("Changes");
});

test("a group with no project says outside a project", async () => {
  await seedHome((v) => v.appendAudit(row({ event: "resolve", scope: "web", key: "A", processName: "node" })));
  const { text } = await run([]);
  expect(text).toContain("outside a project  node  A  1 process");
});

test("bad flags exit 2", async () => {
  await seedHome(() => {});
  expect((await run(["--action", "bogus"])).code).toBe(2);
  expect((await run(["--action", "bogus"])).text).toContain("resolve, run, reveal, set, remove, sync, device");
  expect((await run(["--limit", "0"])).code).toBe(2);
  expect((await run(["--limit", "100000000000000000000"])).code).toBe(2);
  expect((await run(["--since", "soon"])).code).toBe(2);
  expect((await run(["--nope"])).code).toBe(2);
});

test("an empty log says nothing was recorded and exits 0", async () => {
  await seedHome(() => {});
  const { code, text } = await run([]);
  expect(code).toBe(0);
  expect(text).toBe("Nothing recorded in the last 7 days.");
});

test("auditReport bounds sections by limit but counts by period", () => {
  const v = memVault();
  for (let i = 0; i < 3; i++) v.appendAudit(row({ ts: NOW - i }));
  const r = auditReport(v, { since: NOW - 10_000, limit: 2 });
  expect(r.counts.reveals).toBe(3);
  expect(r.reveals.length).toBe(2);
});

test("the default limit lists 30 reveals", async () => {
  await seedHome((v) => {
    for (let i = 0; i < 30; i++) v.appendAudit(row({ ts: NOW - i, key: `KEY_${i}` }));
  });
  const { text } = await run([]);
  expect(text.match(/ks:global\/KEY_\d+/g)?.length).toBe(30);
});

test("an empty log with a date says since, and with hours says last", async () => {
  await seedHome(() => {});
  expect((await run(["--since", "2026-11-01"])).text).toBe("Nothing recorded since 2026-11-01.");
  expect((await run(["--since", "24h"])).text).toBe("Nothing recorded in the last 24 hours.");
});

test("shouldRotate is false when the secret cannot be read", () => {
  const v = memVault();
  v.setSecret({ scope: "global", key: "OPENAI_API_KEY" }, CREDENTIAL);
  v.getSecret = () => {
    throw new Error("corrupt record");
  };
  const r = { id: 1, ts: Date.now() + 10, event: "reveal" as const, scope: "global", key: "OPENAI_API_KEY", pid: 1, processName: "kerstel", chain: null, project: null };
  expect(shouldRotate(v, r)).toBe(false);
});

test("a section cut short by --limit says how many there are", async () => {
  await seedHome((v) => {
    for (let i = 0; i < 5; i++) v.appendAudit(row({ ts: NOW - i, key: `KEY_${i}` }));
    for (let i = 0; i < 4; i++) v.appendAudit(row({ ts: NOW - i, event: "set", key: `CH_${i}` }));
  });
  const cut = await run(["--limit", "2"]);
  expect(cut.text).toContain("Showing 2 of 5. Use --limit to see more.");
  expect(cut.text).toContain("Showing 2 of 4. Use --limit to see more.");
  expect((await run(["--limit", "10"])).text).not.toContain("Showing");
});
