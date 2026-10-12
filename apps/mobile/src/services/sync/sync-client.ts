import type { SQLiteDatabase } from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import { withEncryptedExclusiveTransaction } from '@/database/encrypted-transaction';
import { isAllowedTransition, type RepairStatus } from '@repair-shop/shared';

import { getPendingOutbox, getSyncClientId, markOutboxApplied, markOutboxConflict, markOutboxFailure } from '@/database/outbox';
import { getBoundLocalOwnerId } from '@/database/owner-binding';
import { getSavedOwner, ownerAuthenticatedFetch } from '@/services/auth/owner-auth';

type PushReply = {
  results: Array<{ operationId: string; status: 'applied' | 'replayed' | 'conflict'; version?: number; snapshot?: unknown }>;
};

export type SyncSummary = { pushed: number; conflicts: number; pending: number; localOnly: number };

type ConflictOperation = {
  id: string; entity_type: string; entity_id: string; operation: string; base_version: number | null;
  payload_json: string; last_error: string | null;
};

/** Explicitly rebases a simple edit or accepts its owner-scoped server snapshot. */
export async function resolveSyncConflict(database: SQLiteDatabase, conflictId: string, choice: 'keep_local' | 'use_server' | 'local_only'): Promise<void> {
  const row = await database.getFirstAsync<ConflictOperation>(
    "SELECT id, entity_type, entity_id, operation, base_version, payload_json, last_error FROM outbox WHERE id = ? AND sync_state = 'conflict'", conflictId,
  );
  if (!row) throw new Error('This sync conflict was already resolved.');
  const payload = parseStoredObject(row.payload_json, 'Local sync data');
  let snapshot: Record<string, unknown> | null = null;
  if (row.last_error) {
    const parsed: unknown = JSON.parse(row.last_error);
    if (isObject(parsed)) snapshot = parsed;
  }
  const entityType = row.entity_type;

  if (choice === 'local_only') {
    const repairId = entityType === 'repair' ? row.entity_id
      : (entityType === 'repair_status_history' || entityType === 'invoice' || entityType === 'payment' || entityType === 'payment_reversal') && typeof payload.repairId === 'string' ? payload.repairId
        : null;
    await withEncryptedExclusiveTransaction(database, async (transaction) => {
      await transaction.runAsync("UPDATE outbox SET sync_state = 'local_only' WHERE id = ?", conflictId);
      if (entityType === 'customer') await transaction.runAsync("UPDATE customers SET sync_state = 'local' WHERE id = ?", row.entity_id);
      else if (entityType === 'repair') await transaction.runAsync("UPDATE repairs SET sync_state = 'local' WHERE id = ?", row.entity_id);
      else if (entityType === 'payment') await transaction.runAsync("UPDATE payments SET sync_state = 'local' WHERE id = ?", row.entity_id);
      else if (entityType === 'payment_reversal') await transaction.runAsync("UPDATE payment_reversals SET sync_state = 'local' WHERE id = ?", row.entity_id);
      else if (entityType === 'invoice') await transaction.runAsync("UPDATE invoices SET sync_state = 'local' WHERE id = ?", row.entity_id);
      if (repairId) await transaction.runAsync("UPDATE repairs SET sync_state = 'local' WHERE id = ?", repairId);
    });
    return;
  }

  if (choice === 'use_server') {
    if (!snapshot || !['customer', 'repair', 'repair_status_history'].includes(entityType)) throw new Error('This conflict cannot safely use the server snapshot automatically.');
    const repairId = entityType === 'repair_status_history' ? requiredText(payload, 'repairId') : row.entity_id;
    if (entityType !== 'customer') await ensureNoRelatedOperations(database, conflictId, repairId);
    await withEncryptedExclusiveTransaction(database, async (transaction) => {
      if (entityType === 'customer') await applyRemoteCustomer(transaction, snapshot, true);
      else {
        await applyRemoteRepair(transaction, snapshot, true);
        if (entityType === 'repair_status_history') await transaction.runAsync('DELETE FROM repair_status_history WHERE id = ?', row.entity_id);
      }
      await transaction.runAsync('DELETE FROM outbox WHERE id = ?', conflictId);
    });
    return;
  }

  const serverVersion = snapshot && Number.isSafeInteger(snapshot.version) ? snapshot.version as number : null;
  const relatedRepairId = entityType === 'repair' ? row.entity_id
    : entityType === 'repair_status_history' ? requiredText(payload, 'repairId') : null;
  if (relatedRepairId) await ensureNoRelatedOperations(database, conflictId, relatedRepairId);
  const nextPayload = { ...payload };
  if (entityType === 'repair_status_history') {
    if (!snapshot || !isRepairStatus(snapshot.status) || !isRepairStatus(payload.status) || !isAllowedTransition(snapshot.status, payload.status)) {
      throw new Error('The server repair status does not allow this local status change. Review the repair and enter a new status manually.');
    }
    nextPayload.fromStatus = snapshot.status;
  } else if (entityType !== 'customer' && entityType !== 'repair') {
    throw new Error('This financial or invoice conflict needs manual review and cannot be rebased automatically.');
  }
  const nextOperationId = Crypto.randomUUID();
  await withEncryptedExclusiveTransaction(database, async (transaction) => {
    await transaction.runAsync(`UPDATE outbox SET id = ?, base_version = ?, payload_json = ?, sync_state = 'pending', attempts = 0, last_error = NULL WHERE id = ?`, nextOperationId, serverVersion, JSON.stringify(nextPayload), conflictId);
    if (entityType === 'customer' && serverVersion !== null) await transaction.runAsync("UPDATE customers SET version = ?, sync_state = 'local' WHERE id = ?", serverVersion + 1, row.entity_id);
    if (relatedRepairId && serverVersion !== null) await transaction.runAsync("UPDATE repairs SET version = ?, sync_state = 'local' WHERE id = ?", serverVersion + 1, relatedRepairId);
  });
}

