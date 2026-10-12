import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  isAllowedTransition, syncCustomerPayloadSchema, syncFinalCostPayloadSchema,
  syncInvoicePayloadSchema, syncPaymentPayloadSchema, syncPullSchema, syncPushSchema,
  syncPaymentReversalPayloadSchema, syncRepairPayloadSchema, syncStatusPayloadSchema,
} from '@repair-shop/shared';

import { requireOwner } from '../auth/middleware.js';
import { prisma } from '../db/client.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError, notFound } from '../http/errors.js';
import { getAuthContext } from '../http/request-context.js';

const cursorPointSchema = z.object({ time: z.string().datetime({ offset: true }), id: z.string().uuid(), version: z.number().int().positive().optional() }).strict();
const cursorStateSchema = z.object({
  customers: cursorPointSchema.optional(), repairs: cursorPointSchema.optional(), payments: cursorPointSchema.optional(),
  reversals: cursorPointSchema.optional(), invoices: cursorPointSchema.optional(), statusHistory: cursorPointSchema.optional(),
}).strict();
type CursorPoint = z.infer<typeof cursorPointSchema>;
type CursorState = z.infer<typeof cursorStateSchema>;

function decodeCursor(value: string | undefined): CursorState {
  if (!value) return {};
  try {
    const raw: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return cursorStateSchema.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_sync_cursor', 'The sync cursor is invalid. Restart synchronization.');
  }
}

function encodeCursor(cursor: CursorState): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function cursorWhere(point: CursorPoint | undefined, timeField: string): Record<string, unknown> {
  if (!point) return {};
  const time = new Date(point.time);
  const nextId = { [timeField]: time, id: { gt: point.id } };
  const version = point.version === undefined ? [] : [{ [timeField]: time, id: point.id, version: { gt: point.version } }];
  return { OR: [{ [timeField]: { gt: time } }, nextId, ...version] };
}

function pointAfter<T extends { id: string; version?: number }>(row: T | undefined, previous: CursorPoint | undefined, timeField: keyof T): CursorPoint | undefined {
  if (!row) return previous;
  const value = row[timeField];
  if (!(value instanceof Date)) throw new Error('A sync record is missing its timestamp.');
  return { time: value.toISOString(), id: row.id, ...(row.version === undefined ? {} : { version: row.version }) };
}

export const syncRouter = Router();
syncRouter.use(requireOwner);

syncRouter.post('/push', asyncHandler(async (request, response) => {
  const input = syncPushSchema.parse(request.body);
  const { ownerId } = getAuthContext(request);
  const results: Array<{ operationId: string; status: 'applied' | 'replayed' | 'conflict'; version?: number; snapshot?: unknown }> = [];
  for (const operation of input.operations) {
    const result = await prisma.$transaction(async (transaction) => {
      const prior = await transaction.syncOperation.findUnique({ where: { ownerId_operationId: { ownerId, operationId: operation.operationId } } });
      if (prior) {
        const savedResult = asObject(prior.resultJson);
        if (savedResult?.status === 'conflict') return { operationId: operation.operationId, status: 'conflict' as const, snapshot: savedResult.snapshot ?? null };
        return { operationId: operation.operationId, status: 'replayed' as const, ...(prior.resultVersion === null ? {} : { version: prior.resultVersion }) };
      }
      const processed = await applyOperation(transaction, ownerId, operation);
      await transaction.syncOperation.create({ data: {
        ownerId, operationId: operation.operationId, clientId: input.clientId,
        entityType: operation.entityType, entityId: operation.entityId,
        resultVersion: processed.status === 'applied' ? processed.version : null,
        resultJson: processed.status === 'conflict' ? { status: 'conflict', snapshot: toJsonSnapshot(processed.snapshot) } : { status: 'applied' },
      } });
      return { operationId: operation.operationId, ...processed };
    }, { isolationLevel: 'Serializable' });
    results.push(result);
  }
  response.json({ results });
}));

