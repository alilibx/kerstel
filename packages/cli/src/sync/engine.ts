import { createBackup, type BackupVaultValue } from "../init/backup";
import { formatReference, type SecretRef } from "../reference";
import type { Vault } from "../vault/store";
import type { RecordOut } from "../../../server/src/protocol";
import { openPayload, openSyncKey, recordId, sealPayload, type Payload } from "./crypto";
import { SyncHttpError, type SyncClient } from "./http";
import { saveHead, saveSync, type SyncConfig } from "./state";

/**
 * Pull, push, and conflicts. Sync spec §8. A sync never chooses between two
 * values: a key changed here and on another device keeps this device's value
 * and records the other one as a conflict until someone settles it.
 */

/** The backup folder for values a sync replaced. A leading `_` is no scope name, so it cannot collide with a project's. */
export const SYNC_BACKUP_SCOPE = "_sync";

export interface SyncContext {
  vault: Vault;
  dataKey: Buffer;
  config: SyncConfig;
  client: SyncClient;
}

export interface SyncReport {
  /** Keys a pull wrote or deleted here. */
  applied: SecretRef[];
  /** Keys this device's push sent and the server accepted. */
  pushed: SecretRef[];
  /** Keys with a conflict open after this sync. */
  conflicts: SecretRef[];
  /** Where the values a pull replaced were saved, if any were. */
  backups: string[];
}

const key = (ref: SecretRef) => `${ref.scope}\0${ref.key}`;
const PUSH_BATCH = 500;

/** Every record ID this device can name: the stored secrets, and the keys it tracks. */
function idMap(ctx: SyncContext): Map<string, SecretRef> {
  const map = new Map<string, SecretRef>();
  const add = (ref: SecretRef) => map.set(recordId(ctx.config.syncKey, ref.scope, ref.key), { scope: ref.scope, key: ref.key });
  for (const s of ctx.vault.listSecrets()) add(s);
  for (const r of ctx.vault.sync.rows()) add(r);
  return map;
}

/** A pulled record as the key it names and the value it holds, or null for a record this device cannot place. */
function readRecord(ctx: SyncContext, record: RecordOut, ids: Map<string, SecretRef>): { ref: SecretRef; value: string | null } | null {
  const context = { vaultId: ctx.config.vaultId, recordId: record.id, epoch: ctx.config.epoch };
  if (record.blob === null) {
    // A deletion carries no payload: only a key this device knows can be named.
    const ref = ids.get(record.id);
    return ref ? { ref, value: null } : null;
  }
  const payload: Payload = openPayload(ctx.config.syncKey, record.blob, context);
  // The ID is derived from the name, so a payload filed under another key's ID is refused.
  if (recordId(ctx.config.syncKey, payload.scope, payload.key) !== record.id) {
    throw new Error("A sync record's name does not match its ID. Another device may be misbehaving.");
  }
  return { ref: { scope: payload.scope, key: payload.key }, value: payload.deleted ? null : payload.value };
}

/** The other device's value in an open conflict. */
export function conflictValue(ctx: SyncContext, ref: SecretRef, conflict: { rev: number; blob: string | null }): string | null {
  if (conflict.blob === null) return null;
  const id = recordId(ctx.config.syncKey, ref.scope, ref.key);
  const payload = openPayload(ctx.config.syncKey, conflict.blob, {
    vaultId: ctx.config.vaultId,
    recordId: id,
    epoch: ctx.config.epoch,
  });
  return payload.deleted ? null : payload.value;
}

function backup(ctx: SyncContext, values: BackupVaultValue[], report: SyncReport): void {
  if (values.length === 0) return;
  const result = createBackup({ scope: SYNC_BACKUP_SCOPE, dataKey: ctx.dataKey, files: [], vault: values });
  report.backups.push(result.dir);
}

type Plan =
  | { kind: "apply"; ref: SecretRef; value: string | null; rev: number; change: number; loser: string | null }
  | { kind: "adopt"; ref: SecretRef; rev: number; change: number }
  | { kind: "conflict"; ref: SecretRef; conflict: { rev: number; blob: string | null } };

