import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';

import {
  isAllowedTransition,
  newRepairSchema,
  paymentReversalSchema,
  paymentSchema,
  setFinalCostSchema,
  updateStatusSchema,
} from '@repair-shop/shared';

import { requireOwner } from '../auth/middleware.js';
import { prisma } from '../db/client.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError, notFound } from '../http/errors.js';
import { getAuthContext } from '../http/request-context.js';

const uuidParamsSchema = z.object({ repairId: z.string().uuid() });
const paymentParamsSchema = z.object({ paymentId: z.string().uuid() });
const searchSchema = z.object({ q: z.string().trim().max(120).default(''), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(100) });

export const repairRouter = Router();
repairRouter.use(requireOwner);

repairRouter.get('/', asyncHandler(async (request, response) => {
  const query = searchSchema.parse(request.query);
  const { ownerId } = getAuthContext(request);
  const status = query.status ? z.enum(['received', 'diagnosing', 'awaiting_approval', 'waiting_for_parts', 'in_repair', 'ready', 'delivered', 'cancelled']).parse(query.status) : undefined;
  const repairs = await prisma.repair.findMany({
    where: {
      ownerId,
      archivedAt: null,
      ...(status ? { status } : {}),
      ...(query.q ? { OR: [
        { receiptNumber: { contains: query.q, mode: 'insensitive' } },
        { brand: { contains: query.q, mode: 'insensitive' } },
        { model: { contains: query.q, mode: 'insensitive' } },
        { customer: { name: { contains: query.q, mode: 'insensitive' } } },
        { customer: { phone: { contains: query.q } } },
      ] } : {}),
    },
    orderBy: { receivedAt: 'desc' },
    take: query.limit,
    include: {
      customer: { select: { id: true, name: true, phone: true } },
      payments: { select: { amountPaisa: true, reversals: { select: { amountPaisa: true } } } },
    },
  });
  response.json({ repairs: repairs.map((repair) => serializeRepair(repair)) });
}));

repairRouter.post('/', asyncHandler(async (request, response) => {
  const input = newRepairSchema.parse(request.body);
  const { ownerId } = getAuthContext(request);
  const repairId = input.id ?? randomUUID();
  const receiptNumber = input.receiptNumber ?? makeReceiptNumber(repairId, new Date());
  const created = await prisma.$transaction(async (transaction) => {
    let customerId = input.customerId;
    if (!customerId && input.customer) {
      customerId = input.customer.id;
      const customer = await transaction.customer.create({
        data: {
          ...(customerId ? { id: customerId } : {}),
          ownerId,
          name: input.customer.name,
          phone: input.customer.phone,
          ...(input.customer.alternatePhone !== undefined ? { alternatePhone: input.customer.alternatePhone } : {}),
          ...(input.customer.address !== undefined ? { address: input.customer.address } : {}),
          ...(input.customer.notes !== undefined ? { notes: input.customer.notes } : {}),
        },
        select: { id: true },
      });
      customerId = customer.id;
    }
    if (!customerId) throw new HttpError(400, 'customer_required', 'Choose or add a customer for this repair.');
    const customer = await transaction.customer.findFirst({ where: { id: customerId, ownerId, archivedAt: null }, select: { id: true } });
    if (!customer) throw notFound();
    const repair = await transaction.repair.create({
      data: {
        id: repairId,
        ownerId,
        customerId,
        receiptNumber,
        brand: input.brand,
        model: input.model,
        ...(input.imei !== undefined ? { imei: input.imei } : {}),
        reportedProblem: input.reportedProblem,
        ...(input.inspectionNotes !== undefined ? { inspectionNotes: input.inspectionNotes } : {}),
        ...(input.accessories !== undefined ? { accessories: input.accessories } : {}),
        ...(input.expectedDeliveryDate ? { expectedDeliveryDate: new Date(`${input.expectedDeliveryDate}T00:00:00.000Z`) } : {}),
        ...(input.estimatedCostPaisa !== undefined ? { estimatedCostPaisa: BigInt(input.estimatedCostPaisa) } : {}),
      },
    });
    await transaction.repairStatusHistory.create({ data: { ownerId, repairId: repair.id, toStatus: 'received' } });
    await transaction.auditEvent.create({ data: { ownerId, eventType: 'repair.created', subjectId: repair.id } });
    return repair;
  }, { isolationLevel: 'Serializable' });
  response.status(201).json({ repair: { id: created.id, receiptNumber: created.receiptNumber, status: created.status, receivedAt: created.receivedAt } });
}));

