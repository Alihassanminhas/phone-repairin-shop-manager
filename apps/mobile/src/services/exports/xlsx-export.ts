import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx';
import type { SQLiteDatabase } from 'expo-sqlite';

import { listInvoices, listPaymentsForMonth } from '@/database/repair-repository';
import type { InvoiceRecord } from '@/features/repairs/types';

function spreadsheetText(value: string): string {
  const safe = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
  return /^[\s]*[=+\-@]/.test(safe) ? `'${safe}` : safe;
}

function amountRupees(paisa: number): number {
  return Number((paisa / 100).toFixed(2));
}

async function shareWorkbook(workbook: XLSX.WorkBook, fileName: string): Promise<void> {
  const base64 = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' });
  const exportDirectory = `${FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? ''}exports/`;
  await FileSystem.makeDirectoryAsync(exportDirectory, { intermediates: true });
  const uri = `${exportDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
  if (!(await Sharing.isAvailableAsync())) throw new Error('File sharing is not available on this device.');
  await Sharing.shareAsync(uri, {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    UTI: 'org.openxmlformats.spreadsheetml.sheet',
    dialogTitle: fileName,
  });
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

function invoiceWorkbook(invoice: InvoiceRecord): XLSX.WorkBook {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['MOBILE REPAIR SHOP — INVOICE'],
    ['Invoice code', spreadsheetText(invoice.invoiceCode)],
    ['Issued', new Date(invoice.issuedAt).toLocaleString()],
    ['Repair receipt', spreadsheetText(invoice.receiptNumber)],
    ['Customer', spreadsheetText(invoice.customerName)],
    ['Phone', spreadsheetText(invoice.customerPhone)],
    ['Repair description', spreadsheetText(invoice.description)],
    ['Repair total (PKR)', amountRupees(invoice.totalPaisa)],
    ['Payments received (PKR)', amountRupees(invoice.paidPaisa)],
    ['Balance due (PKR)', amountRupees(invoice.balancePaisa)],
  ]);
  sheet['!cols'] = [{ wch: 26 }, { wch: 54 }];
  for (const ref of ['B8', 'B9', 'B10']) {
    if (sheet[ref]) (sheet[ref] as XLSX.CellObject).z = '"Rs. "#,##0.00';
  }
  return { SheetNames: ['Invoice'], Sheets: { Invoice: sheet } };
}

export async function exportInvoiceXlsx(invoice: InvoiceRecord): Promise<void> {
  const date = invoice.issuedAt.slice(0, 10);
  await shareWorkbook(invoiceWorkbook(invoice), `invoice-${safeFilePart(invoice.invoiceCode)}-${date}.xlsx`);
}

export async function exportMonthlySalesXlsx(database: SQLiteDatabase, month: string): Promise<void> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1) throw new Error('Choose a valid month first.');
  const invoices = (await listInvoices(database)).filter((invoice) => invoice.issuedAt.slice(0, 7) === month);
  const payments = await listPaymentsForMonth(database, month);
  if (invoices.length === 0 && payments.length === 0) throw new Error('There are no invoices or payments for this month yet.');

  const rows: (string | number)[][] = [
    ['Invoice code', 'Issued at', 'Repair receipt', 'Customer', 'Phone', 'Description', 'Repair total (PKR)', 'Paid (PKR)', 'Balance (PKR)'],
    ...invoices.map((invoice) => [
      spreadsheetText(invoice.invoiceCode),
      new Date(invoice.issuedAt).toLocaleString(),
      spreadsheetText(invoice.receiptNumber),
      spreadsheetText(invoice.customerName),
      spreadsheetText(invoice.customerPhone),
      spreadsheetText(invoice.description),
      amountRupees(invoice.totalPaisa),
      amountRupees(invoice.paidPaisa),
      amountRupees(invoice.balancePaisa),
    ]),
    ['TOTAL', '', '', '', '', '', '', '', ''],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const lastInvoiceRow = invoices.length + 1;
  const totalRow = lastInvoiceRow + 1;
  for (const column of ['G', 'H', 'I']) {
    const cell = `${column}${totalRow}`;
    sheet[cell] = { t: 'n', f: `SUM(${column}2:${column}${lastInvoiceRow})`, z: '"Rs. "#,##0.00' };
  }
  sheet['!autofilter'] = { ref: `A1:I${lastInvoiceRow}` };
  sheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
  sheet['!cols'] = [{ wch: 25 }, { wch: 22 }, { wch: 23 }, { wch: 24 }, { wch: 17 }, { wch: 42 }, { wch: 22 }, { wch: 18 }, { wch: 20 }];
  const paymentRows: (string | number)[][] = [
    ['Payment date', 'Receipt', 'Customer', 'Method', 'Reference', 'Amount received (PKR)'],
    ...payments.map((payment) => [
      new Date(payment.paidAt).toLocaleString(),
      spreadsheetText(payment.receiptNumber),
      spreadsheetText(payment.customerName),
      spreadsheetText(payment.method.replaceAll('_', ' ')),
      spreadsheetText(payment.transactionReference ?? ''),
      amountRupees(payment.amountPaisa),
    ]),
    ['TOTAL', '', '', '', '', ''],
  ];
  const paymentSheet = XLSX.utils.aoa_to_sheet(paymentRows);
  const paymentTotalRow = payments.length + 2;
  paymentSheet[`F${paymentTotalRow}`] = { t: 'n', f: `SUM(F2:F${payments.length + 1})`, z: '"Rs. "#,##0.00' };
  paymentSheet['!autofilter'] = { ref: `A1:F${payments.length + 1}` };
  paymentSheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
  paymentSheet['!cols'] = [{ wch: 22 }, { wch: 22 }, { wch: 24 }, { wch: 20 }, { wch: 24 }, { wch: 26 }];

  const summaryRows = [
    ['Monthly sales summary', month],
    ['Invoices issued', invoices.length],
    ['Repair totals (PKR)', 0],
    ['Invoice payment snapshot at issue (PKR)', 0],
    ['Payments received this month (PKR)', 0],
    ['Balances due at invoice issue (PKR)', 0],
  ];
  const summary = XLSX.utils.aoa_to_sheet(summaryRows);
  summary['B3'] = { t: 'n', f: `SUM('Sales'!G2:G${lastInvoiceRow})`, z: '"Rs. "#,##0.00' };
  summary['B4'] = { t: 'n', f: `SUM('Sales'!H2:H${lastInvoiceRow})`, z: '"Rs. "#,##0.00' };
  summary['B5'] = { t: 'n', f: `SUM('Payments'!F2:F${payments.length + 1})`, z: '"Rs. "#,##0.00' };
  summary['B6'] = { t: 'n', f: `SUM('Sales'!I2:I${lastInvoiceRow})`, z: '"Rs. "#,##0.00' };
  const workbook = { SheetNames: ['Sales', 'Payments', 'Summary'], Sheets: { Sales: sheet, Payments: paymentSheet, Summary: summary } };
  await shareWorkbook(workbook, `sales-${month}.xlsx`);
}
