import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';

import { Colors, Fonts, Spacing } from '@/constants/theme';
import { createRepair } from '@/database/repair-repository';
import { parsePaisa } from '@/lib/money';

export default function NewRepairScreen() {
  const database = useSQLiteContext();
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [problem, setProblem] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [estimate, setEstimate] = useState('');
  const [advance, setAdvance] = useState('');
  const [saving, setSaving] = useState(false);

  async function saveRepair(): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      const estimatePaisa = estimate.trim() ? parsePaisa(estimate) : null;
      const advancePaisa = advance.trim() ? parsePaisa(advance) : null;
      if (estimatePaisa === null && estimate.trim()) throw new Error('Enter a valid estimate with up to two decimal places.');
      if (advancePaisa === null && advance.trim()) throw new Error('Enter a valid advance amount with up to two decimal places.');
      if (expectedDate.trim() && !isValidDateOnly(expectedDate.trim())) {
        throw new Error('Use YYYY-MM-DD for the expected delivery date.');
      }

      const created = await createRepair(database, {
        customerName,
        customerPhone,
        brand,
        model,
        reportedProblem: problem,
        expectedDeliveryDate: expectedDate.trim() || undefined,
        estimatedCostPaisa: estimatePaisa ?? undefined,
        initialPaymentPaisa: advancePaisa ?? undefined,
      });
      Alert.alert('Repair saved', `${created.receiptNumber} is saved on this phone. Cloud sync is not configured yet.`, [
        { text: 'View repair', onPress: () => router.replace({ pathname: '/repairs/[id]', params: { id: created.id } }) },
      ]);
    } catch (error) {
      Alert.alert('Could not save repair', error instanceof Error ? error.message : 'Your details are still here. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.intro}>A repair record is saved on this phone first. Add the final bill when diagnosis is complete.</Text>
        <Section title="Customer">
          <Field label="Customer name *" value={customerName} onChangeText={setCustomerName} autoCapitalize="words" />
          <Field label="Phone number *" value={customerPhone} onChangeText={setCustomerPhone} keyboardType="phone-pad" />
        </Section>
        <Section title="Phone and issue">
          <Field label="Brand *" value={brand} onChangeText={setBrand} autoCapitalize="words" />
          <Field label="Model *" value={model} onChangeText={setModel} />
          <Field label="Reported problem *" value={problem} onChangeText={setProblem} multiline />
        </Section>
        <Section title="Dates and cost">
          <Field label="Expected delivery (YYYY-MM-DD)" value={expectedDate} onChangeText={setExpectedDate} placeholder="2026-10-20" />
          <Field label="Estimated cost (Rs.)" value={estimate} onChangeText={setEstimate} keyboardType="decimal-pad" />
          <Field label="Advance payment (Rs.)" value={advance} onChangeText={setAdvance} keyboardType="decimal-pad" />
        </Section>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: saving }} onPress={() => { void saveRepair(); }} style={({ pressed }) => [styles.saveButton, pressed && !saving && styles.pressed, saving && styles.disabled]}>
          <Text style={styles.saveText}>{saving ? 'Saving on this phone…' : 'Save repair'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.cancelButton}><Text style={styles.cancelText}>Cancel</Text></Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <View style={styles.section}><Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>{children}</View>;
}

function Field(props: { label: string; value: string; onChangeText: (value: string) => void; keyboardType?: 'phone-pad' | 'decimal-pad'; multiline?: boolean; autoCapitalize?: 'words'; placeholder?: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChangeText}
        keyboardType={props.keyboardType ?? 'default'}
        autoCapitalize={props.autoCapitalize ?? 'sentences'}
        multiline={props.multiline}
        placeholder={props.placeholder}
        placeholderTextColor={Colors.light.textSecondary}
        style={[styles.input, props.multiline && styles.multiline]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Colors.light.background },
  content: { padding: Spacing.three, paddingBottom: 36 },
  intro: { color: Colors.light.textSecondary, fontSize: 13, lineHeight: 20, marginBottom: 20 },
  section: { backgroundColor: Colors.light.surface, borderRadius: 14, borderColor: Colors.light.border, borderWidth: 1, padding: 15, marginBottom: 14 },
  sectionTitle: { color: Colors.light.text, fontSize: 16, fontWeight: '700', fontFamily: Fonts.sansBold, marginBottom: 12 },
  field: { marginBottom: 12 },
  label: { color: Colors.light.text, fontSize: 13, fontWeight: '600', fontFamily: Fonts.sansMedium, marginBottom: 6 },
  input: { minHeight: 48, borderRadius: 10, borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.background, paddingHorizontal: 12, color: Colors.light.text, fontSize: 15, fontFamily: Fonts.sans },
  multiline: { minHeight: 88, paddingTop: 12, textAlignVertical: 'top' },
  saveButton: { height: 54, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.light.primary, marginTop: 6 },
  saveText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.55 },
  pressed: { backgroundColor: Colors.light.primaryPressed },
  cancelButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  cancelText: { color: Colors.light.textSecondary, fontSize: 14, fontWeight: '600' },
});
