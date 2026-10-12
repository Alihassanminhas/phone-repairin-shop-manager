import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Fonts } from '@/constants/theme';
import { listInvoices, listPaymentsForMonth } from '@/database/repair-repository';
import type { InvoiceRecord, MonthlyPaymentRecord } from '@/features/repairs/types';
import { formatPkr } from '@/lib/money';
import { exportInvoiceXlsx, exportMonthlySalesXlsx } from '@/services/exports/xlsx-export';

function currentLocalMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}`;
}

export default function RecordsScreen() {
  const database = useSQLiteContext();
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [monthlyPayments, setMonthlyPayments] = useState<MonthlyPaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [month, setMonth] = useState(currentLocalMonth);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [nextInvoices, nextPayments] = await Promise.all([listInvoices(database), listPaymentsForMonth(database, month)]);
      setInvoices(nextInvoices);
      setMonthlyPayments(nextPayments);
    } catch {
      setError('Your invoice history could not be loaded from this phone.');
    } finally {
      setLoading(false);
    }
  }, [database, month]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const monthlyInvoices = useMemo(() => invoices.filter((invoice) => invoice.issuedAt.slice(0, 7) === month), [invoices, month]);
  const monthlyTotal = monthlyInvoices.reduce((total, invoice) => total + invoice.totalPaisa, 0);
  const monthlyPaid = monthlyPayments.reduce((total, payment) => total + payment.amountPaisa, 0);

  async function runExport(exportAction: () => Promise<void>): Promise<void> {
    if (exporting) return;
    setExporting(true);
    try {
      await exportAction();
    } catch (exportError) {
      Alert.alert('Excel export did not finish', exportError instanceof Error ? exportError.message : 'Please try again.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>Sales records</Text>
        <Text style={styles.subtitle}>Invoices stay saved in the app. Export a copy whenever you need it.</Text>
        <View style={styles.monthCard}>
          <View style={styles.monthHead}><View><Text style={styles.label}>Monthly sales</Text><Text style={styles.monthTitle}>{month}</Text></View>
            <View style={styles.monthButtons}>
              <Pressable accessibilityLabel="Previous month" onPress={() => changeMonth(-1, month, setMonth)} style={styles.monthButton}><Text style={styles.monthButtonText}>‹</Text></Pressable>
              <Pressable accessibilityLabel="Next month" onPress={() => changeMonth(1, month, setMonth)} style={styles.monthButton}><Text style={styles.monthButtonText}>›</Text></Pressable>
            </View>
          </View>
          <View style={styles.summaryLine}><Text style={styles.label}>Invoices</Text><Text style={styles.summaryValue}>{monthlyInvoices.length}</Text></View>
          <View style={styles.summaryLine}><Text style={styles.label}>Billed</Text><Text style={styles.summaryValue}>{formatPkr(monthlyTotal)}</Text></View>
          <View style={styles.summaryLine}><Text style={styles.label}>Received</Text><Text style={styles.summaryValue}>{formatPkr(monthlyPaid)}</Text></View>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: exporting }} disabled={exporting} onPress={() => { void runExport(() => exportMonthlySalesXlsx(database, month)); }} style={[styles.exportButton, exporting && styles.disabled]}>
            <Text style={styles.exportText}>{exporting ? 'Preparing Excel…' : `Download ${month} Excel sheet`}</Text>
          </Pressable>
        </View>

        <View style={styles.listHeading}><Text accessibilityRole="header" style={styles.sectionTitle}>Issued invoices</Text><Text style={styles.savedLabel}>Saved on this phone</Text></View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {loading ? <Text style={styles.emptyText}>Loading saved invoices…</Text> : null}
        {!loading && invoices.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>No invoices yet</Text><Text style={styles.emptyText}>Set a final repair cost, then issue an invoice from repair details. It will appear here even while offline.</Text></View> : null}
        {invoices.map((invoice) => (
          <View key={invoice.invoiceCode} style={styles.invoiceRow}>
            <View style={styles.invoiceTop}><Text style={styles.invoiceCode}>{invoice.invoiceCode}</Text><Text style={styles.total}>{formatPkr(invoice.totalPaisa)}</Text></View>
            <Text style={styles.customer}>{invoice.customerName} · {invoice.receiptNumber}</Text>
            <View style={styles.invoiceBottom}><Text style={styles.invoiceDate}>{new Date(invoice.issuedAt).toLocaleDateString()}</Text><Text style={styles.balance}>{invoice.balancePaisa > 0 ? `Due ${formatPkr(invoice.balancePaisa)}` : 'Fully paid'}</Text></View>
            <Pressable accessibilityRole="button" onPress={() => { void runExport(() => exportInvoiceXlsx(invoice)); }} style={styles.downloadLink}><Text style={styles.downloadText}>Download invoice Excel</Text></Pressable>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function changeMonth(delta: number, currentMonth: string, setMonth: (month: string) => void): void {
  const [year, month] = currentMonth.split('-').map(Number);
  const next = new Date(year, month - 1 + delta, 1);
  setMonth(`${next.getFullYear()}-${`${next.getMonth() + 1}`.padStart(2, '0')}`);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.light.background }, content: { padding: 16, paddingBottom: 30 },
  title: { color: Colors.light.text, fontSize: 25, lineHeight: 32, fontWeight: '700', fontFamily: Fonts.sansBold }, subtitle: { color: Colors.light.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 4, marginBottom: 16, fontFamily: Fonts.sans },
  monthCard: { backgroundColor: Colors.light.surface, borderColor: Colors.light.border, borderWidth: 1, borderRadius: 14, padding: 15, marginBottom: 22 }, monthHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  label: { color: Colors.light.textSecondary, fontSize: 12 }, monthTitle: { color: Colors.light.text, fontSize: 18, fontWeight: '700', marginTop: 3 }, monthButtons: { flexDirection: 'row', gap: 8 }, monthButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.light.background, borderColor: Colors.light.border, borderWidth: 1, borderRadius: 10 }, monthButtonText: { color: Colors.light.primary, fontSize: 24, lineHeight: 28 },
  summaryLine: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderTopColor: Colors.light.border, borderTopWidth: StyleSheet.hairlineWidth }, summaryValue: { color: Colors.light.text, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  exportButton: { minHeight: 49, backgroundColor: Colors.light.primary, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginTop: 12, paddingHorizontal: 10 }, exportText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 }, disabled: { opacity: 0.5 },
  listHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 11 }, sectionTitle: { color: Colors.light.text, fontSize: 17, fontWeight: '700' }, savedLabel: { color: Colors.light.success, fontSize: 11, fontWeight: '600' },
  invoiceRow: { padding: 14, backgroundColor: Colors.light.surface, borderRadius: 13, borderColor: Colors.light.border, borderWidth: 1, marginBottom: 9 }, invoiceTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }, invoiceCode: { color: Colors.light.primary, fontSize: 12, fontWeight: '700', fontFamily: Fonts.mono }, total: { color: Colors.light.text, fontSize: 14, fontWeight: '700', fontFamily: Fonts.sansBold }, customer: { color: Colors.light.text, fontSize: 13, marginTop: 8 }, invoiceBottom: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }, invoiceDate: { color: Colors.light.textSecondary, fontSize: 11 }, balance: { color: Colors.light.warning, fontSize: 11, fontWeight: '700' }, downloadLink: { alignSelf: 'flex-start', paddingTop: 11, minHeight: 40, justifyContent: 'center' }, downloadText: { color: Colors.light.primary, fontSize: 12, fontWeight: '700' },
  empty: { padding: 16, borderRadius: 13, borderColor: Colors.light.border, borderWidth: 1, backgroundColor: Colors.light.surface }, emptyTitle: { color: Colors.light.text, fontSize: 14, fontWeight: '700', marginBottom: 5 }, emptyText: { color: Colors.light.textSecondary, fontSize: 12, lineHeight: 19 }, error: { color: Colors.light.error, padding: 12 },
});