repairRouter.get('/:repairId', asyncHandler(async (request, response) => {
  const { repairId } = uuidParamsSchema.parse(request.params);
  const { ownerId } = getAuthContext(request);
  const repair = await prisma.repair.findFirst({
    where: { id: repairId, ownerId, archivedAt: null },
    include: {
      customer: true,
      payments: { where: {}, include: { reversals: { orderBy: { reversedAt: 'asc' } } }, orderBy: { paidAt: 'desc' } },
      statusHistory: { orderBy: { changedAt: 'asc' } },
      invoice: true,
    },
  });
  if (!repair) throw notFound();
  response.json({ repair: serializeRepair(repair) });
}));

repairRouter.patch('/:repairId/status', asyncHandler(async (request, response) => {
  const { repairId } = uuidParamsSchema.parse(request.params);
  const input = updateStatusSchema.parse(request.body);
  const { ownerId } = getAuthContext(request);
  const updated = await prisma.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Repair" WHERE "id" = ${repairId}::uuid AND "ownerId" = ${ownerId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) throw notFound();
    const current = await transaction.repair.findFirst({ where: { id: repairId, ownerId }, select: { status: true } });
    if (!current) throw notFound();
    if (current.status === input.status) return current;
    if (!isAllowedTransition(current.status, input.status)) {
      throw new HttpError(409, 'invalid_status_transition', `Repair cannot move from ${current.status.replaceAll('_', ' ')} to ${input.status.replaceAll('_', ' ')}.`);
    }
    const repair = await transaction.repair.update({
      where: { id: repairId },
      data: { status: input.status, deliveredAt: input.status === 'delivered' ? new Date() : null, version: { increment: 1 } },
      select: { id: true, status: true, deliveredAt: true, version: true, updatedAt: true },
    });
    await transaction.repairStatusHistory.create({ data: { ownerId, repairId, fromStatus: current.status, toStatus: input.status, ...(input.note !== undefined ? { note: input.note } : {}) } });
    await transaction.auditEvent.create({ data: { ownerId, eventType: 'repair.status_changed', subjectId: repairId, metadata: { from: current.status, to: input.status } } });
    return repair;
  }, { isolationLevel: 'Serializable' });
  response.json({ repair: updated });
}));

