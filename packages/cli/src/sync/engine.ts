import { backupTimestamp, createBackup, type BackupVaultValue } from "../init/backup";
import { formatReference, type SecretRef } from "../reference";
import type { Vault } from "../vault/store";
import type { RecordOut } from "../../../server/src/protocol";
import { cliName } from "../ui/cli-name";
import {
  generateSyncKey,
  openPayload,
  openSyncKey,
  recordId,
  sealName,
  sealPayload,
  sealSyncKey,
  verifiedName,
  type Payload,
} from "./crypto";
import { SyncHttpError, type SyncClient } from "./http";
import { needsFullPull, saveHead, setFullPull, writeSync, type SyncConfig } from "./state";

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

function openConflict(syncKey: Buffer, epoch: number, vaultId: string, ref: SecretRef, blob: string | null): string | null {
  if (blob === null) return null;
  const payload = openPayload(syncKey, blob, { vaultId, recordId: recordId(syncKey, ref.scope, ref.key), epoch });
  return payload.deleted ? null : payload.value;
}

/** The other device's value in an open conflict; null when the other device deleted the key. */
export function conflictValue(ctx: SyncContext, ref: SecretRef, conflict: { rev: number; blob: string | null }): string | null {
  return openConflict(ctx.config.syncKey, ctx.config.epoch, ctx.config.vaultId, ref, conflict.blob);
}

/** Never the same millisecond twice in one process, so two backups never race for one folder. */
let lastBackup = 0;

function backup(ctx: SyncContext, values: BackupVaultValue[], report: SyncReport): void {
  if (values.length === 0) return;
  lastBackup = Math.max(Date.now(), lastBackup + 1);
  const result = createBackup({
    scope: SYNC_BACKUP_SCOPE,
    dataKey: ctx.dataKey,
    files: [],
    vault: values,
    timestamp: backupTimestamp(new Date(lastBackup)),
  });
  report.backups.push(result.dir);
}

type Plan =
  | { kind: "apply"; ref: SecretRef; value: string | null; rev: number; change: number; loser: string | null }
  | { kind: "adopt"; ref: SecretRef; rev: number; change: number }
  | { kind: "conflict"; ref: SecretRef; conflict: { rev: number; blob: string | null } };

/**
 * Sync spec §8.3: what to do with one record, decided before anything is
 * written. `fromPush` marks the server's copy returned for a stale push,
 * which is news whatever its revision: a record that no longer exists comes
 * back as revision 0.
 */
