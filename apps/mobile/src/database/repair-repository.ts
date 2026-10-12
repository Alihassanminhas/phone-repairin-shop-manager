import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';

import type { DashboardSummary, InvoiceRecord, MonthlyPaymentRecord, NewRepairInput, PaymentRecord, RepairDetails, RepairListItem, RepairStatus } from '@/features/repairs/types';
import { enqueueSyncOperation } from '@/database/outbox';
import { withEncryptedExclusiveTransaction } from '@/database/encrypted-transaction';

function timestamp(): string {
  return new Date().toISOString();
}

function todayLocal(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function makeReceiptCode(now: Date, id: string): string {
  const datePart = `${now.getFullYear()}${`${now.getMonth() + 1}`.padStart(2, '0')}${`${now.getDate()}`.padStart(2, '0')}`;
  return `MRM-${datePart}-${id.replace(/-/g, '').toUpperCase()}`;
}

function normalizePhone(phone: string): string {
  return phone.replace(/[\s()+.-]/g, '');
}

/** Saves a repair and any advance payment atomically before showing success. */
export async function createRepair(
  database: SQLiteDatabase,
  input: NewRepairInput,
): Promise<{ id: string; receiptNumber: string }> {
  const customerName = input.customerName.trim();
  const customerPhone = input.customerPhone.trim();
  const brand = input.brand.trim();
  const model = input.model.trim();
  const reportedProblem = input.reportedProblem.trim();
  if (!customerName || !customerPhone || !brand || !model || !reportedProblem) {
    throw new Error('Enter the customer, phone, model, and reported problem.');
  }
  if (normalizePhone(customerPhone).length < 5) throw new Error('Enter a valid customer phone number.');
  if (input.initialPaymentPaisa !== undefined && (!Number.isSafeInteger(input.initialPaymentPaisa) || input.initialPaymentPaisa < 0)) {
    throw new Error('The advance payment must be a valid non-negative amount.');
  }
  if (input.estimatedCostPaisa !== undefined && (!Number.isSafeInteger(input.estimatedCostPaisa) || input.estimatedCostPaisa < 0)) {
    throw new Error('The estimate must be a valid non-negative amount.');
  }

  const id = Crypto.randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const receiptNumber = makeReceiptCode(now, id);

  await withEncryptedExclusiveTransaction(database, async (transaction) => {
    const phoneKey = normalizePhone(customerPhone);
    const existingCustomer = await transaction.getFirstAsync<{ id: string }>(
      `SELECT id FROM customers WHERE archived_at IS NULL AND
        replace(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '(', ''), ')', '') = ?
       LIMIT 1`,
      phoneKey,
    );
    const customerId = existingCustomer?.id ?? Crypto.randomUUID();
    if (!existingCustomer) {
      await transaction.runAsync(
        `INSERT INTO customers (id, name, phone, created_at, updated_at, sync_state)
         VALUES (?, ?, ?, ?, ?, 'local')`,
        customerId, customerName, customerPhone, createdAt, createdAt,
      );
      await enqueueSyncOperation(transaction, { entityType: 'customer', entityId: customerId, operation: 'upsert', baseVersion: null, payload: { id: customerId, name: customerName, phone: customerPhone } });
    }
    await transaction.runAsync(
      `INSERT INTO repairs (
        id, receipt_number, customer_id, brand, model, reported_problem,
        received_at, expected_delivery_date, status, estimated_cost_paisa,
        created_at, updated_at, sync_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, 'local')`,
      id,
      receiptNumber,
      customerId,
      brand,
      model,
      reportedProblem,
      createdAt,
      input.expectedDeliveryDate ?? null,
      input.estimatedCostPaisa ?? null,
      createdAt,
      createdAt,
    );
    await transaction.runAsync(
      `INSERT INTO repair_status_history (id, repair_id, from_status, to_status, changed_at, created_at)
       VALUES (?, ?, NULL, 'received', ?, ?)`,
      Crypto.randomUUID(),
      id,
      createdAt,
      createdAt,
    );
    await enqueueSyncOperation(transaction, {
      entityType: 'repair', entityId: id, operation: 'upsert', baseVersion: null,
      payload: { id, receiptNumber, customerId, brand, model, reportedProblem, receivedAt: createdAt, expectedDeliveryDate: input.expectedDeliveryDate ?? null, estimatedCostPaisa: input.estimatedCostPaisa ?? null },
    });
    if ((input.initialPaymentPaisa ?? 0) > 0) {
      const paymentId = Crypto.randomUUID();
      const idempotencyKey = Crypto.randomUUID();
      await transaction.runAsync(
        `INSERT INTO payments (
          id, repair_id, amount_paisa, method, paid_at, idempotency_key, created_at, sync_state
        ) VALUES (?, ?, ?, 'cash', ?, ?, ?, 'local')`,
        paymentId,
        id,
        input.initialPaymentPaisa ?? 0,
        createdAt,
        idempotencyKey,
        createdAt,
      );
      await enqueueSyncOperation(transaction, { entityType: 'payment', entityId: paymentId, operation: 'create_event', baseVersion: null, payload: { id: paymentId, repairId: id, amountPaisa: input.initialPaymentPaisa, method: 'cash', idempotencyKey, paidAt: createdAt } });
    }
  });

  return { id, receiptNumber };
}

export async function listRepairs(
  database: SQLiteDatabase,
  search = '',
): Promise<RepairListItem[]> {
  const query = `%${search.trim()}%`;
  return database.getAllAsync<RepairListItem>(
    `SELECT
       r.id,
       r.receipt_number AS receiptNumber,
       c.name AS customerName,
       c.phone AS customerPhone,
       r.brand,
       r.model,
       r.status,
       r.received_at AS receivedAt,
       r.final_cost_paisa AS finalCostPaisa,
       r.estimated_cost_paisa AS estimatedCostPaisa,
       COALESCE(SUM(CASE WHEN p.voided_at IS NULL THEN p.amount_paisa - COALESCE(rv.reversed_paisa, 0) ELSE 0 END), 0) AS paidPaisa,
       CASE WHEN r.final_cost_paisa IS NULL THEN NULL ELSE
         r.final_cost_paisa - COALESCE(SUM(CASE WHEN p.voided_at IS NULL THEN p.amount_paisa - COALESCE(rv.reversed_paisa, 0) ELSE 0 END), 0)
       END AS balancePaisa
     FROM repairs r
     JOIN customers c ON c.id = r.customer_id
     LEFT JOIN payments p ON p.repair_id = r.id
     LEFT JOIN (SELECT payment_id, SUM(amount_paisa) AS reversed_paisa FROM payment_reversals GROUP BY payment_id) rv ON rv.payment_id = p.id
     WHERE c.archived_at IS NULL AND (
       ? = '%%' OR r.receipt_number LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR r.brand LIKE ? OR r.model LIKE ?
     )
     GROUP BY r.id
     ORDER BY r.received_at DESC
     LIMIT 100`,
    query,
    query,
    query,
    query,
    query,
    query,
  );
}

export async function getRepairDetails(database: SQLiteDatabase, repairId: string): Promise<RepairDetails | null> {
  return database.getFirstAsync<RepairDetails>(
    `SELECT r.id, r.receipt_number AS receiptNumber, c.name AS customerName,
      c.phone AS customerPhone, r.brand, r.model, r.status, r.received_at AS receivedAt,
      r.final_cost_paisa AS finalCostPaisa, r.estimated_cost_paisa AS estimatedCostPaisa,
      COALESCE(SUM(CASE WHEN p.voided_at IS NULL THEN p.amount_paisa - COALESCE(rv.reversed_paisa, 0) ELSE 0 END), 0) AS paidPaisa,
      CASE WHEN r.final_cost_paisa IS NULL THEN NULL ELSE r.final_cost_paisa -
        COALESCE(SUM(CASE WHEN p.voided_at IS NULL THEN p.amount_paisa - COALESCE(rv.reversed_paisa, 0) ELSE 0 END), 0) END AS balancePaisa,
      r.customer_id AS customerId, r.reported_problem AS reportedProblem,
      r.expected_delivery_date AS expectedDeliveryDate, r.delivered_at AS deliveredAt,
      r.internal_notes AS internalNotes
     FROM repairs r JOIN customers c ON c.id = r.customer_id
     LEFT JOIN payments p ON p.repair_id = r.id
     LEFT JOIN (SELECT payment_id, SUM(amount_paisa) AS reversed_paisa FROM payment_reversals GROUP BY payment_id) rv ON rv.payment_id = p.id
     WHERE r.id = ? GROUP BY r.id`,
    repairId,
  );
}

export async function getPayments(database: SQLiteDatabase, repairId: string): Promise<PaymentRecord[]> {
  const payments = await database.getAllAsync<PaymentRecord>(
    `SELECT p.id, p.amount_paisa AS amountPaisa, p.method, p.paid_at AS paidAt,
      p.note, p.transaction_reference AS transactionReference, COALESCE(rv.reversed_paisa, 0) AS reversedPaisa,
      p.amount_paisa - COALESCE(rv.reversed_paisa, 0) AS netAmountPaisa
     FROM payments p LEFT JOIN (SELECT payment_id, SUM(amount_paisa) AS reversed_paisa FROM payment_reversals GROUP BY payment_id) rv ON rv.payment_id = p.id
     WHERE p.repair_id = ? AND p.voided_at IS NULL ORDER BY p.paid_at DESC`,
    repairId,
  );
  return Promise.all(payments.map(async (payment) => ({
    ...payment,
    reversals: await database.getAllAsync<{ id: string; amountPaisa: number; reason: string; reversedAt: string }>(
      'SELECT id, amount_paisa AS amountPaisa, reason, reversed_at AS reversedAt FROM payment_reversals WHERE payment_id = ? ORDER BY reversed_at', payment.id,
    ),
  })));
}

export async function getReversiblePayment(database: SQLiteDatabase, paymentId: string): Promise<{ amountPaisa: number; reversedPaisa: number; remainingPaisa: number } | null> {
  return database.getFirstAsync<{ amountPaisa: number; reversedPaisa: number; remainingPaisa: number }>(
    `SELECT p.amount_paisa AS amountPaisa, COALESCE(SUM(rv.amount_paisa), 0) AS reversedPaisa,
      p.amount_paisa - COALESCE(SUM(rv.amount_paisa), 0) AS remainingPaisa
     FROM payments p LEFT JOIN payment_reversals rv ON rv.payment_id = p.id WHERE p.id = ? GROUP BY p.id`, paymentId,
  );
}

export async function addPayment(
  database: SQLiteDatabase,
  repairId: string,
  amountPaisa: number,
  method: PaymentRecord['method'],
): Promise<void> {
  if (!Number.isSafeInteger(amountPaisa) || amountPaisa <= 0) throw new Error('Payment must be a positive amount.');
  const paidAt = timestamp();
  await withEncryptedExclusiveTransaction(database, async (transaction) => {
    const repair = await transaction.getFirstAsync<{ finalCostPaisa: number | null; paidPaisa: number }>(
      `SELECT r.final_cost_paisa AS finalCostPaisa,
        COALESCE(SUM(CASE WHEN p.voided_at IS NULL THEN p.amount_paisa - COALESCE(rv.reversed_paisa, 0) ELSE 0 END), 0) AS paidPaisa
       FROM repairs r LEFT JOIN payments p ON p.repair_id = r.id
       LEFT JOIN (SELECT payment_id, SUM(amount_paisa) AS reversed_paisa FROM payment_reversals GROUP BY payment_id) rv ON rv.payment_id = p.id
       WHERE r.id = ? GROUP BY r.id`,
      repairId,
    );
    if (!repair) throw new Error('Repair record not found.');
    if (repair.finalCostPaisa !== null && amountPaisa > repair.finalCostPaisa - repair.paidPaisa) {
      throw new Error('This payment is greater than the outstanding balance.');
    }
    const paymentId = Crypto.randomUUID();
    const idempotencyKey = Crypto.randomUUID();
    await transaction.runAsync(
      `INSERT INTO payments (id, repair_id, amount_paisa, method, paid_at, idempotency_key, created_at, sync_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'local')`,
      paymentId, repairId, amountPaisa, method, paidAt, idempotencyKey, paidAt,
    );
    await enqueueSyncOperation(transaction, { entityType: 'payment', entityId: paymentId, operation: 'create_event', baseVersion: null, payload: { id: paymentId, repairId, amountPaisa, method, idempotencyKey, paidAt } });
  });
}

/** Records a partial or full payment adjustment as a separate immutable event. */
export async function reversePayment(database: SQLiteDatabase, paymentId: string, amountPaisa: number, reason: string): Promise<void> {
  const normalizedReason = reason.trim();
  if (!Number.isSafeInteger(amountPaisa) || amountPaisa <= 0) throw new Error('Adjustment must be a positive amount.');
  if (normalizedReason.length < 3 || normalizedReason.length > 500) throw new Error('Enter a reason between 3 and 500 characters.');
  const reversedAt = timestamp();
  const id = Crypto.randomUUID();
  const idempotencyKey = Crypto.randomUUID();
  await withEncryptedExclusiveTransaction(database, async (transaction) => {
    const payment = await transaction.getFirstAsync<{ repairId: string; amountPaisa: number; reversedPaisa: number }>(
      `SELECT p.repair_id AS repairId, p.amount_paisa AS amountPaisa, COALESCE(SUM(rv.amount_paisa), 0) AS reversedPaisa
       FROM payments p LEFT JOIN payment_reversals rv ON rv.payment_id = p.id WHERE p.id = ? GROUP BY p.id`, paymentId,
    );
    if (!payment) throw new Error('Payment record not found.');
    if (amountPaisa > payment.amountPaisa - payment.reversedPaisa) throw new Error('Adjustment cannot exceed the remaining amount of the original payment.');
    await transaction.runAsync(`INSERT INTO payment_reversals (id, payment_id, repair_id, amount_paisa, reason, idempotency_key, reversed_at, sync_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'local')`, id, paymentId, payment.repairId, amountPaisa, normalizedReason, idempotencyKey, reversedAt);
    await enqueueSyncOperation(transaction, {
      entityType: 'payment_reversal', entityId: id, operation: 'create_event', baseVersion: null,
      payload: { id, paymentId, repairId: payment.repairId, amountPaisa, reason: normalizedReason, idempotencyKey, reversedAt },
    });
  });
}

/** Updates the final bill only while it can still be reconciled with payments and invoices. */
export async function setFinalCost(database: SQLiteDatabase, repairId: string, amountPaisa: number): Promise<void> {
  if (!Number.isSafeInteger(amountPaisa) || amountPaisa < 0) throw new Error('Enter a valid non-negative final cost.');
  await withEncryptedExclusiveTransaction(database, async (transaction) => {
    const record = await transaction.getFirstAsync<{ paidPaisa: number; invoiceId: string | null; version: number }>(
      `SELECT COALESCE(SUM(CASE WHEN p.voided_at IS NULL THEN p.amount_paisa - COALESCE(rv.reversed_paisa, 0) ELSE 0 END), 0) AS paidPaisa,
        i.id AS invoiceId, r.version AS version FROM repairs r LEFT JOIN payments p ON p.repair_id = r.id
        LEFT JOIN (SELECT payment_id, SUM(amount_paisa) AS reversed_paisa FROM payment_reversals GROUP BY payment_id) rv ON rv.payment_id = p.id
        LEFT JOIN invoices i ON i.repair_id = r.id WHERE r.id = ? GROUP BY r.id`,
      repairId,
    );
    if (!record) throw new Error('Repair record not found.');
    if (record.invoiceId) throw new Error('This repair already has an issued invoice; its billed total is locked.');
    if (amountPaisa < record.paidPaisa) throw new Error('Final cost cannot be less than payments already received.');
    await transaction.runAsync(
      `UPDATE repairs SET final_cost_paisa = ?, updated_at = ?, sync_state = 'local', version = version + 1 WHERE id = ?`,
      amountPaisa, timestamp(), repairId,
    );
    await enqueueSyncOperation(transaction, { entityType: 'repair', entityId: repairId, operation: 'upsert', baseVersion: record.version, payload: { repairId, amountPaisa } });
  });
}

const STATUS_TRANSITIONS: Record<RepairStatus, RepairStatus[]> = {
  received: ['diagnosing', 'awaiting_approval', 'waiting_for_parts', 'in_repair', 'cancelled'],
  diagnosing: ['awaiting_approval', 'waiting_for_parts', 'in_repair', 'ready', 'cancelled'],
  awaiting_approval: ['in_repair', 'waiting_for_parts', 'cancelled'],
  waiting_for_parts: ['in_repair', 'cancelled'],
  in_repair: ['waiting_for_parts', 'ready', 'cancelled'],
  ready: ['in_repair', 'delivered'],
  delivered: [],
  cancelled: [],
};

export async function changeRepairStatus(
  database: SQLiteDatabase,
  repairId: string,
  nextStatus: RepairStatus,
): Promise<void> {
  await withEncryptedExclusiveTransaction(database, async (transaction) => {
    const current = await transaction.getFirstAsync<{ status: RepairStatus; version: number }>(
      'SELECT status, version FROM repairs WHERE id = ?', repairId,
    );
    if (!current) throw new Error('Repair record not found.');
    if (current.status === nextStatus) return;
    if (!STATUS_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(`This repair cannot move from ${current.status.replaceAll('_', ' ')} to ${nextStatus.replaceAll('_', ' ')}.`);
    }
    const changedAt = timestamp();
    await transaction.runAsync(
      `UPDATE repairs SET status = ?, delivered_at = ?, updated_at = ?, sync_state = 'local', version = version + 1 WHERE id = ?`,
      nextStatus, nextStatus === 'delivered' ? changedAt : null, changedAt, repairId,
    );
    const historyId = Crypto.randomUUID();
    await transaction.runAsync(
      `INSERT INTO repair_status_history (id, repair_id, from_status, to_status, changed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      historyId, repairId, current.status, nextStatus, changedAt, changedAt,
    );
    await enqueueSyncOperation(transaction, { entityType: 'repair_status_history', entityId: historyId, operation: 'create_event', baseVersion: current.version, payload: { repairId, fromStatus: current.status, status: nextStatus, changedAt } });
  });
}

export async function getDashboardSummary(database: SQLiteDatabase): Promise<DashboardSummary> {
  const today = todayLocal();
  const row = await database.getFirstAsync<{
    receivedToday: number;
    inProgress: number;
    ready: number;
    overdue: number;
    paidTodayPaisa: number;
    outstandingPaisa: number;
  }>(
    `SELECT
       SUM(CASE WHEN date(r.received_at, 'localtime') = ? THEN 1 ELSE 0 END) AS receivedToday,
       SUM(CASE WHEN r.status IN ('received','diagnosing','awaiting_approval','waiting_for_parts','in_repair') THEN 1 ELSE 0 END) AS inProgress,
       SUM(CASE WHEN r.status = 'ready' THEN 1 ELSE 0 END) AS ready,
       SUM(CASE WHEN r.expected_delivery_date < ? AND r.status NOT IN ('delivered','cancelled') THEN 1 ELSE 0 END) AS overdue,
       (SELECT COALESCE(SUM(p.amount_paisa - COALESCE(rv.reversed_paisa, 0)), 0) FROM payments p
         LEFT JOIN (SELECT payment_id, SUM(amount_paisa) AS reversed_paisa FROM payment_reversals GROUP BY payment_id) rv ON rv.payment_id = p.id
         WHERE p.voided_at IS NULL AND date(p.paid_at, 'localtime') = ?) AS paidTodayPaisa,
       SUM(CASE WHEN r.final_cost_paisa IS NOT NULL THEN MAX(0, r.final_cost_paisa - COALESCE(paid.total_paid, 0)) ELSE 0 END) AS outstandingPaisa
     FROM repairs r
     LEFT JOIN (
       SELECT p.repair_id, SUM(p.amount_paisa - COALESCE(rv.reversed_paisa, 0)) AS total_paid FROM payments p
       LEFT JOIN (SELECT payment_id, SUM(amount_paisa) AS reversed_paisa FROM payment_reversals GROUP BY payment_id) rv ON rv.payment_id = p.id
       WHERE p.voided_at IS NULL GROUP BY p.repair_id
     ) paid ON paid.repair_id = r.id`,
    today,
    today,
    today,
  );

  return {
    receivedToday: row?.receivedToday ?? 0,
    inProgress: row?.inProgress ?? 0,
    ready: row?.ready ?? 0,
    overdue: row?.overdue ?? 0,
    paidTodayPaisa: row?.paidTodayPaisa ?? 0,
    outstandingPaisa: row?.outstandingPaisa ?? 0,
  };
}

export async function issueInvoice(database: SQLiteDatabase, repairId: string): Promise<InvoiceRecord> {
  let issuedInvoice: InvoiceRecord | null = null;
  await withEncryptedExclusiveTransaction(database, async (transaction) => {
  const existing = await transaction.getFirstAsync<{
    invoiceCode: string;
    issuedAt: string;
    customerName: string;
    customerPhone: string;
    receiptNumber: string;
    description: string;
    totalPaisa: number;
    paidPaisa: number;
    balancePaisa: number;
  }>(
    `SELECT invoice_code AS invoiceCode, issued_at AS issuedAt,
      customer_name_snapshot AS customerName, customer_phone_snapshot AS customerPhone,
      r.receipt_number AS receiptNumber, repair_description_snapshot AS description,
      total_paisa AS totalPaisa, paid_paisa AS paidPaisa, balance_paisa AS balancePaisa
     FROM invoices i JOIN repairs r ON r.id = i.repair_id WHERE i.repair_id = ?`,
    repairId,
  );
  if (existing) {
    issuedInvoice = existing;
    return;
  }

  const repair = await transaction.getFirstAsync<{
    customerName: string;
    customerPhone: string;
    receiptNumber: string;
    description: string;
    totalPaisa: number | null;
    paidPaisa: number;
  }>(
    `SELECT c.name AS customerName, c.phone AS customerPhone, r.receipt_number AS receiptNumber,
      r.brand || ' ' || r.model || ' — ' || r.reported_problem AS description,
      r.final_cost_paisa AS totalPaisa,
      COALESCE(SUM(CASE WHEN p.voided_at IS NULL THEN p.amount_paisa - COALESCE(rv.reversed_paisa, 0) ELSE 0 END), 0) AS paidPaisa
     FROM repairs r JOIN customers c ON c.id = r.customer_id
     LEFT JOIN payments p ON p.repair_id = r.id
     LEFT JOIN (SELECT payment_id, SUM(amount_paisa) AS reversed_paisa FROM payment_reversals GROUP BY payment_id) rv ON rv.payment_id = p.id
     WHERE r.id = ? GROUP BY r.id`,
    repairId,
  );
  if (!repair) throw new Error('Repair record not found.');
  if (repair.totalPaisa === null) throw new Error('Set the final repair cost before issuing an invoice.');
  if (repair.paidPaisa > repair.totalPaisa) throw new Error('Payments exceed the final cost. Review the payment records first.');

  const id = Crypto.randomUUID();
  const issuedAt = timestamp();
  const invoice: InvoiceRecord = {
    invoiceCode: `INV-${issuedAt.slice(0, 10).replace(/-/g, '')}-${id.replace(/-/g, '').toUpperCase()}`,
    issuedAt,
    customerName: repair.customerName,
    customerPhone: repair.customerPhone,
    receiptNumber: repair.receiptNumber,
    description: repair.description,
    totalPaisa: repair.totalPaisa,
    paidPaisa: repair.paidPaisa,
    balancePaisa: repair.totalPaisa - repair.paidPaisa,
  };

  await transaction.runAsync(
    `INSERT INTO invoices (
      id, invoice_code, repair_id, issued_at, customer_name_snapshot,
      customer_phone_snapshot, repair_description_snapshot, total_paisa,
      paid_paisa, balance_paisa, created_at, sync_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')`,
    id,
    invoice.invoiceCode,
    repairId,
    issuedAt,
    invoice.customerName,
    invoice.customerPhone,
    invoice.description,
    invoice.totalPaisa,
    invoice.paidPaisa,
    invoice.balancePaisa,
    issuedAt,
  );
  await enqueueSyncOperation(transaction, {
    entityType: 'invoice', entityId: id, operation: 'create_event', baseVersion: null,
    payload: { id, repairId, invoiceCode: invoice.invoiceCode, issuedAt, customerName: invoice.customerName, customerPhone: invoice.customerPhone, description: invoice.description, totalPaisa: invoice.totalPaisa, paidPaisa: invoice.paidPaisa, balancePaisa: invoice.balancePaisa },
  });
  issuedInvoice = invoice;
  });
  if (!issuedInvoice) throw new Error('Invoice could not be issued.');
  return issuedInvoice;
}

export async function listInvoices(database: SQLiteDatabase): Promise<InvoiceRecord[]> {
  return database.getAllAsync<InvoiceRecord>(
    `SELECT invoice_code AS invoiceCode, issued_at AS issuedAt,
      customer_name_snapshot AS customerName, customer_phone_snapshot AS customerPhone,
      r.receipt_number AS receiptNumber, repair_description_snapshot AS description,
      total_paisa AS totalPaisa, paid_paisa AS paidPaisa, balance_paisa AS balancePaisa
     FROM invoices i JOIN repairs r ON r.id = i.repair_id
     ORDER BY issued_at DESC`,
  );
}

/** Lists actual payment events for the selected local calendar month. */
export async function listPaymentsForMonth(database: SQLiteDatabase, month: string): Promise<MonthlyPaymentRecord[]> {
  if (!isValidMonth(month)) throw new Error('Choose a valid month first.');
  const monthStart = `${month}-01`;
  const monthEnd = `date(?, '+1 month')`;
  return database.getAllAsync<MonthlyPaymentRecord>(
    `SELECT p.id, p.amount_paisa AS amountPaisa, p.method, p.paid_at AS paidAt,
      p.note, p.transaction_reference AS transactionReference,
      r.receipt_number AS receiptNumber, c.name AS customerName,
      COALESCE(rv.reversed_paisa, 0) AS reversedPaisa, p.amount_paisa - COALESCE(rv.reversed_paisa, 0) AS netAmountPaisa
     FROM payments p JOIN repairs r ON r.id = p.repair_id JOIN customers c ON c.id = r.customer_id
     LEFT JOIN (SELECT payment_id, SUM(amount_paisa) AS reversed_paisa FROM payment_reversals GROUP BY payment_id) rv ON rv.payment_id = p.id
     WHERE p.voided_at IS NULL AND date(p.paid_at, 'localtime') >= date(?, 'localtime')
       AND date(p.paid_at, 'localtime') < date(${monthEnd}, 'localtime')
     UNION ALL
     SELECT rv.id, -rv.amount_paisa AS amountPaisa, 'reversal' AS method, rv.reversed_at AS paidAt,
       rv.reason AS note, NULL AS transactionReference, r.receipt_number AS receiptNumber, c.name AS customerName,
       0 AS reversedPaisa, -rv.amount_paisa AS netAmountPaisa
     FROM payment_reversals rv JOIN payments p ON p.id = rv.payment_id JOIN repairs r ON r.id = p.repair_id JOIN customers c ON c.id = r.customer_id
     WHERE date(rv.reversed_at, 'localtime') >= date(?, 'localtime') AND date(rv.reversed_at, 'localtime') < date(${monthEnd}, 'localtime')
     ORDER BY paidAt`,
    monthStart,
    monthStart,
    monthStart,
    monthStart,
  );
}

function isValidMonth(month: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return false;
  return Number(month.slice(0, 4)) > 0;
}