syncRouter.get('/pull', asyncHandler(async (request, response) => {
  const query = syncPullSchema.parse(request.query);
  const { ownerId } = getAuthContext(request);
  const cursor = decodeCursor(query.cursor);
  const take = query.limit;
  const [customers, repairs, payments, reversals, invoices, history] = await Promise.all([
    prisma.customer.findMany({ where: { ownerId, ...cursorWhere(cursor.customers, 'updatedAt') }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take }),
    prisma.repair.findMany({ where: { ownerId, ...cursorWhere(cursor.repairs, 'updatedAt') }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take }),
    prisma.payment.findMany({ where: { ownerId, ...cursorWhere(cursor.payments, 'createdAt') }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, include: { reversals: true } }),
    prisma.paymentReversal.findMany({ where: { ownerId, ...cursorWhere(cursor.reversals, 'reversedAt') }, orderBy: [{ reversedAt: 'asc' }, { id: 'asc' }], take }),
    prisma.invoice.findMany({ where: { ownerId, ...cursorWhere(cursor.invoices, 'createdAt') }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take }),
    prisma.repairStatusHistory.findMany({ where: { ownerId, ...cursorWhere(cursor.statusHistory, 'createdAt') }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take }),
  ]);
  const nextCursor = {
    customers: pointAfter(customers.at(-1), cursor.customers, 'updatedAt'),
    repairs: pointAfter(repairs.at(-1), cursor.repairs, 'updatedAt'),
    payments: pointAfter(payments.at(-1), cursor.payments, 'createdAt'),
    reversals: pointAfter(reversals.at(-1), cursor.reversals, 'reversedAt'),
    invoices: pointAfter(invoices.at(-1), cursor.invoices, 'createdAt'),
    statusHistory: pointAfter(history.at(-1), cursor.statusHistory, 'createdAt'),
  };
  response.json({ cursor: encodeCursor(nextCursor), hasMore: [customers, repairs, payments, reversals, invoices, history].some((rows) => rows.length === take), changes: {
    customers: customers.map((row) => ({ ...row, version: row.version })),
    repairs: repairs.map((row) => ({ ...row, estimatedCostPaisa: safeNumber(row.estimatedCostPaisa), finalCostPaisa: safeNumber(row.finalCostPaisa) })),
    payments: payments.map((row) => ({ ...row, amountPaisa: safeNumber(row.amountPaisa), reversals: row.reversals.map((reversal) => ({ ...reversal, amountPaisa: safeNumber(reversal.amountPaisa) })) })),
    reversals: reversals.map((row) => ({ ...row, amountPaisa: safeNumber(row.amountPaisa) })),
    invoices: invoices.map((row) => ({ ...row, totalPaisa: safeNumber(row.totalPaisa), paidPaisa: safeNumber(row.paidPaisa), balancePaisa: safeNumber(row.balancePaisa) })),
    statusHistory: history,
  } });
}));

type Operation = z.infer<typeof syncPushSchema>['operations'][number];
type Transaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Applied = { status: 'applied'; version: number };
type Conflict = { status: 'conflict'; snapshot: unknown };