/** Sends a bounded, ordered batch from SQLite's durable outbox; retries are safe by operation ID. */
export async function syncPendingOperations(database: SQLiteDatabase): Promise<SyncSummary> {
  const [savedOwner, boundOwnerId] = await Promise.all([getSavedOwner(), getBoundLocalOwnerId(database)]);
  if (!savedOwner || !boundOwnerId) throw new Error('Sign in to the shop account before syncing.');
  if (savedOwner.id !== boundOwnerId) throw new Error('This phone’s local records are linked to a different shop account. Sync was stopped.');
  const [clientId, operations] = await Promise.all([getSyncClientId(database), getPendingOutbox(database)]);
  if (operations.length === 0) {
    await pullRemoteChanges(database);
    return getLocalSyncSummary(database, 0);
  }
  let response: Response;
  try {
    response = await ownerAuthenticatedFetch('/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, operations: operations.map((item) => ({
        operationId: item.id, entityType: item.entityType, entityId: item.entityId,
        operation: item.operation, baseVersion: item.baseVersion, payload: item.payload, createdAt: item.createdAt,
      })) }),
    });
  } catch {
    await Promise.all(operations.map((item) => markOutboxFailure(database, item.id, 'Server connection failed.')));
    throw new Error('Could not reach the shop server. Your local records are saved and will retry later.');
  }
  if (!response.ok) {
    const message = await readServerMessage(response);
    await Promise.all(operations.map((item) => markOutboxFailure(database, item.id, message)));
    throw new Error(message);
  }
  const reply = await response.json() as PushReply;
  if (!Array.isArray(reply.results)) throw new Error('The server returned an invalid sync response.');
  let pushed = 0;
  let conflicts = 0;
  for (const result of reply.results) {
    const operation = operations.find((candidate) => candidate.id === result.operationId);
    if (!operation) continue;
    if (result.status === 'conflict') {
      conflicts += 1;
      await markOutboxConflict(database, operation.id, result.snapshot ?? null);
    } else {
      const relatedRepairId = (operation.entityType === 'repair_status_history' || operation.entityType === 'invoice')
        && typeof operation.payload.repairId === 'string' ? operation.payload.repairId : undefined;
      await markOutboxApplied(database, operation.id, operation.entityType, operation.entityId, result.version ?? operation.baseVersion ?? 1, relatedRepairId);
      pushed += 1;
    }
  }
  await pullRemoteChanges(database);
  const summary = await getLocalSyncSummary(database, pushed);
  return { ...summary, conflicts: Math.max(summary.conflicts, conflicts) };
}