/** Sync spec §8.3: what to do with one pulled record, decided before anything is written. */
function planRecord(ctx: SyncContext, ref: SecretRef, value: string | null, record: RecordOut): Plan | null {
  const row = ctx.vault.sync.row(ref);
  // A revision this copy is already based on is not news: a device pulling
  // back its own push, or a record pulled twice. Treating it as remote would
  // call this device's newer local change a conflict with itself.
  if (row && !row.conflict && record.rev <= row.baseRev) return null;
  const local = ctx.vault.getSecret(ref);
  if (row?.conflict) {
    // Still open: keep this device's value, and track the other side's latest.
    return { kind: "conflict", ref, conflict: { rev: record.rev, blob: record.blob } };
  }
  if (!row || !row.dirty) {
    if (local === value && row?.baseRev === record.rev) return null;
    return { kind: "apply", ref, value, rev: record.rev, change: row?.change ?? 0, loser: local !== value ? local : null };
  }
  if (local === value) return { kind: "adopt", ref, rev: record.rev, change: row.change };
  return { kind: "conflict", ref, conflict: { rev: record.rev, blob: record.blob } };
}

function applyPlans(ctx: SyncContext, plans: Plan[], report: SyncReport): void {
  // Values about to be replaced or deleted go to the backup first.
  backup(
    ctx,
    plans.flatMap((p) => (p.kind === "apply" && p.loser !== null ? [{ ...p.ref, value: p.loser }] : [])),
    report,
  );
  for (const plan of plans) {
    if (plan.kind === "apply") {
      if (ctx.vault.sync.applyRemote(plan.ref, plan.value, plan.rev, plan.change)) report.applied.push(plan.ref);
    } else if (plan.kind === "adopt") {
      ctx.vault.sync.adopt(plan.ref, plan.rev, plan.change);
    } else {
      ctx.vault.sync.setConflict(plan.ref, plan.conflict);
    }
  }
}

/** A rotation on another device: fetch this device's sealed copy of the new key. */
async function adoptEpoch(ctx: SyncContext, epoch: number): Promise<void> {
  const sealed = await ctx.client.keys();
  if (sealed.epoch !== epoch) throw new Error(`The server is at key epoch ${epoch} but sealed epoch ${sealed.epoch} to this device.`);
  ctx.config.syncKey = openSyncKey(sealed.sealedKey, ctx.config.keys.enc, {
    vaultId: ctx.config.vaultId,
    deviceId: ctx.config.deviceId,
    epoch,
  });
  ctx.config.epoch = epoch;
  ctx.config.head = 0;
  saveSync(ctx.vault, ctx.dataKey, ctx.config);
  ctx.vault.sync.resetBaseRevs();
}

export async function pull(ctx: SyncContext, report: SyncReport, full = false): Promise<void> {
  const ids = idMap(ctx);
  const seen = new Set<string>();
  let since = full ? 0 : ctx.config.head;
  let head = ctx.config.head;
  for (;;) {
    let page;
    try {
      page = await ctx.client.pull(since, full);
    } catch (error) {
      if (error instanceof SyncHttpError && error.code === "full_pull_required" && !full) return pull(ctx, report, true);
      throw error;
    }
    if (page.epoch !== ctx.config.epoch) {
      await adoptEpoch(ctx, page.epoch);
      return pull(ctx, report, true);
    }
    const plans: Plan[] = [];
    for (const record of page.records) {
      seen.add(record.id);
      const read = readRecord(ctx, record, ids);
      if (!read) continue;
      const plan = planRecord(ctx, read.ref, read.value, record);
      if (plan) plans.push(plan);
    }
    applyPlans(ctx, plans, report);
    head = Math.max(head, page.head);
    since = page.records.at(-1)?.rev ?? since;
    if (!page.more) break;
  }

  if (full) {
    // A full pull reconciles by absence: a key the server no longer holds at
    // all was deleted elsewhere, and its tombstone has since been dropped.
    const plans: Plan[] = [];
    for (const row of ctx.vault.sync.rows()) {
      if (row.dirty || row.conflict || row.baseRev === 0) continue;
      if (seen.has(recordId(ctx.config.syncKey, row.scope, row.key))) continue;
      const local = ctx.vault.getSecret(row);
      plans.push({ kind: "apply", ref: row, value: null, rev: 0, change: row.change, loser: local });
    }
    applyPlans(ctx, plans, report);
  }
  ctx.config.head = head;
  saveHead(ctx.vault, head);
}

