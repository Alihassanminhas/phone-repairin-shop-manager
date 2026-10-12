import { z } from 'zod';

export const repairStatuses = [
  'received', 'diagnosing', 'awaiting_approval', 'waiting_for_parts', 'in_repair', 'ready', 'delivered', 'cancelled',
] as const;

export type RepairStatus = (typeof repairStatuses)[number];

export const paymentMethods = ['cash', 'bank_transfer', 'other'] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export const statusTransitions: Readonly<Record<RepairStatus, readonly RepairStatus[]>> = {
  received: ['diagnosing', 'awaiting_approval', 'waiting_for_parts', 'in_repair', 'cancelled'],
  diagnosing: ['awaiting_approval', 'waiting_for_parts', 'in_repair', 'ready', 'cancelled'],
  awaiting_approval: ['in_repair', 'waiting_for_parts', 'cancelled'],
  waiting_for_parts: ['in_repair', 'cancelled'],
  in_repair: ['waiting_for_parts', 'ready', 'cancelled'],
  ready: ['in_repair', 'delivered'],
  delivered: [],
  cancelled: [],
};

const moneyPaisa = z.number().int().safe().nonnegative();
const phoneSchema = z.string().trim().min(5).max(32).refine((value) => (value.match(/\d/g)?.length ?? 0) >= 5, 'Enter a valid phone number.');
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day;
}, 'Enter a real calendar date.');

export const ownerCredentialsSchema = z.object({
  email: z.email().trim().toLowerCase().max(254),
  password: z.string().min(12).max(128),
}).strict();

export const bootstrapSchema = ownerCredentialsSchema.extend({
  bootstrapCode: z.string().min(32).max(256),
  shopName: z.string().trim().min(1).max(120),
}).strict();

export const customerSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  phone: phoneSchema,
  alternatePhone: phoneSchema.optional(),
  address: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2_000).optional(),
}).strict();

export const newRepairSchema = z.object({
  id: z.string().uuid().optional(),
  receiptNumber: z.string().trim().min(8).max(48).optional(),
  customerId: z.string().uuid().optional(),
  customer: customerSchema.optional(),
  brand: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  imei: z.string().trim().regex(/^\d{14,16}$/).optional(),
  reportedProblem: z.string().trim().min(1).max(2_000),
  inspectionNotes: z.string().trim().max(4_000).optional(),
  accessories: z.string().trim().max(500).optional(),
  expectedDeliveryDate: dateOnlySchema.optional(),
  estimatedCostPaisa: moneyPaisa.optional(),
}).strict().refine((value) => Boolean(value.customerId) !== Boolean(value.customer), {
  message: 'Provide either an existing customerId or a new customer, but not both.',
});

export const paymentSchema = z.object({
  amountPaisa: moneyPaisa.min(1),
  method: z.enum(paymentMethods),
  transactionReference: z.string().trim().max(160).optional(),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().uuid(),
}).strict();

export const paymentReversalSchema = z.object({
  amountPaisa: moneyPaisa.min(1),
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().uuid(),
}).strict();

export const updateStatusSchema = z.object({
  status: z.enum(repairStatuses),
  note: z.string().trim().max(500).optional(),
}).strict();

export const setFinalCostSchema = z.object({
  amountPaisa: moneyPaisa,
}).strict();