async function getLocalSyncSummary(database: SQLiteDatabase, pushed: number): Promise<SyncSummary> {
  const [pendingRows, conflictRows] = await Promise.all([
    database.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE sync_state = 'pending'"),
    database.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE sync_state = 'conflict'"),
    database.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE sync_state = 'local_only'"),
  ]);
  const localOnlyRows = await database.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE sync_state = 'local_only'");
  return { pushed, conflicts: conflictRows?.count ?? 0, pending: pendingRows?.count ?? 0, localOnly: localOnlyRows?.count ?? 0 };
}

type RemoteChangeSet = {
  customers: Array<Record<string, unknown>>;
  repairs: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  reversals: Array<Record<string, unknown>>;
  invoices: Array<Record<string, unknown>>;
  statusHistory: Array<Record<string, unknown>>;
};

async function pullRemoteChanges(database: SQLiteDatabase): Promise<void> {
  for (let page = 0; page < 100; page += 1) {
    const savedCursor = await database.getFirstAsync<{ value: string }>("SELECT value FROM sync_metadata WHERE key = 'server_cursor'");
    const query = new URLSearchParams({ limit: '100', ...(savedCursor ? { cursor: savedCursor.value } : {}) });
    let response: Response;
    try {
      response = await ownerAuthenticatedFetch(`/v1/sync/pull?${query.toString()}`);
    } catch {
      throw new Error('Records were uploaded, but the latest shop records could not be downloaded.');
    }
    if (!response.ok) throw new Error(await readServerMessage(response));
    const reply: unknown = await response.json();
    if (!isObject(reply) || typeof reply.cursor !== 'string' || typeof reply.hasMore !== 'boolean' || !isObject(reply.changes)) throw new Error('The server returned invalid shop records.');
    const changes = reply.changes as unknown as RemoteChangeSet;
    for (const key of ['customers', 'repairs', 'payments', 'reversals', 'invoices', 'statusHistory'] as const) {
      if (!Array.isArray(changes[key]) || changes[key].some((item) => !isObject(item))) throw new Error('The server returned invalid shop records.');
    }
    await withEncryptedExclusiveTransaction(database, async (transaction) => {
      for (const row of changes.customers) await applyRemoteCustomer(transaction, row);
      for (const row of changes.repairs) await applyRemoteRepair(transaction, row);
      for (const row of changes.payments) await applyRemotePayment(transaction, row);
      for (const row of changes.reversals) await applyRemoteReversal(transaction, row);
      for (const row of changes.invoices) await applyRemoteInvoice(transaction, row);
      for (const row of changes.statusHistory) await applyRemoteStatusHistory(transaction, row);
      await transaction.runAsync("INSERT INTO sync_metadata (key, value) VALUES ('server_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", requiredText(reply, 'cursor'));
    });
    if (!reply.hasMore) return;
  }
  throw new Error('There are many shop changes to download. Sync again to continue.');
}

async function shouldApplyRemote(database: SQLiteDatabase, entityId: string, force = false): Promise<boolean> {
  if (force) return true;
  const pending = await database.getFirstAsync<{ id: string }>("SELECT id FROM outbox WHERE entity_id = ? AND sync_state IN ('pending', 'conflict') LIMIT 1", entityId);
  return !pending;
}

