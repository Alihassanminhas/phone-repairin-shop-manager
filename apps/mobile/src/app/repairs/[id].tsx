import { Link, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Fonts } from '@/constants/theme';
import { changeRepairStatus, getPayments, getRepairDetails, issueInvoice, setFinalCost } from '@/database/repair-repository';
import type { PaymentRecord, RepairDetails, RepairStatus } from '@/features/repairs/types';
import { formatPkr, parsePaisa } from '@/lib/money';

const NEXT_STATUS: Partial<Record<RepairStatus, RepairStatus>> = {
  received: 'diagnosing',
  diagnosing: 'in_repair',
  awaiting_approval: 'in_repair',
  waiting_for_parts: 'in_repair',
  in_repair: 'ready',
  ready: 'delivered',
};

export default function RepairDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const database = useSQLiteContext();
  const [repair, setRepair] = useState<RepairDetails | null>(null);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [finalCostInput, setFinalCostInput] = useState('');
  const [savingCost, setSavingCost] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [nextRepair, nextPayments] = await Promise.all([getRepairDetails(database, id), getPayments(database, id)]);
      setRepair(nextRepair);
      setFinalCostInput(nextRepair?.finalCostPaisa === null || nextRepair?.finalCostPaisa === undefined ? '' : (nextRepair.finalCostPaisa / 100).toFixed(2));
      setPayments(nextPayments);
    } catch {
      Alert.alert('Could not load repair', 'Saved details are still on this phone. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [database, id]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function advanceStatus(): Promise<void> {
    if (!repair) return;
    const nextStatus = NEXT_STATUS[repair.status];
    if (!nextStatus) return;
    const isDelivery = nextStatus === 'delivered';
    Alert.alert(isDelivery ? 'Confirm delivery?' : 'Update repair status?', isDelivery ? 'This records today as the actual delivery date. Payment status will remain separate.' : `Move this repair to ${nextStatus.replaceAll('_', ' ')}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: isDelivery ? 'Confirm delivery' : 'Update status', onPress: () => {
        void changeRepairStatus(database, repair.id, nextStatus)
          .then(load)
          .catch((error: unknown) => Alert.alert('Could not update status', error instanceof Error ? error.message : 'Please try again.'));
      } },
    ]);
  }

  async function createInvoice(): Promise<void> {
    if (!repair) return;
    try {
      const invoice = await issueInvoice(database, repair.id);
      Alert.alert('Invoice saved', `${invoice.invoiceCode} is now in Records and saved on this phone.`, [{ text: 'OK' }]);
      await load();
    } catch (error) {
      Alert.alert('Could not issue invoice', error instanceof Error ? error.message : 'Please try again.');
    }
  }

  async function saveFinalCost(): Promise<void> {
    if (!repair || savingCost) return;
    const amountPaisa = parsePaisa(finalCostInput);
    if (amountPaisa === null) {
      Alert.alert('Check final cost', 'Enter a valid amount with up to two decimal places.');
      return;
    }
    setSavingCost(true);
    try {
      await setFinalCost(database, repair.id, amountPaisa);
      await load();
    } catch (error) {
      Alert.alert('Could not save final cost', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setSavingCost(false);
    }
  }

  if (loading) return <View style={styles.center}><Text style={styles.muted}>Loading saved repair…</Text></View>;
  if (!repair) return <View style={styles.center}><Text style={styles.title}>Repair not found</Text><Text style={styles.muted}>It may have been removed from this phone.</Text></View>;

  const total = repair.finalCostPaisa ?? repair.estimatedCostPaisa;
  const nextStatus = NEXT_STATUS[repair.status];
  return (
    <SafeAreaView edges={['bottom']} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.receipt}>{repair.receiptNumber}</Text>
        <View style={styles.heroRow}><Text style={styles.title}>{repair.customerName}</Text><Text style={styles.status}>{repair.status.replaceAll('_', ' ')}</Text></View>
        <Text style={styles.model}>{repair.brand} {repair.model}</Text>

        <View style={styles.moneyCard}>
          <Text style={styles.label}>{repair.finalCostPaisa === null ? 'Estimate' : 'Repair total'}</Text>
          <Text style={styles.total}>{total === null ? 'Not set' : formatPkr(total)}</Text>
          <View style={styles.moneyLine}><Text style={styles.label}>Paid</Text><Text style={styles.money}>{formatPkr(repair.paidPaisa)}</Text></View>
          <View style={styles.moneyLine}><Text style={styles.balanceLabel}>{repair.balancePaisa !== null && repair.balancePaisa <= 0 ? 'Payment status' : 'Remaining balance'}</Text><Text style={styles.balance}>{repair.balancePaisa === null ? 'Final cost pending' : repair.balancePaisa <= 0 ? 'Fully paid' : formatPkr(repair.balancePaisa)}</Text></View>
          {repair.status === 'ready' && repair.balancePaisa !== null && repair.balancePaisa > 0 ? <Text style={styles.notice}>Ready for pickup · balance still due</Text> : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Reported problem</Text>
          <Text style={styles.body}>{repair.reportedProblem}</Text>
          <Text style={styles.meta}>Customer phone  {repair.customerPhone}</Text>
          <Text style={styles.meta}>Received  {new Date(repair.receivedAt).toLocaleString()}</Text>
          {repair.expectedDeliveryDate ? <Text style={styles.meta}>Expected  {repair.expectedDeliveryDate}</Text> : null}
          {repair.deliveredAt ? <Text style={styles.meta}>Delivered  {new Date(repair.deliveredAt).toLocaleString()}</Text> : null}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Payment history</Text><Link href={{ pathname: '/payments/new', params: { repairId: repair.id } }} asChild><Pressable accessibilityRole="button"><Text style={styles.link}>Record payment</Text></Pressable></Link></View>
          {payments.length === 0 ? <Text style={styles.muted}>No payments recorded yet.</Text> : payments.map((payment) => <View key={payment.id} style={styles.paymentRow}><View style={styles.paymentDetails}><Text style={styles.paymentMethod}>{payment.method.replace('_', ' ')}</Text><Text style={styles.meta}>{new Date(payment.paidAt).toLocaleString()}</Text><Text style={styles.meta}>Received {formatPkr(payment.amountPaisa)}</Text>{payment.reversals?.map((reversal) => <Text key={reversal.id} style={styles.reversalText}>Adjusted {formatPkr(reversal.amountPaisa)} · {reversal.reason} · {new Date(reversal.reversedAt).toLocaleDateString()}</Text>)}</View><View style={styles.paymentActions}><Text style={styles.money}>{formatPkr(payment.netAmountPaisa ?? payment.amountPaisa)}</Text>{(payment.netAmountPaisa ?? payment.amountPaisa) > 0 ? <Link href={{ pathname: '/payments/reverse', params: { paymentId: payment.id } }} asChild><Pressable accessibilityRole="button"><Text style={styles.link}>Adjust</Text></Pressable></Link> : null}</View></View>)}
        </View>

        {nextStatus ? <Pressable accessibilityRole="button" style={styles.primaryButton} onPress={() => { void advanceStatus(); }}><Text style={styles.primaryText}>{nextStatus === 'delivered' ? 'Confirm delivery' : `Move to ${nextStatus.replaceAll('_', ' ')}`}</Text></Pressable> : null}
        {repair.finalCostPaisa === null ? <View style={styles.finalCostBox}>
          <Text style={styles.sectionTitle}>Set final repair cost (Rs.)</Text>
          <TextInput accessibilityLabel="Final repair cost in rupees" value={finalCostInput} onChangeText={setFinalCostInput} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={Colors.light.textSecondary} style={styles.costInput} />
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: savingCost }} style={[styles.secondaryButton, savingCost && styles.disabled]} onPress={() => { void saveFinalCost(); }}><Text style={styles.secondaryText}>{savingCost ? 'Saving…' : 'Save final cost'}</Text></Pressable>
        </View> : <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={() => { void createInvoice(); }}><Text style={styles.secondaryText}>Issue / view invoice</Text></Pressable>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.light.background }, content: { padding: 16, paddingBottom: 32 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.light.background, padding: 24 },
  receipt: { color: Colors.light.primary, fontFamily: Fonts.mono, fontWeight: '700', fontSize: 14, marginBottom: 8 },
  heroRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }, title: { color: Colors.light.text, fontSize: 23, lineHeight: 30, fontWeight: '700', fontFamily: Fonts.sansBold, flexShrink: 1 },
  model: { color: Colors.light.textSecondary, fontSize: 14, marginTop: 4, marginBottom: 16 },
  status: { textTransform: 'capitalize', color: Colors.light.warning, backgroundColor: '#F5EDDF', fontSize: 11, fontWeight: '700', overflow: 'hidden', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6 },
  moneyCard: { backgroundColor: Colors.light.surface, borderWidth: 1, borderColor: Colors.light.border, borderRadius: 14, padding: 16, marginBottom: 14 },
  label: { color: Colors.light.textSecondary, fontSize: 12 }, total: { color: Colors.light.text, fontSize: 28, fontWeight: '700', marginVertical: 6, fontVariant: ['tabular-nums'] },
  moneyLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10 }, money: { color: Colors.light.text, fontWeight: '700', fontSize: 14 }, balanceLabel: { color: Colors.light.text, fontSize: 14, fontWeight: '700' }, balance: { color: Colors.light.primary, fontSize: 15, fontWeight: '700' },
  notice: { color: Colors.light.warning, backgroundColor: '#F5EDDF', borderRadius: 8, overflow: 'hidden', padding: 9, fontSize: 12, marginTop: 12 },
  section: { backgroundColor: Colors.light.surface, borderRadius: 14, borderColor: Colors.light.border, borderWidth: 1, padding: 15, marginBottom: 12 }, sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { color: Colors.light.text, fontSize: 16, fontWeight: '700', marginBottom: 10 }, body: { color: Colors.light.text, fontSize: 14, lineHeight: 21, marginBottom: 12 }, meta: { color: Colors.light.textSecondary, fontSize: 12, marginTop: 7 },
  link: { color: Colors.light.primary, fontWeight: '700', fontSize: 12, padding: 5 }, paymentRow: { borderTopWidth: 1, borderTopColor: Colors.light.border, paddingTop: 10, paddingBottom: 3, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, paymentDetails: { flex: 1 }, paymentActions: { alignItems: 'flex-end' }, reversalText: { color: Colors.light.warning, fontSize: 11, marginTop: 4 }, paymentMethod: { color: Colors.light.text, textTransform: 'capitalize', fontSize: 13, fontWeight: '600' }, muted: { color: Colors.light.textSecondary, fontSize: 13, lineHeight: 20 },
  primaryButton: { backgroundColor: Colors.light.primary, minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 12, marginTop: 5 }, primaryText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700', textTransform: 'capitalize' },
  secondaryButton: { borderWidth: 1, borderColor: Colors.light.primary, minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 12, marginTop: 10 }, secondaryText: { color: Colors.light.primary, fontWeight: '700' }, invoiceHint: { color: Colors.light.textSecondary, textAlign: 'center', marginTop: 14, fontSize: 12 },
  finalCostBox: { backgroundColor: Colors.light.surface, borderColor: Colors.light.border, borderWidth: 1, borderRadius: 14, padding: 15, marginTop: 10 }, costInput: { minHeight: 50, borderRadius: 11, borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.background, color: Colors.light.text, fontSize: 18, paddingHorizontal: 14, marginTop: 3 }, disabled: { opacity: 0.5 },
});
