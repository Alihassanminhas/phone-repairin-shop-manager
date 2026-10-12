import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { isAllowedTransition, type RepairStatus } from '@repair-shop/shared';

type SqlExecutor = Pick<SQLiteDatabase, 'runAsync' | 'getFirstAsync' | 'getAllAsync'>;
export type SyncEntityType = 'customer' | 'repair' | 'payment' | 'payment_reversal' | 'invoice' | 'repair_status_history';
export type SyncOperationKind = 'upsert' | 'create_event' | 'archive';
export type OutboxRecord = {
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperationKind;
  baseVersion: number | null;
  payload: Record<string, unknown>;
  createdAt: string;
};
export type OutboxConflict = {
  id: string; entityId: string; entityType: SyncEntityType; operation: SyncOperationKind; label: string; reason: string;
  status: 'conflict' | 'local_only'; canKeepLocal: boolean; canUseServer: boolean; canKeepLocalOnly: boolean;
};

export async function enqueueSyncOperation(
  database: SqlExecutor,
  input: Omit<OutboxRecord, 'id' | 'createdAt'>,
): Promise<void> {
  const operationId = Crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await database.runAsync(
    `INSERT INTO outbox (id, entity_type, entity_id, operation, payload_json, created_at, base_version, sync_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    operationId, input.entityType, input.entityId, input.operation, JSON.stringify(input.payload), createdAt, input.baseVersion,
  );
}

export async function getSyncClientId(database: SqlExecutor): Promise<string> {
  const saved = await database.getFirstAsync<{ value: string }>("SELECT value FROM sync_metadata WHERE key = 'client_id'");
  if (saved) return saved.value;
  const clientId = Crypto.randomUUID();
  await database.runAsync("INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('client_id', ?)", clientId);
  const persisted = await database.getFirstAsync<{ value: string }>("SELECT value FROM sync_metadata WHERE key = 'client_id'");
  if (!persisted) throw new Error('Could not initialize the sync client identity.');
  return persisted.value;
}

export async function getPendingOutbox(database: SqlExecutor, limit = 50): Promise<OutboxRecord[]> {
  const rows = await database.getAllAsync<{
    id: string; entity_type: SyncEntityType; entity_id: string; operation: SyncOperationKind;
    base_version: number | null; payload_json: string; created_at: string;
  }>("SELECT * FROM outbox WHERE sync_state = 'pending' ORDER BY rowid LIMIT ?", limit);
  return rows.map((row) => {
    let payload: unknown;
    try { payload = JSON.parse(row.payload_json); } catch { throw new Error(`The saved sync item ${row.id} is damaged.`); }
    if (!isObject(payload)) throw new Error(`The saved sync item ${row.id} has an invalid payload.`);
    return { id: row.id, entityType: row.entity_type, entityId: row.entity_id, operation: row.operation, baseVersion: row.base_version, payload, createdAt: row.created_at };
  });
}

export async function getOutboxConflicts(database: SqlExecutor): Promise<OutboxConflict[]> {
  const rows = await database.getAllAsync<{ id: string; entity_type: SyncEntityType; entity_id: string; operation: SyncOperationKind; payload_json: string; last_error: string | null; sync_state: 'conflict' | 'local_only' }>(
    "SELECT id, entity_type, entity_id, operation, payload_json, last_error, sync_state FROM outbox WHERE sync_state IN ('conflict', 'local_only') ORDER BY rowid",
  );
  const conflicts: OutboxConflict[] = [];
  for (const row of rows) {
    let payload: unknown;
    let snapshot: unknown;
    try { payload = JSON.parse(row.payload_json); snapshot = row.last_error ? JSON.parse(row.last_error) : null; }
    catch { payload = null; snapshot = null; }
    const relatedRepairId = row.entity_type === 'repair' ? row.entity_id
      : (row.entity_type === 'repair_status_history' || row.entity_type === 'invoice') && isObject(payload) && typeof payload.repairId === 'string' ? payload.repairId : null;
    let label = row.entity_type.replaceAll('_', ' ');
    if (row.entity_type === 'customer') {
      const customer = await database.getFirstAsync<{ name: string }>('SELECT name FROM customers WHERE id = ?', row.entity_id);
      label = customer?.name ?? `Customer ${row.entity_id.slice(0, 8)}`;
    } else if (relatedRepairId) {
      const repair = await database.getFirstAsync<{ receiptNumber: string }>('SELECT receipt_number AS receiptNumber FROM repairs WHERE id = ?', relatedRepairId);
      label = repair?.receiptNumber ?? `Repair ${relatedRepairId.slice(0, 8)}`;
    } else if (row.entity_type === 'payment' || row.entity_type === 'payment_reversal') {
      const repair = await database.getFirstAsync<{ receiptNumber: string }>(
        row.entity_type === 'payment' ? 'SELECT r.receipt_number AS receiptNumber FROM repairs r JOIN payments p ON p.repair_id = r.id WHERE p.id = ?' : 'SELECT r.receipt_number AS receiptNumber FROM repairs r JOIN payment_reversals rv ON rv.repair_id = r.id WHERE rv.id = ?', row.entity_id,
      );
      label = repair?.receiptNumber ?? `Payment ${row.entity_id.slice(0, 8)}`;
    }
    const reason = isObject(snapshot) && typeof snapshot.reason === 'string' ? snapshot.reason.replaceAll('_', ' ') : 'Cloud record changed; local details were kept.';
    const hasVersion = isObject(snapshot) && isObject(snapshot.repair) && Number.isSafeInteger(snapshot.repair.version)
      || isObject(snapshot) && Number.isSafeInteger(snapshot.version);
    const hasInvoice = isObject(snapshot) && snapshot.invoice !== undefined && snapshot.invoice !== null;
    const canKeepLocal = row.entity_type === 'customer' && (snapshot === null || hasVersion)
      || row.entity_type === 'repair' && (snapshot === null || (hasVersion && !hasInvoice))
      || row.entity_type === 'repair_status_history' && isObject(snapshot) && isObject(payload)
        && isRepairStatus(snapshot.status) && isRepairStatus(payload.status) && isAllowedTransition(snapshot.status, payload.status);
    const canUseServer = row.entity_type === 'customer' && isObject(snapshot) && typeof snapshot.id === 'string'
      || row.entity_type === 'repair' && isObject(snapshot) && typeof snapshot.id === 'string'
      || row.entity_type === 'repair_status_history' && isObject(snapshot) && typeof snapshot.id === 'string';
    conflicts.push({ id: row.id, entityId: row.entity_id, entityType: row.entity_type, operation: row.operation, label, reason, status: row.sync_state, canKeepLocal, canUseServer, canKeepLocalOnly: row.sync_state === 'conflict' });
  }
  return conflicts;
}

export async function markOutboxApplied(database: SqlExecutor, operationId: string, entityType: SyncEntityType, entityId: string, version: number, relatedRepairId?: string): Promise<void> {
  await database.runAsync('DELETE FROM outbox WHERE id = ?', operationId);
  if (entityType === 'customer' || entityType === 'repair') {
    const pending = await database.getFirstAsync<{ id: string }>("SELECT id FROM outbox WHERE entity_id = ? AND sync_state = 'pending' LIMIT 1", entityId);
    await database.runAsync(`UPDATE ${tableName(entityType)} SET sync_state = ?, version = MAX(version, ?) WHERE id = ?`, pending ? 'local' : 'synced', version, entityId);
  } else if (entityType === 'payment' || entityType === 'invoice') {
    await database.runAsync(`UPDATE ${tableName(entityType)} SET sync_state = 'synced' WHERE id = ?`, entityId);
  } else if (entityType === 'payment_reversal') {
    await database.runAsync("UPDATE payment_reversals SET sync_state = 'synced' WHERE id = ?", entityId);
  }
  if (relatedRepairId) {
    const pending = await database.getFirstAsync<{ id: string }>("SELECT id FROM outbox WHERE entity_id = ? AND sync_state = 'pending' LIMIT 1", relatedRepairId);
    await database.runAsync('UPDATE repairs SET sync_state = ? WHERE id = ?', pending ? 'local' : 'synced', relatedRepairId);
  }
}

export async function markOutboxConflict(database: SqlExecutor, operationId: string, snapshot: unknown): Promise<void> {
  await database.runAsync("UPDATE outbox SET sync_state = 'conflict', last_error = ? WHERE id = ?", JSON.stringify(snapshot), operationId);
}

export async function markOutboxFailure(database: SqlExecutor, operationId: string, message: string): Promise<void> {
  await database.runAsync("UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ? AND sync_state = 'pending'", message.slice(0, 500), operationId);
}

function tableName(entityType: 'customer' | 'repair' | 'payment' | 'invoice'): string {
  switch (entityType) {
    case 'customer': return 'customers';
    case 'repair': return 'repairs';
    case 'payment': return 'payments';
    case 'invoice': return 'invoices';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRepairStatus(value: unknown): value is RepairStatus {
  return value === 'received' || value === 'diagnosing' || value === 'awaiting_approval' || value === 'waiting_for_parts'
    || value === 'in_repair' || value === 'ready' || value === 'delivered' || value === 'cancelled';
}