repairRouter.put('/:repairId/final-cost', asyncHandler(async (request, response) => {
  const { repairId } = uuidParamsSchema.parse(request.params);
  const { amountPaisa } = setFinalCostSchema.parse(request.body);
  const { ownerId } = getAuthContext(request);
  const updated = await prisma.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Repair" WHERE "id" = ${repairId}::uuid AND "ownerId" = ${ownerId}::uuid FOR UPDATE
    `;
    if (!locked.length) throw notFound();
    const repair = await transaction.repair.findFirst({ where: { id: repairId, ownerId }, include: { invoice: true } });
    if (!repair) throw notFound();
    if (repair.invoice) throw new HttpError(409, 'invoice_total_locked', 'The billed total is locked after the invoice is issued.');
    const paidPaisa = await netPaidForRepair(transaction, ownerId, repairId);
    if (BigInt(amountPaisa) < paidPaisa) throw new HttpError(409, 'cost_below_payments', 'Final cost cannot be less than payments already received.');
    return transaction.repair.update({ where: { id: repairId }, data: { finalCostPaisa: BigInt(amountPaisa), version: { increment: 1 } }, select: { id: true, finalCostPaisa: true, version: true, updatedAt: true } });
  }, { isolationLevel: 'Serializable' });
  response.json({ repair: { ...updated, finalCostPaisa: updated.finalCostPaisa === null ? null : safeNumber(updated.finalCostPaisa) } });
}));

repairRouter.post('/:repairId/invoice', asyncHandler(async (request, response) => {
  const { repairId } = uuidParamsSchema.parse(request.params);
  const { ownerId } = getAuthContext(request);
  const invoice = await prisma.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Repair" WHERE "id" = ${repairId}::uuid AND "ownerId" = ${ownerId}::uuid FOR UPDATE
    `;
    if (!locked.length) throw notFound();
    const existing = await transaction.invoice.findFirst({ where: { repairId, ownerId } });
    if (existing) return existing;
    const repair = await transaction.repair.findFirst({ where: { id: repairId, ownerId, archivedAt: null }, include: { customer: true } });
    if (!repair) throw notFound();
    if (repair.finalCostPaisa === null) throw new HttpError(409, 'final_cost_required', 'Set the final cost before issuing an invoice.');
    const paid = await netPaidForRepair(transaction, ownerId, repairId);
    if (paid > repair.finalCostPaisa) throw new HttpError(409, 'payments_exceed_final_cost', 'Payments exceed the final cost. Review the payment history.');
    const invoiceId = randomUUID();
    const issuedAt = new Date();
    const created = await transaction.invoice.create({
      data: {
        id: invoiceId,
        ownerId,
        repairId,
        invoiceCode: makeInvoiceCode(invoiceId, issuedAt),
        issuedAt,
        customerNameSnapshot: repair.customer.name,
        customerPhoneSnapshot: repair.customer.phone,
        repairDescriptionSnapshot: `${repair.brand} ${repair.model} — ${repair.reportedProblem}`,
        totalPaisa: repair.finalCostPaisa,
        paidPaisa: paid,
        balancePaisa: repair.finalCostPaisa - paid,
      },
    });
    await transaction.auditEvent.create({ data: { ownerId, eventType: 'invoice.issued', subjectId: created.id } });
    return created;
  }, { isolationLevel: 'Serializable' });
  response.status(201).json({ invoice: serializeInvoice(invoice) });
}));

repairRouter.get('/:repairId/payments', asyncHandler(async (request, response) => {
  const { repairId } = uuidParamsSchema.parse(request.params);
  const { ownerId } = getAuthContext(request);
  const repair = await prisma.repair.findFirst({ where: { id: repairId, ownerId }, select: { id: true } });
  if (!repair) throw notFound();
  const payments = await prisma.payment.findMany({ where: { ownerId, repairId }, orderBy: { paidAt: 'desc' }, include: { reversals: { orderBy: { reversedAt: 'asc' } } } });
  response.json({ payments: payments.map(serializePayment) });
}));