function planRecord(ctx: SyncContext, ref: SecretRef, value: string | null, record: RecordOut, fromPush = false): Plan | null {
  const row = ctx.vault.sync.row(ref);
  // A revision this copy is already based on is not news: a device pulling
  // back its own push, or a record pulled twice. Treating it as remote would
  // call this device's newer local change a conflict with itself.
  if (!fromPush && row && !row.conflict && record.rev <= row.baseRev) return null;
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

/**
 * A rotation on another device: fetch this device's sealed copy of the new
 * key. Base revisions stay as they are: the server gives the re-uploaded
 * records revisions above every earlier one, and a copy that was on the
 * server before is how the full pull that follows spots a deletion made
 * before the rotation. Open conflicts are sealed again under the new key,
 * since the old one is about to go. All of it, and the full-pull flag, lands
 * in one transaction.
 */
async function adoptEpoch(ctx: SyncContext, epoch: number): Promise<void> {
  const sealed = await ctx.client.keys();
  if (sealed.epoch !== epoch) throw new Error(`The server is at key epoch ${epoch} but sealed epoch ${sealed.epoch} to this device.`);
  const oldKey = ctx.config.syncKey;
  const oldEpoch = ctx.config.epoch;
  const newKey = openSyncKey(sealed.sealedKey, ctx.config.keys.enc, {
    vaultId: ctx.config.vaultId,
    deviceId: ctx.config.deviceId,
    epoch,
  });
  ctx.vault.transaction(() => {
    for (const row of ctx.vault.sync.rows()) {
      if (!row.conflict) continue;
      const value = openConflict(oldKey, oldEpoch, ctx.config.vaultId, row, row.conflict.blob);
      const id = recordId(newKey, row.scope, row.key);
      const blob =
        value === null
          ? null
          : sealPayload(
              newKey,
              { v: 1, scope: row.scope, key: row.key, value, deleted: false, updatedAt: Date.now(), device: "" },
              { vaultId: ctx.config.vaultId, recordId: id, epoch },
            );
      ctx.vault.sync.setConflict(row, { rev: row.conflict.rev, blob });
    }
    ctx.config.syncKey = newKey;
    ctx.config.epoch = epoch;
    writeSync(ctx.vault, ctx.dataKey, ctx.config);
    setFullPull(ctx.vault, true);
  });
}

export async function pull(ctx: SyncContext, report: SyncReport, full = false): Promise<void> {
  // A key change that a crash interrupted before its full pull finished.
  if (!full && needsFullPull(ctx.vault)) full = true;
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
    // A full pull reconciles by absence: a key the server held for this copy
    // and holds no longer was deleted elsewhere, its tombstone since dropped
    // (or left behind by a rotation). A clean copy follows the deletion; a
    // copy changed here, or already in conflict, becomes a conflict with it,
    // so whoever runs `ks sync` chooses whether the key stays.
    const plans: Plan[] = [];
    for (const row of ctx.vault.sync.rows()) {
      if (row.baseRev === 0 && !row.conflict) continue;
      if (seen.has(recordId(ctx.config.syncKey, row.scope, row.key))) continue;
      if (row.conflict || row.dirty) {
        plans.push({ kind: "conflict", ref: row, conflict: { rev: 0, blob: null } });
        continue;
      }
      const local = ctx.vault.getSecret(row);
      plans.push({ kind: "apply", ref: row, value: null, rev: 0, change: row.change, loser: local });
    }
    applyPlans(ctx, plans, report);
  }
  ctx.config.head = head;
  ctx.vault.transaction(() => {
    saveHead(ctx.vault, head);
    if (full) setFullPull(ctx.vault, false);
  });
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
      const plan = planRecord(ctx, read.ref, read.value, record, true);
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
 * Settles conflicts. `local` keeps this device's value, to be pushed over the
 * other one; `remote` takes the other device's. Every losing value goes into
 * one sync backup, written before any choice is applied. Sync spec §8.4.
 */
export function settle(ctx: SyncContext, choices: { ref: SecretRef; keep: "local" | "remote" }[], report: SyncReport): void {
  const plans = choices.flatMap(({ ref, keep }) => {
    const row = ctx.vault.sync.row(ref);
    if (!row?.conflict) return [];
    const remote = conflictValue(ctx, ref, row.conflict);
    const local = ctx.vault.getSecret(ref);
    return [{ ref, keep, row, remote, loser: keep === "local" ? remote : local }];
  });
  backup(
    ctx,
    plans.flatMap((p) => (p.loser === null ? [] : [{ ...p.ref, value: p.loser }])),
    report,
  );
  for (const p of plans) {
    if (p.keep === "local") ctx.vault.sync.keepLocal(p.ref, p.row.conflict!.rev);
    else ctx.vault.sync.applyRemote(p.ref, p.remote, p.row.conflict!.rev, p.row.change);
  }
}

/** How many times a key rotation starts over when another device moved the vault meanwhile. */
const ROTATE_ATTEMPTS = 5;

/**
 * Sync spec §7.3: a new sync key (the next epoch), sealed to every device
 * that stays, their names sealed again under it, and every live record
 * re-encrypted, in one request that also removes `removeDevices`. When
 * another device pushed or rotated meanwhile, the server refuses it, and this
 * pulls and prepares it again.
 */
export async function rotateKey(ctx: SyncContext, removeDevices: string[], report: SyncReport): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rotateOnce(ctx, removeDevices, report);
      return;
    } catch (error) {
      const moved = error instanceof SyncHttpError && (error.code === "vault_moved" || error.code === "epoch_mismatch");
      if (!moved || attempt >= ROTATE_ATTEMPTS) throw error;
    }
  }
}