export const syncPushSchema = z.object({
  clientId: z.string().uuid(),
  operations: z.array(z.object({
    operationId: z.string().uuid(),
    entityType: z.enum(['customer', 'repair', 'payment', 'payment_reversal', 'invoice', 'repair_status_history']),
    entityId: z.string().uuid(),
    operation: z.enum(['upsert', 'create_event', 'archive']),
    baseVersion: z.number().int().nonnegative().nullable(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime({ offset: true }),
  }).strict()).max(100),
}).strict();

export const syncPullSchema = z.object({
  cursor: z.string().max(3000).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(250),
}).strict();

export const syncCustomerPayloadSchema = customerSchema.extend({ updatedAt: z.string().datetime({ offset: true }).optional() }).strict();
export const syncRepairPayloadSchema = z.object({
  id: z.string().uuid(), receiptNumber: z.string().min(8).max(48), customerId: z.string().uuid(),
  brand: z.string().min(1).max(80), model: z.string().min(1).max(120), imei: z.string().max(16).optional(),
  reportedProblem: z.string().min(1).max(2_000), inspectionNotes: z.string().max(4_000).optional(), accessories: z.string().max(500).optional(),
  receivedAt: z.string().datetime({ offset: true }), expectedDeliveryDate: dateOnlySchema.nullable().optional(),
  estimatedCostPaisa: moneyPaisa.nullable().optional(), internalNotes: z.string().max(4_000).nullable().optional(),
}).strict();
export const syncPaymentPayloadSchema = paymentSchema.extend({ id: z.string().uuid(), repairId: z.string().uuid(), paidAt: z.string().datetime({ offset: true }) }).strict();
export const syncPaymentReversalPayloadSchema = paymentReversalSchema.extend({ id: z.string().uuid(), paymentId: z.string().uuid(), repairId: z.string().uuid(), reversedAt: z.string().datetime({ offset: true }) }).strict();
export const syncStatusPayloadSchema = z.object({ repairId: z.string().uuid(), fromStatus: z.enum(repairStatuses).nullable(), status: z.enum(repairStatuses), changedAt: z.string().datetime({ offset: true }), note: z.string().max(500).optional() }).strict();
export const syncFinalCostPayloadSchema = z.object({ repairId: z.string().uuid(), amountPaisa: moneyPaisa }).strict();
export const syncInvoicePayloadSchema = z.object({
  id: z.string().uuid(), repairId: z.string().uuid(), invoiceCode: z.string().min(8).max(48), issuedAt: z.string().datetime({ offset: true }),
  customerName: z.string().min(1).max(120), customerPhone: phoneSchema, description: z.string().max(2400),
  totalPaisa: moneyPaisa, paidPaisa: moneyPaisa, balancePaisa: z.number().int().safe(),
}).strict();

export type CustomerInput = z.infer<typeof customerSchema>;
export type NewRepairInput = z.infer<typeof newRepairSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
export type PaymentReversalInput = z.infer<typeof paymentReversalSchema>;
export type BootstrapInput = z.infer<typeof bootstrapSchema>;

export function isAllowedTransition(from: RepairStatus, to: RepairStatus): boolean {
  return statusTransitions[from].includes(to);
}

/** Returns the current amount due. A null total means the final bill is not set yet. */
export function calculateBalance(totalPaisa: number | null, paymentAmountsPaisa: readonly number[]): number | null {
  if (totalPaisa === null) return null;
  if (!Number.isSafeInteger(totalPaisa) || totalPaisa < 0) throw new Error('Total must be a non-negative integer amount in paisa.');
  const paid = paymentAmountsPaisa.reduce((sum, amount) => {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Payments must be non-negative integer amounts in paisa.');
    const next = sum + amount;
    if (!Number.isSafeInteger(next)) throw new Error('Payment total exceeds the supported amount.');
    return next;
  }, 0);
  return totalPaisa - paid;
}

export function assertNoOverpayment(totalPaisa: number, paidPaisa: number, nextPaymentPaisa: number): void {
  if (![totalPaisa, paidPaisa, nextPaymentPaisa].every(Number.isSafeInteger) || totalPaisa < 0 || paidPaisa < 0 || nextPaymentPaisa <= 0) {
    throw new Error('Payment amounts must be valid whole paisa values.');
  }
  if (paidPaisa + nextPaymentPaisa > totalPaisa) throw new Error('Payment is greater than the outstanding balance.');
}

export function calculateNetPaid(paymentPaisa: number, reversedPaisa: number): number {
  if (!Number.isSafeInteger(paymentPaisa) || !Number.isSafeInteger(reversedPaisa) || paymentPaisa < 0 || reversedPaisa < 0 || reversedPaisa > paymentPaisa) {
    throw new Error('Reversal amount must be within the original payment.');
  }
  return paymentPaisa - reversedPaisa;
}
