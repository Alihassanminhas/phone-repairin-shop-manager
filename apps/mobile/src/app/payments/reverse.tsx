import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';

import { Colors } from '@/constants/theme';
import { getReversiblePayment, reversePayment } from '@/database/repair-repository';
import { formatPkr, parsePaisa } from '@/lib/money';

export default function ReversePaymentScreen() {
  const { paymentId } = useLocalSearchParams<{ paymentId: string }>();
  const database = useSQLiteContext();
  const [remainingPaisa, setRemainingPaisa] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!paymentId) return;
    void getReversiblePayment(database, paymentId).then((payment) => {
      setRemainingPaisa(payment?.remainingPaisa ?? null);
      if (payment) setAmount((payment.remainingPaisa / 100).toFixed(2));
    }).catch((error: unknown) => Alert.alert('Could not load payment', error instanceof Error ? error.message : 'Please try again.'));
  }, [database, paymentId]);

  async function save(): Promise<void> {
    if (!paymentId || saving) return;
    const amountPaisa = parsePaisa(amount);
    if (amountPaisa === null || amountPaisa <= 0) {
      Alert.alert('Check adjustment amount', 'Enter a positive amount with up to two decimal places.');
      return;
    }
    setSaving(true);
    try {
      await reversePayment(database, paymentId, amountPaisa, reason);
      Alert.alert('Adjustment saved', 'The original payment remains in history and the balance has been updated.', [{ text: 'Done', onPress: () => router.back() }]);
    } catch (error) {
      Alert.alert('Could not save adjustment', error instanceof Error ? error.message : 'Please try again.');
    } finally { setSaving(false); }
  }

  return <View style={styles.screen}>
    <View style={styles.card}>
      <Text style={styles.heading}>Record a payment adjustment</Text>
      <Text style={styles.helper}>This adds a permanent adjustment entry. It does not delete or rewrite the original payment.</Text>
      <Text style={styles.label}>Remaining amount</Text>
      <Text style={styles.balance}>{remainingPaisa === null ? 'Loading…' : formatPkr(remainingPaisa)}</Text>
      <Text style={styles.label}>Amount to adjust (Rs.)</Text>
      <TextInput accessibilityLabel="Adjustment amount in rupees" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} style={styles.input} placeholder="0.00" />
      <Text style={styles.label}>Reason</Text>
      <TextInput accessibilityLabel="Adjustment reason" value={reason} onChangeText={setReason} style={[styles.input, styles.reason]} placeholder="For example, customer refund" multiline maxLength={500} />
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: saving || remainingPaisa === null || remainingPaisa <= 0 }} onPress={() => { void save(); }} style={[styles.button, (saving || remainingPaisa === null || remainingPaisa <= 0) && styles.disabled]}><Text style={styles.buttonText}>{saving ? 'Saving…' : 'Save adjustment'}</Text></Pressable>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.light.background, padding: 16 },
  card: { borderRadius: 14, padding: 16, backgroundColor: Colors.light.surface, borderColor: Colors.light.border, borderWidth: 1 },
  heading: { color: Colors.light.text, fontWeight: '700', fontSize: 20 },
  helper: { color: Colors.light.textSecondary, lineHeight: 20, marginTop: 8, marginBottom: 20 },
  label: { color: Colors.light.textSecondary, fontSize: 12, marginTop: 12 },
  balance: { color: Colors.light.text, fontWeight: '700', fontSize: 22, marginTop: 4 },
  input: { minHeight: 50, borderWidth: 1, borderColor: Colors.light.border, borderRadius: 10, backgroundColor: Colors.light.background, padding: 12, color: Colors.light.text, marginTop: 7 },
  reason: { minHeight: 92, textAlignVertical: 'top' },
  button: { minHeight: 50, borderRadius: 10, backgroundColor: Colors.light.primary, justifyContent: 'center', alignItems: 'center', marginTop: 20 },
  buttonText: { color: '#fff', fontWeight: '700' }, disabled: { opacity: 0.5 },
});
