export type RepairStatus =
  | 'received'
  | 'diagnosing'
  | 'awaiting_approval'
  | 'waiting_for_parts'
  | 'in_repair'
  | 'ready'
  | 'delivered'
  | 'cancelled';

export type RepairListItem = {
  id: string;
  receiptNumber: string;
  customerName: string;
  customerPhone: string;
  brand: string;
  model: string;
  status: RepairStatus;
  receivedAt: string;
  finalCostPaisa: number | null;
  estimatedCostPaisa: number | null;
  paidPaisa: number;
  balancePaisa: number | null;
};

export type NewRepairInput = {
  customerName: string;
  customerPhone: string;
  brand: string;
  model: string;
  reportedProblem: string;
  expectedDeliveryDate?: string;
  estimatedCostPaisa?: number;
  initialPaymentPaisa?: number;
};

export type DashboardSummary = {
  receivedToday: number;
  inProgress: number;
  ready: number;
  overdue: number;
  paidTodayPaisa: number;
  outstandingPaisa: number;
};

export type InvoiceRecord = {
  invoiceCode: string;
  issuedAt: string;
  customerName: string;
  customerPhone: string;
  receiptNumber: string;
  description: string;
  totalPaisa: number;
  paidPaisa: number;
  balancePaisa: number;
};

export type RepairDetails = RepairListItem & {
  customerId: string;
  reportedProblem: string;
  expectedDeliveryDate: string | null;
  deliveredAt: string | null;
  estimatedCostPaisa: number | null;
  internalNotes: string | null;
};

export type PaymentRecord = {
  id: string;
  amountPaisa: number;
  method: 'cash' | 'bank_transfer' | 'other';
  paidAt: string;
  note: string | null;
  transactionReference: string | null;
  reversedPaisa?: number;
  netAmountPaisa?: number;
  reversals?: PaymentReversalRecord[];
};

export type PaymentReversalRecord = { id: string; amountPaisa: number; reason: string; reversedAt: string };

export type MonthlyPaymentRecord = PaymentRecord & {
  receiptNumber: string;
  customerName: string;
  method: PaymentRecord['method'] | 'reversal';
};