async function applyRemoteCustomer(database: SQLiteDatabase, row: Record<string, unknown>, force = false): Promise<void> {
  const id = requiredText(row, 'id');
  if (!await shouldApplyRemote(database, id, force)) return;
  await database.runAsync(`INSERT INTO customers (id, name, phone, alternate_phone, address, notes, archived_at, created_at, updated_at, version, sync_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, alternate_phone=excluded.alternate_phone, address=excluded.address, notes=excluded.notes, archived_at=excluded.archived_at, updated_at=excluded.updated_at, version=excluded.version, sync_state='synced'`,
  id, requiredText(row, 'name'), requiredText(row, 'phone'), nullableText(row.alternatePhone), nullableText(row.address), nullableText(row.notes), nullableText(row.archivedAt), requiredText(row, 'createdAt'), requiredText(row, 'updatedAt'), requiredInteger(row, 'version'));
}

async function applyRemoteRepair(database: SQLiteDatabase, row: Record<string, unknown>, force = false): Promise<void> {
  const id = requiredText(row, 'id');
  if (!await shouldApplyRemote(database, id, force)) return;
  await database.runAsync(`INSERT INTO repairs (id, receipt_number, customer_id, brand, model, imei, reported_problem, inspection_notes, accessories, received_at, expected_delivery_date, delivered_at, status, estimated_cost_paisa, final_cost_paisa, internal_notes, created_at, updated_at, version, sync_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
    ON CONFLICT(id) DO UPDATE SET receipt_number=excluded.receipt_number, customer_id=excluded.customer_id, brand=excluded.brand, model=excluded.model, imei=excluded.imei, reported_problem=excluded.reported_problem, inspection_notes=excluded.inspection_notes, accessories=excluded.accessories, received_at=excluded.received_at, expected_delivery_date=excluded.expected_delivery_date, delivered_at=excluded.delivered_at, status=excluded.status, estimated_cost_paisa=excluded.estimated_cost_paisa, final_cost_paisa=excluded.final_cost_paisa, internal_notes=excluded.internal_notes, updated_at=excluded.updated_at, version=excluded.version, sync_state='synced'`,
  id, requiredText(row, 'receiptNumber'), requiredText(row, 'customerId'), requiredText(row, 'brand'), requiredText(row, 'model'), nullableText(row.imei), requiredText(row, 'reportedProblem'), nullableText(row.inspectionNotes), nullableText(row.accessories), requiredText(row, 'receivedAt'), nullableText(row.expectedDeliveryDate), nullableText(row.deliveredAt), requiredText(row, 'status'), nullableInteger(row.estimatedCostPaisa), nullableInteger(row.finalCostPaisa), nullableText(row.internalNotes), requiredText(row, 'createdAt'), requiredText(row, 'updatedAt'), requiredInteger(row, 'version'));
}

async function applyRemotePayment(database: SQLiteDatabase, row: Record<string, unknown>): Promise<void> {
  const id = requiredText(row, 'id');
  if (!await shouldApplyRemote(database, id)) return;
  await database.runAsync(`INSERT INTO payments (id, repair_id, amount_paisa, currency, method, transaction_reference, note, paid_at, idempotency_key, created_at, sync_state)
    VALUES (?, ?, ?, 'PKR', ?, ?, ?, ?, ?, ?, 'synced') ON CONFLICT(id) DO NOTHING`, id, requiredText(row, 'repairId'), requiredInteger(row, 'amountPaisa'), requiredText(row, 'method'), nullableText(row.transactionReference), nullableText(row.note), requiredText(row, 'paidAt'), requiredText(row, 'idempotencyKey'), requiredText(row, 'createdAt'));
}