async function rotateOnce(ctx: SyncContext, removeDevices: string[], report: SyncReport): Promise<void> {
  // Brings this copy up to the server's head, and adopts a key another device rotated to.
  await pull(ctx, report);
  if (openConflicts(ctx.vault).length > 0) {
    throw new Error(`Settle the open sync conflicts first: run ${cliName()} sync.`);
  }

  // The server's live records, which the rotation re-encrypts. Local changes
  // not pushed yet are not among them: they stay dirty and go out with the
  // next push, under the new key.
  const { vaultId, epoch: oldEpoch, syncKey: oldKey } = ctx.config;
  const live = new Map<string, Payload>();
  let base: number | null = null;
  let since = 0;
  for (;;) {
    const page = await ctx.client.pull(since, true);
    if (page.epoch !== oldEpoch) throw new SyncHttpError(409, "epoch_mismatch", "Another device replaced the sync key meanwhile.");
    base ??= page.head;
    for (const record of page.records) {
      if (record.blob === null) {
        live.delete(record.id);
        continue;
      }
      const payload = openPayload(oldKey, record.blob, { vaultId, recordId: record.id, epoch: oldEpoch });
      if (recordId(oldKey, payload.scope, payload.key) !== record.id) {
        throw new Error("A sync record's name does not match its ID. Another device may be misbehaving.");
      }
      if (payload.deleted) live.delete(record.id);
      else live.set(record.id, payload);
    }
    since = page.records.at(-1)?.rev ?? since;
    if (!page.more) break;
  }
  // The rows here must describe exactly the records being re-encrypted, or a
  // value pushed between the pull and the listing would be rebased unseen.
  if (base !== ctx.config.head) throw new SyncHttpError(409, "vault_moved", "Another device pushed meanwhile.");

  const devices = (await ctx.client.devices()).devices;
  for (const id of removeDevices) {
    if (!devices.some((d) => d.id === id)) throw new Error("That device is no longer in this vault.");
  }
  const staying = devices
    .filter((d) => !removeDevices.includes(d.id))
    .map((d) => ({ device: d, name: verifiedName(oldKey, vaultId, d) }));
  // The new key goes only to keys a device in this vault sealed into a name.
  // A key the server listed in place of a device's own, or a device it added
  // itself, has no such name: refuse rather than hand it every secret.
  if (staying.some((d) => d.name === null)) {
    throw new Error(
      "The server lists a device whose keys do not match the ones your devices sealed. Nothing was changed. " +
        `Run ${cliName()} sync devices to see which one, and do not trust this server until you know why.`,
    );
  }
  const newKey = generateSyncKey();
  const epoch = oldEpoch + 1;
  const entries = [...live.values()].map((p) => {
    const id = recordId(newKey, p.scope, p.key);
    return { ref: { scope: p.scope, key: p.key }, id, blob: sealPayload(newKey, p, { vaultId, recordId: id, epoch }) };
  });
  const result = await ctx.client.rotate({
    epoch,
    baseRevision: base!,
    removeDevices,
    sealedKeys: Object.fromEntries(
      staying.map(({ device: d, name }) => [d.id, sealSyncKey(newKey, name!.encPub, { vaultId, deviceId: d.id, epoch })]),
    ),
    sealedNames: Object.fromEntries(staying.map(({ device: d, name }) => [d.id, sealName(newKey, vaultId, d.id, name!)])),
    records: entries.map(({ id, blob }) => ({ id, blob })),
  });

  // The server numbered the records in the order sent, after the old head.
  const first = result.head - entries.length;
  const revs = new Map(entries.map((e, i) => [key(e.ref), first + 1 + i]));
  ctx.vault.transaction(() => {
    // A key with no live record (deleted, or never pushed) is based on nothing now.
    for (const row of ctx.vault.sync.rows()) ctx.vault.sync.rebase(row, revs.get(key(row)) ?? 0);
    ctx.config.syncKey = newKey;
    ctx.config.epoch = result.epoch;
    ctx.config.head = result.head;
    writeSync(ctx.vault, ctx.dataKey, ctx.config);
  });
}

export function describe(ref: SecretRef): string {
  return formatReference(ref.scope, ref.key);
}
