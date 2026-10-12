import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';

import { Colors } from '@/constants/theme';
import { addPayment, getRepairDetails } from '@/database/repair-repository';
import { formatPkr, parsePaisa } from '@/lib/money';

export default function NewPaymentScreen() {
  const { repairId } = useLocalSearchParams<{ repairId: string }>();
  const database = useSQLiteContext();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'bank_transfer' | 'other'>('cash');
  const [saving, setSaving] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [repairMissing, setRepairMissing] = useState(false);

  useEffect(() => {
    if (!repairId) return;
    void getRepairDetails(database, repairId).then((repair) => {
      setBalance(repair?.balancePaisa ?? null);
      setRepairMissing(!repair);
    }).catch(() => Alert.alert('Could not load repair', 'Please return to the repair and try again.'));
  }, [database, repairId]);

  async function save(): Promise<void> {
    if (!repairId || saving || repairMissing) return;
    const amountPaisa = parsePaisa(amount);
    if (amountPaisa === null || amountPaisa <= 0) {
      Alert.alert('Check payment amount', 'Enter a positive amount with up to two decimal places.');
      return;
    }
    setSaving(true);
    try {
      await addPayment(database, repairId, amountPaisa, method);
      Alert.alert('Payment saved', `${formatPkr(amountPaisa)} is saved in this phone’s payment history.`, [{ text: 'Done', onPress: () => router.back() }]);
    } catch (error) {
      Alert.alert('Could not save payment', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.label}>Current balance</Text>
        <Text style={styles.balance}>{balance === null ? 'Final cost not set' : formatPkr(Math.max(0, balance))}</Text>
        <Text style={styles.helper}>Payments are saved separately and never removed when a repair is delivered.</Text>
      </View>
      <Text style={styles.fieldLabel}>Amount received (Rs.)</Text>
      <TextInput accessibilityLabel="Amount received in rupees" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={Colors.light.textSecondary} style={styles.input} />
      <Text style={styles.fieldLabel}>Payment method</Text>
      <View style={styles.methods}>
        {(['cash', 'bank_transfer', 'other'] as const).map((option) => {
          const selected = method === option;
          return <Pressable key={option} accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={() => setMethod(option)} style={[styles.method, selected && styles.selectedMethod]}><Text style={[styles.methodText, selected && styles.selectedMethodText]}>{option.replace('_', ' ')}</Text></Pressable>;
        })}
      </View>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: saving || repairMissing }} onPress={() => { void save(); }} style={[styles.save, (saving || repairMissing) && styles.disabled]}><Text style={styles.saveText}>{saving ? 'Saving…' : 'Save payment'}</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.light.background, padding: 16 }, card: { backgroundColor: Colors.light.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, padding: 16, marginTop: 6, marginBottom: 20 },
  label: { color: Colors.light.textSecondary, fontSize: 12 }, balance: { color: Colors.light.text, fontSize: 26, fontWeight: '700', marginTop: 5, fontVariant: ['tabular-nums'] }, helper: { color: Colors.light.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 10 },
  fieldLabel: { color: Colors.light.text, fontSize: 13, fontWeight: '600', marginBottom: 7, marginTop: 8 }, input: { minHeight: 52, borderRadius: 11, borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.surface, color: Colors.light.text, fontSize: 18, paddingHorizontal: 14 },
  methods: { flexDirection: 'row', gap: 8, marginBottom: 24 }, method: { flex: 1, minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: Colors.light.border, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.light.surface, paddingHorizontal: 4 }, selectedMethod: { borderColor: Colors.light.primary, backgroundColor: '#E3EFEB' }, methodText: { color: Colors.light.textSecondary, fontSize: 12, textTransform: 'capitalize' }, selectedMethodText: { color: Colors.light.primary, fontWeight: '700' },
  save: { height: 54, borderRadius: 12, backgroundColor: Colors.light.primary, justifyContent: 'center', alignItems: 'center' }, saveText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 }, disabled: { opacity: 0.5 },
});