async function applyRemoteReversal(database: SQLiteDatabase, row: Record<string, unknown>): Promise<void> {
  const id = requiredText(row, 'id');
  if (!await shouldApplyRemote(database, id)) return;
  await database.runAsync(`INSERT INTO payment_reversals (id, payment_id, repair_id, amount_paisa, reason, idempotency_key, reversed_at, sync_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'synced') ON CONFLICT(id) DO NOTHING`, id, requiredText(row, 'paymentId'), requiredText(row, 'repairId'), requiredInteger(row, 'amountPaisa'), requiredText(row, 'reason'), requiredText(row, 'idempotencyKey'), requiredText(row, 'reversedAt'));
}

async function applyRemoteInvoice(database: SQLiteDatabase, row: Record<string, unknown>): Promise<void> {
  const id = requiredText(row, 'id');
  if (!await shouldApplyRemote(database, id)) return;
  await database.runAsync(`INSERT INTO invoices (id, invoice_code, repair_id, issued_at, customer_name_snapshot, customer_phone_snapshot, repair_description_snapshot, total_paisa, paid_paisa, balance_paisa, created_at, sync_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced') ON CONFLICT(id) DO NOTHING`, id, requiredText(row, 'invoiceCode'), requiredText(row, 'repairId'), requiredText(row, 'issuedAt'), requiredText(row, 'customerNameSnapshot'), requiredText(row, 'customerPhoneSnapshot'), requiredText(row, 'repairDescriptionSnapshot'), requiredInteger(row, 'totalPaisa'), requiredInteger(row, 'paidPaisa'), requiredInteger(row, 'balancePaisa'), requiredText(row, 'issuedAt'));
}

async function applyRemoteStatusHistory(database: SQLiteDatabase, row: Record<string, unknown>): Promise<void> {
  const id = requiredText(row, 'id');
  if (!await shouldApplyRemote(database, id)) return;
  await database.runAsync(`INSERT INTO repair_status_history (id, repair_id, from_status, to_status, changed_at, created_at, note)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`, id, requiredText(row, 'repairId'), nullableText(row.fromStatus), requiredText(row, 'toStatus'), requiredText(row, 'changedAt'), requiredText(row, 'createdAt'), nullableText(row.note));
}

function requiredText(record: Record<string, unknown>, key: string): string {
  if (typeof record[key] !== 'string') throw new Error(`The server returned an invalid ${key} value.`);
  return record[key];
}
function nullableText(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function requiredInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`The server returned an invalid ${key} value.`);
  return value;
}
function nullableInteger(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) ? value : null; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function parseStoredObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isObject(parsed)) return parsed;
  } catch { /* Use the single validation message below. */ }
  throw new Error(`${label} is damaged and cannot be resolved automatically.`);
}

function isRepairStatus(value: unknown): value is RepairStatus {
  return value === 'received' || value === 'diagnosing' || value === 'awaiting_approval' || value === 'waiting_for_parts'
    || value === 'in_repair' || value === 'ready' || value === 'delivered' || value === 'cancelled';
}

async function ensureNoRelatedOperations(database: SQLiteDatabase, conflictId: string, repairId: string): Promise<void> {
  const rows = await database.getAllAsync<{ id: string; entity_id: string; payload_json: string }>(
    "SELECT id, entity_id, payload_json FROM outbox WHERE id != ? AND sync_state IN ('pending', 'conflict')", conflictId,
  );
  for (const row of rows) {
    if (row.entity_id === repairId) throw new Error('Resolve other pending changes for this repair first.');
    try {
      const payload: unknown = JSON.parse(row.payload_json);
      if (isObject(payload) && payload.repairId === repairId) throw new Error('Resolve other pending changes for this repair first.');
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'Resolve other pending changes for this repair first.') throw cause;
    }
  }
}

async function readServerMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null && 'message' in body.error && typeof body.error.message === 'string') {
      return body.error.message;
    }
  } catch { /* Use the fallback for non-JSON responses. */ }
  return response.status === 401 ? 'Your shop session expired. Sign in again to sync.' : 'The server could not sync these records.';
}