async function applyOperation(transaction: Transaction, ownerId: string, operation: Operation): Promise<Applied | Conflict> {
  if (operation.entityType === 'customer' && operation.operation === 'upsert') {
    const input = syncCustomerPayloadSchema.parse(operation.payload);
    if (input.id !== operation.entityId) throw new HttpError(400, 'entity_id_mismatch', 'The sync entity ID does not match its payload.');
    const current = await transaction.customer.findFirst({ where: { id: operation.entityId, ownerId } });
    if (current && operation.baseVersion !== current.version) return { status: 'conflict', snapshot: { ...current, version: current.version } };
    if (!current && operation.baseVersion !== null) return { status: 'conflict', snapshot: null };
    const row = current
      ? await transaction.customer.update({ where: { id: current.id }, data: { name: input.name, phone: input.phone, alternatePhone: input.alternatePhone ?? null, address: input.address ?? null, notes: input.notes ?? null, archivedAt: null, version: { increment: 1 } } })
      : await transaction.customer.create({ data: { id: operation.entityId, ownerId, name: input.name, phone: input.phone, alternatePhone: input.alternatePhone ?? null, address: input.address ?? null, notes: input.notes ?? null } });
    return { status: 'applied', version: row.version };
  }

  if (operation.entityType === 'repair' && operation.operation === 'upsert' && 'amountPaisa' in operation.payload) {
    const input = syncFinalCostPayloadSchema.parse(operation.payload);
    if (input.repairId !== operation.entityId) throw new HttpError(400, 'entity_id_mismatch', 'The sync entity ID does not match its payload.');
    await transaction.$queryRaw`SELECT "id" FROM "Repair" WHERE "id" = ${input.repairId}::uuid AND "ownerId" = ${ownerId}::uuid FOR UPDATE`;
    const repair = await transaction.repair.findFirst({ where: { id: input.repairId, ownerId }, include: { invoice: true } });
    if (!repair) throw notFound();
    if (repair.invoice) return { status: 'conflict', snapshot: repair };
    if (operation.baseVersion !== repair.version) return { status: 'conflict', snapshot: repair };
    const paid = await netPaidForRepair(transaction, ownerId, repair.id);
    if (BigInt(input.amountPaisa) < paid) return { status: 'conflict', snapshot: repair };
    const updated = await transaction.repair.update({ where: { id: repair.id }, data: { finalCostPaisa: BigInt(input.amountPaisa), version: { increment: 1 } } });
    return { status: 'applied', version: updated.version };
  }

  if (operation.entityType === 'repair' && operation.operation === 'upsert') {
    const input = syncRepairPayloadSchema.parse(operation.payload);
    if (input.id !== operation.entityId) throw new HttpError(400, 'entity_id_mismatch', 'The sync entity ID does not match its payload.');
    const customer = await transaction.customer.findFirst({ where: { id: input.customerId, ownerId, archivedAt: null }, select: { id: true } });
    if (!customer) throw notFound();
    const current = await transaction.repair.findFirst({ where: { id: operation.entityId, ownerId } });
    if (current && operation.baseVersion !== current.version) return { status: 'conflict', snapshot: current };
    if (!current && operation.baseVersion !== null) return { status: 'conflict', snapshot: null };
    const row = current
      ? await transaction.repair.update({ where: { id: current.id }, data: { brand: input.brand, model: input.model, imei: input.imei ?? null, reportedProblem: input.reportedProblem, inspectionNotes: input.inspectionNotes ?? null, accessories: input.accessories ?? null, expectedDeliveryDate: input.expectedDeliveryDate ? new Date(`${input.expectedDeliveryDate}T00:00:00.000Z`) : null, estimatedCostPaisa: input.estimatedCostPaisa === undefined || input.estimatedCostPaisa === null ? null : BigInt(input.estimatedCostPaisa), internalNotes: input.internalNotes ?? null, version: { increment: 1 } } })
      : await transaction.repair.create({ data: { id: input.id, ownerId, customerId: input.customerId, receiptNumber: input.receiptNumber, brand: input.brand, model: input.model, imei: input.imei ?? null, reportedProblem: input.reportedProblem, inspectionNotes: input.inspectionNotes ?? null, accessories: input.accessories ?? null, receivedAt: new Date(input.receivedAt), expectedDeliveryDate: input.expectedDeliveryDate ? new Date(`${input.expectedDeliveryDate}T00:00:00.000Z`) : null, estimatedCostPaisa: input.estimatedCostPaisa === undefined || input.estimatedCostPaisa === null ? null : BigInt(input.estimatedCostPaisa), internalNotes: input.internalNotes ?? null } });
    if (!current) await transaction.repairStatusHistory.create({ data: { ownerId, repairId: row.id, toStatus: 'received', changedAt: row.receivedAt } });
    return { status: 'applied', version: row.version };
  }

  if (operation.entityType === 'repair' && operation.operation === 'archive') {
    const repair = await transaction.repair.findFirst({ where: { id: operation.entityId, ownerId } });
    if (!repair) throw notFound();
    if (operation.baseVersion !== repair.version) return { status: 'conflict', snapshot: repair };
    const row = await transaction.repair.update({ where: { id: repair.id }, data: { archivedAt: new Date(), version: { increment: 1 } } });
    return { status: 'applied', version: row.version };
  }

  if (operation.entityType === 'payment' && operation.operation === 'create_event') {
    const input = syncPaymentPayloadSchema.parse(operation.payload);
    if (input.id !== operation.entityId) throw new HttpError(400, 'entity_id_mismatch', 'The sync entity ID does not match its payload.');
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Repair" WHERE "id" = ${input.repairId}::uuid AND "ownerId" = ${ownerId}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound();
    const repair = await transaction.repair.findFirst({ where: { id: input.repairId, ownerId }, select: { id: true, finalCostPaisa: true, status: true } });
    if (!repair) throw notFound();
    if (repair.status === 'cancelled') return { status: 'conflict', snapshot: { repair, reason: 'repair_cancelled' } };
    const duplicate = await transaction.payment.findFirst({ where: { ownerId, idempotencyKey: input.idempotencyKey } });
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (duplicate) {
      if (duplicate.id !== input.id || duplicate.requestHash !== requestHash) return { status: 'conflict', snapshot: { payment: duplicate, reason: 'idempotency_key_reused' } };
      return { status: 'applied', version: 1 };
    }
    const currentPaid = await netPaidForRepair(transaction, ownerId, repair.id);
    if (repair.finalCostPaisa !== null && currentPaid + BigInt(input.amountPaisa) > repair.finalCostPaisa) return { status: 'conflict', snapshot: { repair, paidPaisa: safeNumber(currentPaid), requestedPaisa: input.amountPaisa, reason: 'overpayment' } };
    const payment = await transaction.payment.create({ data: { id: input.id, ownerId, repairId: repair.id, amountPaisa: BigInt(input.amountPaisa), method: input.method, transactionReference: input.transactionReference ?? null, note: input.note ?? null, idempotencyKey: input.idempotencyKey, requestHash, paidAt: new Date(input.paidAt) } });
    await transaction.auditEvent.create({ data: { ownerId, eventType: 'payment.recorded', subjectId: payment.id, metadata: { source: 'offline_sync' } } });
    return { status: 'applied', version: 1 };
  }

  if (operation.entityType === 'payment_reversal' && operation.operation === 'create_event') {
    const input = syncPaymentReversalPayloadSchema.parse(operation.payload);
    if (input.id !== operation.entityId) throw new HttpError(400, 'entity_id_mismatch', 'The sync entity ID does not match its payload.');
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Repair" WHERE "id" = ${input.repairId}::uuid AND "ownerId" = ${ownerId}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound();
    const payment = await transaction.payment.findFirst({ where: { id: input.paymentId, repairId: input.repairId, ownerId } });
    if (!payment) throw notFound();
    const requestHash = createHash('sha256').update(JSON.stringify({ amountPaisa: input.amountPaisa, reason: input.reason, idempotencyKey: input.idempotencyKey, paymentId: input.paymentId })).digest('hex');
    const duplicate = await transaction.paymentReversal.findFirst({ where: { ownerId, idempotencyKey: input.idempotencyKey } });
    if (duplicate) {
      if (duplicate.id !== input.id || duplicate.requestHash !== requestHash) return { status: 'conflict', snapshot: { reversal: duplicate, reason: 'idempotency_key_reused' } };
      return { status: 'applied', version: 1 };
    }
    const alreadyReversed = await transaction.paymentReversal.aggregate({ where: { ownerId, paymentId: payment.id }, _sum: { amountPaisa: true } });
    if ((alreadyReversed._sum.amountPaisa ?? 0n) + BigInt(input.amountPaisa) > payment.amountPaisa) return { status: 'conflict', snapshot: { payment, reversedPaisa: safeNumber(alreadyReversed._sum.amountPaisa ?? 0n), reason: 'reversal_exceeds_payment' } };
    const reversal = await transaction.paymentReversal.create({ data: { id: input.id, ownerId, repairId: payment.repairId, paymentId: payment.id, amountPaisa: BigInt(input.amountPaisa), reason: input.reason, idempotencyKey: input.idempotencyKey, requestHash, reversedAt: new Date(input.reversedAt) } });
    await transaction.auditEvent.create({ data: { ownerId, eventType: 'payment.reversed', subjectId: payment.id, metadata: { reversalId: reversal.id, source: 'offline_sync' } } });
    return { status: 'applied', version: 1 };
  }

  if (operation.entityType === 'repair_status_history' && operation.operation === 'create_event') {
    const input = syncStatusPayloadSchema.parse(operation.payload);
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Repair" WHERE "id" = ${input.repairId}::uuid AND "ownerId" = ${ownerId}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound();
    const repair = await transaction.repair.findFirst({ where: { id: input.repairId, ownerId } });
    if (!repair) throw notFound();
    if (operation.baseVersion !== repair.version) return { status: 'conflict', snapshot: repair };
    if (repair.status !== input.fromStatus || !isAllowedTransition(repair.status, input.status)) return { status: 'conflict', snapshot: repair };
    const updated = await transaction.repair.update({ where: { id: repair.id }, data: { status: input.status, deliveredAt: input.status === 'delivered' ? new Date(input.changedAt) : null, version: { increment: 1 } } });
    await transaction.repairStatusHistory.create({ data: { id: operation.entityId, ownerId, repairId: repair.id, fromStatus: input.fromStatus, toStatus: input.status, changedAt: new Date(input.changedAt), note: input.note ?? null } });
    return { status: 'applied', version: updated.version };
  }

  if (operation.entityType === 'invoice' && operation.operation === 'create_event') {
    const input = syncInvoicePayloadSchema.parse(operation.payload);
    if (input.id !== operation.entityId) throw new HttpError(400, 'entity_id_mismatch', 'The sync entity ID does not match its payload.');
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Repair" WHERE "id" = ${input.repairId}::uuid AND "ownerId" = ${ownerId}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound();
    const repair = await transaction.repair.findFirst({ where: { id: input.repairId, ownerId }, select: { id: true, finalCostPaisa: true } });
    if (!repair || repair.finalCostPaisa !== BigInt(input.totalPaisa)) return { status: 'conflict', snapshot: { repair, reason: 'invoice_total_changed' } };
    const paid = await netPaidForRepair(transaction, ownerId, input.repairId);
    if (paid !== BigInt(input.paidPaisa) || BigInt(input.balancePaisa) !== repair.finalCostPaisa - paid) {
      return { status: 'conflict', snapshot: { repair, paidPaisa: safeNumber(paid) } };
    }
    const existingInvoice = await transaction.invoice.findFirst({ where: { repairId: input.repairId, ownerId } });
    if (existingInvoice && existingInvoice.id !== input.id) return { status: 'conflict', snapshot: existingInvoice };
    const invoice = await transaction.invoice.upsert({ where: { repairId: input.repairId }, create: { id: input.id, ownerId, repairId: input.repairId, invoiceCode: input.invoiceCode, issuedAt: new Date(input.issuedAt), customerNameSnapshot: input.customerName, customerPhoneSnapshot: input.customerPhone, repairDescriptionSnapshot: input.description, totalPaisa: BigInt(input.totalPaisa), paidPaisa: BigInt(input.paidPaisa), balancePaisa: BigInt(input.balancePaisa) }, update: {} });
    return { status: 'applied', version: 1 };
  }

  throw new HttpError(400, 'unsupported_sync_operation', `Unsupported sync operation for ${operation.entityType}.`);
}

async function netPaidForRepair(transaction: Transaction, ownerId: string, repairId: string): Promise<bigint> {
  const rows = await transaction.$queryRaw<Array<{ paid: bigint }>>`
    SELECT COALESCE(SUM(p."amountPaisa" - COALESCE(r."amountReversed", 0)), 0)::bigint AS "paid"
    FROM "Payment" p LEFT JOIN (
      SELECT "paymentId", SUM("amountPaisa") AS "amountReversed" FROM "PaymentReversal" WHERE "ownerId" = ${ownerId}::uuid GROUP BY "paymentId"
    ) r ON r."paymentId" = p."id"
    WHERE p."ownerId" = ${ownerId}::uuid AND p."repairId" = ${repairId}::uuid
  `;
  return rows[0]?.paid ?? 0n;
}

function safeNumber(amount: bigint | null): number | null {
  if (amount === null) return null;
  const value = Number(amount);
  if (!Number.isSafeInteger(value)) throw new Error('Financial amount exceeds the supported integer range.');
  return value;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toJsonSnapshot(value: unknown): object {
  const json = JSON.stringify(value, (_key: string, item: unknown) => typeof item === 'bigint' ? Number(item) : item);
  if (json === undefined) return {};
  return JSON.parse(json) as object;
}