repairRouter.post('/:repairId/payments', asyncHandler(async (request, response) => {
  const { repairId } = uuidParamsSchema.parse(request.params);
  const input = paymentSchema.parse(request.body);
  const { ownerId } = getAuthContext(request);
  const requestHash = hashRequest({ ...input, repairId });
  const result = await prisma.$transaction(async (transaction) => {
    const prior = await transaction.payment.findFirst({ where: { ownerId, idempotencyKey: input.idempotencyKey }, include: { reversals: true } });
    if (prior) {
      if (prior.requestHash !== requestHash) throw new HttpError(409, 'idempotency_key_reused', 'This payment key was already used for a different payment.');
      return { payment: prior, replayed: true };
    }
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Repair" WHERE "id" = ${repairId}::uuid AND "ownerId" = ${ownerId}::uuid FOR UPDATE
    `;
    if (!locked.length) throw notFound();
    const repair = await transaction.repair.findFirst({ where: { id: repairId, ownerId }, select: { finalCostPaisa: true, status: true } });
    if (!repair) throw notFound();
    if (repair.status === 'cancelled') throw new HttpError(409, 'repair_cancelled', 'A cancelled repair cannot accept new payments. Record an adjustment against an existing payment instead.');
    const amountPaisa = BigInt(input.amountPaisa);
    const paid = await netPaidForRepair(transaction, ownerId, repairId);
    if (repair.finalCostPaisa !== null && paid + amountPaisa > repair.finalCostPaisa) {
      throw new HttpError(409, 'overpayment', 'Payment is greater than the outstanding balance.');
    }
    const payment = await transaction.payment.create({
      data: {
        ownerId,
        repairId,
        amountPaisa,
        method: input.method,
        ...(input.transactionReference !== undefined ? { transactionReference: input.transactionReference } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        idempotencyKey: input.idempotencyKey,
        requestHash,
      },
      include: { reversals: true },
    });
    await transaction.auditEvent.create({ data: { ownerId, eventType: 'payment.recorded', subjectId: payment.id } });
    return { payment, replayed: false };
  }, { isolationLevel: 'Serializable' });
  response.status(result.replayed ? 200 : 201).json({ payment: serializePayment(result.payment), replayed: result.replayed });
}));

repairRouter.post('/payments/:paymentId/reversals', asyncHandler(async (request, response) => {
  const { paymentId } = paymentParamsSchema.parse(request.params);
  const input = paymentReversalSchema.parse(request.body);
  const { ownerId } = getAuthContext(request);
  const requestHash = hashRequest({ ...input, paymentId });
  const result = await prisma.$transaction(async (transaction) => {
    const prior = await transaction.paymentReversal.findFirst({ where: { ownerId, idempotencyKey: input.idempotencyKey } });
    if (prior) {
      if (prior.requestHash !== requestHash) throw new HttpError(409, 'idempotency_key_reused', 'This adjustment key was already used for a different adjustment.');
      return { reversal: prior, replayed: true };
    }
    const payment = await transaction.payment.findFirst({ where: { id: paymentId, ownerId }, select: { id: true, repairId: true, amountPaisa: true } });
    if (!payment) throw notFound();
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Repair" WHERE "id" = ${payment.repairId}::uuid AND "ownerId" = ${ownerId}::uuid FOR UPDATE
    `;
    if (!locked.length) throw notFound();
    const sum = await transaction.paymentReversal.aggregate({ where: { ownerId, paymentId }, _sum: { amountPaisa: true } });
    const alreadyReversed = sum._sum.amountPaisa ?? 0n;
    const nextAmount = BigInt(input.amountPaisa);
    if (alreadyReversed + nextAmount > payment.amountPaisa) throw new HttpError(409, 'reversal_exceeds_payment', 'Adjustment cannot exceed the remaining amount of the original payment.');
    const reversal = await transaction.paymentReversal.create({
      data: { ownerId, repairId: payment.repairId, paymentId, amountPaisa: nextAmount, reason: input.reason, idempotencyKey: input.idempotencyKey, requestHash },
    });
    await transaction.auditEvent.create({ data: { ownerId, eventType: 'payment.reversed', subjectId: payment.id, metadata: { reversalId: reversal.id, amountPaisa: input.amountPaisa } } });
    return { reversal, replayed: false };
  }, { isolationLevel: 'Serializable' });
  response.status(result.replayed ? 200 : 201).json({ reversal: serializeReversal(result.reversal), replayed: result.replayed });
}));

async function netPaidForRepair(transaction: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], ownerId: string, repairId: string): Promise<bigint> {
  const rows = await transaction.$queryRaw<Array<{ netPaid: bigint }>>`
    SELECT COALESCE(SUM(p."amountPaisa" - COALESCE(rv."reversedPaisa", 0)), 0)::bigint AS "netPaid"
    FROM "Payment" p
    LEFT JOIN (
      SELECT "paymentId", SUM("amountPaisa") AS "reversedPaisa"
      FROM "PaymentReversal" WHERE "ownerId" = ${ownerId}::uuid GROUP BY "paymentId"
    ) rv ON rv."paymentId" = p."id"
    WHERE p."ownerId" = ${ownerId}::uuid AND p."repairId" = ${repairId}::uuid
  `;
  return rows[0]?.netPaid ?? 0n;
}

function safeNumber(amount: bigint): number {
  const value = Number(amount);
  if (!Number.isSafeInteger(value)) throw new Error('Financial amount exceeds the supported integer range.');
  return value;
}

