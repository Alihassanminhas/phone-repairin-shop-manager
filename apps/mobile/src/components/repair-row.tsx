import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Fonts } from '@/constants/theme';
import type { RepairListItem } from '@/features/repairs/types';
import { formatPkr } from '@/lib/money';

export function RepairRow({ repair }: { repair: RepairListItem }) {
  return (
    <Link href={{ pathname: '/repairs/[id]', params: { id: repair.id } }} asChild>
      <Pressable accessibilityRole="button" accessibilityLabel={`${repair.receiptNumber}, ${repair.customerName}, ${repair.brand} ${repair.model}`} style={styles.row}>
        <View style={styles.topLine}>
          <Text style={styles.receipt}>{repair.receiptNumber}</Text>
          <Text style={styles.status}>{repair.status.replaceAll('_', ' ')}</Text>
        </View>
        <Text style={styles.name}>{repair.customerName}</Text>
        <View style={styles.bottomLine}>
          <Text style={styles.device}>{repair.brand} {repair.model}</Text>
          <Text style={styles.amount}>{repair.finalCostPaisa !== null ? formatPkr(repair.balancePaisa ?? 0) : 'Cost pending'}</Text>
        </View>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  row: { backgroundColor: Colors.light.surface, borderColor: Colors.light.border, borderWidth: 1, borderRadius: 16, padding: 16, gap: 7 },
  topLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  receipt: { color: Colors.light.textSecondary, fontSize: 11, fontFamily: Fonts.mono },
  status: { color: Colors.light.primary, fontSize: 11, fontWeight: '700', textTransform: 'capitalize' },
  name: { color: Colors.light.text, fontSize: 16, fontFamily: Fonts.sansSemiBold },
  bottomLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  device: { color: Colors.light.textSecondary, fontSize: 13 },
  amount: { color: Colors.light.text, fontFamily: Fonts.mono, fontSize: 12 },
});