export async function push(ctx: SyncContext, report: SyncReport): Promise<void> {
  const ids = idMap(ctx);
  const pending = ctx.vault.sync.rows().filter((r) => r.dirty && !r.conflict);
  for (let i = 0; i < pending.length; i += PUSH_BATCH) {
    const batch = pending.slice(i, i + PUSH_BATCH);
    const sent: { ref: SecretRef; id: string; change: number }[] = [];
    const records = [];
    for (const row of batch) {
      const ref = { scope: row.scope, key: row.key };
      const value = ctx.vault.getSecret(ref);
      if (value === null && row.baseRev === 0) {
        // Created and deleted here before it ever reached the server: nothing to send.
        ctx.vault.sync.adopt(ref, 0, row.change);
        continue;
      }
      const id = recordId(ctx.config.syncKey, ref.scope, ref.key);
      const blob =
        value === null
          ? null
          : sealPayload(
              ctx.config.syncKey,
              { v: 1, scope: ref.scope, key: ref.key, value, deleted: false, updatedAt: Date.now(), device: ctx.config.deviceId },
              { vaultId: ctx.config.vaultId, recordId: id, epoch: ctx.config.epoch },
            );
      records.push({ id, baseRev: row.baseRev, blob });
      sent.push({ ref, id, change: row.change });
    }
    if (records.length === 0) continue;
    const result = await ctx.client.push({ epoch: ctx.config.epoch, records });
    const byId = new Map(sent.map((s) => [s.id, s]));
    for (const accepted of result.accepted) {
      const s = byId.get(accepted.id);
      if (!s) continue;
      // Sync spec §8.2: dirty clears only if nothing wrote the key while the push was in flight.
      ctx.vault.sync.adopt(s.ref, accepted.rev, s.change);
      report.pushed.push(s.ref);
    }
    // The server's copy of each record whose base was stale: handled as a pull would.
    const plans: Plan[] = [];
    for (const record of result.conflicts) {
      const read = readRecord(ctx, record, ids);
      if (!read) continue;
      const plan = planRecord(ctx, read.ref, read.value, record);
      if (plan) plans.push(plan);
    }
    applyPlans(ctx, plans, report);
  }
}

/** Pull, then push. Sync spec §8.1. */
export async function syncOnce(ctx: SyncContext): Promise<SyncReport> {
  const report: SyncReport = { applied: [], pushed: [], conflicts: [], backups: [] };
  await pull(ctx, report);
  await push(ctx, report);
  report.conflicts = openConflicts(ctx.vault);
  return report;
}

export function openConflicts(vault: Vault): SecretRef[] {
  return vault.sync
    .rows()
    .filter((r) => r.conflict !== null)
    .map((r) => ({ scope: r.scope, key: r.key }));
}

/**
 * Settles one conflict. `local` keeps this device's value, to be pushed over
 * the other one; `remote` takes the other device's. The losing value goes to
 * the sync backup. Sync spec §8.4.
 */
export function settle(ctx: SyncContext, ref: SecretRef, keep: "local" | "remote", report: SyncReport): void {
  const row = ctx.vault.sync.row(ref);
  if (!row?.conflict) return;
  const remote = conflictValue(ctx, ref, row.conflict);
  const local = ctx.vault.getSecret(ref);
  if (keep === "local") {
    backup(ctx, remote === null ? [] : [{ ...ref, value: remote }], report);
    ctx.vault.sync.keepLocal(ref, row.conflict.rev);
  } else {
    backup(ctx, local === null ? [] : [{ ...ref, value: local }], report);
    ctx.vault.sync.applyRemote(ref, remote, row.conflict.rev, row.change);
  }
}

export function describe(ref: SecretRef): string {
  return formatReference(ref.scope, ref.key);
}