function serializeRepair(repair: Record<string, any>): Record<string, unknown> {
  const paid = repair.payments?.reduce((sum: bigint, payment: { amountPaisa: bigint; reversals: Array<{ amountPaisa: bigint }> }) =>
    sum + payment.amountPaisa - payment.reversals.reduce((reversed, row) => reversed + row.amountPaisa, 0n), 0n) ?? 0n;
  const total: bigint | null = repair.finalCostPaisa ?? null;
  return {
    id: repair.id,
    receiptNumber: repair.receiptNumber,
    customer: repair.customer ? { id: repair.customer.id, name: repair.customer.name, phone: repair.customer.phone } : undefined,
    brand: repair.brand,
    model: repair.model,
    imei: repair.imei,
    reportedProblem: repair.reportedProblem,
    inspectionNotes: repair.inspectionNotes,
    accessories: repair.accessories,
    status: repair.status,
    receivedAt: repair.receivedAt,
    expectedDeliveryDate: repair.expectedDeliveryDate?.toISOString().slice(0, 10) ?? null,
    deliveredAt: repair.deliveredAt,
    estimatedCostPaisa: repair.estimatedCostPaisa === null ? null : safeNumber(repair.estimatedCostPaisa),
    finalCostPaisa: total === null ? null : safeNumber(total),
    paidPaisa: safeNumber(paid),
    balancePaisa: total === null ? null : safeNumber(total - paid),
    version: repair.version,
    internalNotes: repair.internalNotes,
    paymentHistory: repair.payments?.map(serializePayment),
    statusHistory: repair.statusHistory,
    invoice: repair.invoice ? serializeInvoice(repair.invoice) : undefined,
  };
}

function serializePayment(payment: { id: string; repairId?: string; amountPaisa: bigint; method: string; transactionReference: string | null; note: string | null; paidAt: Date; reversals?: Array<{ id: string; amountPaisa: bigint; reason: string; reversedAt: Date }> }): Record<string, unknown> {
  const reversed = payment.reversals?.reduce((sum, reversal) => sum + reversal.amountPaisa, 0n) ?? 0n;
  return {
    id: payment.id,
    repairId: payment.repairId,
    amountPaisa: safeNumber(payment.amountPaisa),
    method: payment.method,
    transactionReference: payment.transactionReference,
    note: payment.note,
    paidAt: payment.paidAt,
    netAmountPaisa: safeNumber(payment.amountPaisa - reversed),
    reversals: payment.reversals?.map(serializeReversal),
  };
}

function serializeReversal(reversal: { id: string; paymentId?: string; amountPaisa: bigint; reason: string; reversedAt: Date }): Record<string, unknown> {
  return { id: reversal.id, paymentId: reversal.paymentId, amountPaisa: safeNumber(reversal.amountPaisa), reason: reversal.reason, reversedAt: reversal.reversedAt };
}

function serializeInvoice(invoice: { id: string; repairId: string; invoiceCode: string; issuedAt: Date; customerNameSnapshot: string; customerPhoneSnapshot: string; repairDescriptionSnapshot: string; totalPaisa: bigint; paidPaisa: bigint; balancePaisa: bigint }): Record<string, unknown> {
  return {
    id: invoice.id,
    repairId: invoice.repairId,
    invoiceCode: invoice.invoiceCode,
    issuedAt: invoice.issuedAt,
    customerName: invoice.customerNameSnapshot,
    customerPhone: invoice.customerPhoneSnapshot,
    description: invoice.repairDescriptionSnapshot,
    totalPaisa: safeNumber(invoice.totalPaisa),
    paidPaisa: safeNumber(invoice.paidPaisa),
    balancePaisa: safeNumber(invoice.balancePaisa),
  };
}

function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function makeReceiptNumber(repairId: string, date: Date): string {
  return `MRM-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${repairId.replace(/-/g, '').toUpperCase()}`;
}

function makeInvoiceCode(invoiceId: string, date: Date): string {
  return `INV-${date.toISOString().slice(0, 10).replace(/-/g, '')}-${invoiceId.replace(/-/g, '').toUpperCase()}`;
}
