import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNoOverpayment,
  calculateBalance,
  calculateNetPaid,
  isAllowedTransition,
  newRepairSchema,
  ownerCredentialsSchema,
  syncCustomerPayloadSchema,
  syncInvoicePayloadSchema,
  syncPaymentPayloadSchema,
  syncPaymentReversalPayloadSchema,
  syncPushSchema,
} from '../src/domain.ts';

test('balance reconciles partial payments and unset totals', () => {
  assert.equal(calculateBalance(500_000, [150_000, 50_000]), 300_000);
  assert.equal(calculateBalance(null, [10_000]), null);
  assert.equal(calculateBalance(100, [40, 60]), 0);
});

test('overpayment guard rejects a payment above the remaining amount', () => {
  assert.doesNotThrow(() => assertNoOverpayment(500_000, 200_000, 300_000));
  assert.throws(() => assertNoOverpayment(500_000, 200_000, 300_001), /outstanding balance/);
});

test('status transition graph blocks terminal and skipped transitions', () => {
  assert.equal(isAllowedTransition('received', 'diagnosing'), true);
  assert.equal(isAllowedTransition('received', 'delivered'), false);
  assert.equal(isAllowedTransition('delivered', 'in_repair'), false);
});

test('reversal math preserves the original payment and bounds refunds', () => {
  assert.equal(calculateNetPaid(50_000, 12_500), 37_500);
  assert.throws(() => calculateNetPaid(50_000, 50_001), /within the original/);
});

test('credential schema normalizes email and rejects weak passwords', () => {
  assert.equal(ownerCredentialsSchema.parse({ email: 'OWNER@EXAMPLE.COM', password: 'long-enough-passphrase' }).email, 'owner@example.com');
  assert.equal(ownerCredentialsSchema.safeParse({ email: 'owner@example.com', password: 'short' }).success, false);
});

test('repair schema requires exactly one customer reference and a real date', () => {
  const base = { brand: 'Apple', model: 'iPhone', reportedProblem: 'Broken screen', expectedDeliveryDate: '2026-02-28' };
  assert.equal(newRepairSchema.safeParse({ ...base, customerId: 'ce99ca04-d679-4e56-92b6-2af8cb7eb5ad' }).success, true);
  assert.equal(newRepairSchema.safeParse({ ...base, customerId: 'ce99ca04-d679-4e56-92b6-2af8cb7eb5ad', customer: { name: 'A', phone: '12345' } }).success, false);
  assert.equal(newRepairSchema.safeParse({ ...base, customerId: 'ce99ca04-d679-4e56-92b6-2af8cb7eb5ad', expectedDeliveryDate: '2026-02-30' }).success, false);
});

test('sync push validates stable operation identity, versions, and bounded event payloads', () => {
  const ownerId = 'ce99ca04-d679-4e56-92b6-2af8cb7eb5ad';
  const paymentId = 'ab580a20-41c1-4c22-a3a2-181b7b463f1a';
  const repairId = '2d6b5291-ddfa-4e4a-83fa-f3bb5738f1e7';
  const operationId = '64ff6d7e-cd0b-4af8-b88d-facc29101c83';
  const timestamp = '2026-10-11T10:00:00.000Z';
  const payment = { id: paymentId, repairId, amountPaisa: 120_000, method: 'cash', idempotencyKey: '12746251-5e68-44b2-8fc7-75cd719d2911', paidAt: timestamp };
  assert.equal(syncPaymentPayloadSchema.safeParse(payment).success, true);
  assert.equal(syncPaymentPayloadSchema.safeParse({ ...payment, amountPaisa: Number.MAX_SAFE_INTEGER + 1 }).success, false);
  assert.equal(syncPushSchema.safeParse({ clientId: ownerId, operations: [{ operationId, entityType: 'payment', entityId: paymentId, operation: 'create_event', baseVersion: null, payload: payment, createdAt: timestamp }] }).success, true);
  assert.equal(syncPushSchema.safeParse({ clientId: ownerId, operations: Array.from({ length: 101 }, (_, index) => ({ operationId, entityType: 'payment', entityId: paymentId, operation: 'create_event', baseVersion: null, payload: payment, createdAt: timestamp, index })) }).success, false);
});

test('sync customer and invoice snapshots reject malformed or contradictory data', () => {
  assert.equal(syncCustomerPayloadSchema.safeParse({ id: 'ce99ca04-d679-4e56-92b6-2af8cb7eb5ad', name: 'Owner', phone: '+923001234567' }).success, true);
  assert.equal(syncCustomerPayloadSchema.safeParse({ id: 'invalid', name: 'Owner', phone: '+923001234567' }).success, false);
  const invoice = { id: 'ab580a20-41c1-4c22-a3a2-181b7b463f1a', repairId: '2d6b5291-ddfa-4e4a-83fa-f3bb5738e1f7', invoiceCode: 'INV-20261011-12345', issuedAt: '2026-10-11T10:00:00.000Z', customerName: 'Owner', customerPhone: '+923001234567', description: 'Screen repair', totalPaisa: 120_000, paidPaisa: 20_000, balancePaisa: 100_000 };
  assert.equal(syncInvoicePayloadSchema.safeParse(invoice).success, true);
  assert.equal(syncInvoicePayloadSchema.safeParse({ ...invoice, balancePaisa: -Number.MAX_SAFE_INTEGER - 1 }).success, false);
});

test('sync payment reversal events retain a valid idempotency key and audit reason', () => {
  const reversal = { id: 'ab580a20-41c1-4c22-a3a2-181b7b463f1a', paymentId: '12746251-5e68-44b2-8fc7-75cd719d2911', repairId: '2d6b5291-ddfa-4e4a-83fa-f3bb5738e1f7', amountPaisa: 5_000, reason: 'Customer refund', idempotencyKey: '64ff6d7e-cd0b-4af8-b88d-facc29101c83', reversedAt: '2026-10-11T10:00:00.000Z' };
  assert.equal(syncPaymentReversalPayloadSchema.safeParse(reversal).success, true);
  assert.equal(syncPaymentReversalPayloadSchema.safeParse({ ...reversal, reason: 'x' }).success, false);
});
