import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';
import { listCustomers, type CustomerListItem } from '@/database/customer-repository';
import { formatPkr } from '@/lib/money';

export default function CustomersScreen() {
  const database = useSQLiteContext();
  const [search, setSearch] = useState('');
  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setError(null); setCustomers(await listCustomers(database, search)); }
    catch { setError('Saved customers could not be loaded.'); }
    finally { setLoading(false); }
  }, [database, search]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>Customers</Text>
      <TextInput accessibilityLabel="Search customers" value={search} onChangeText={setSearch} placeholder="Search name or phone number" placeholderTextColor={Colors.light.textSecondary} style={styles.search} />
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <ScrollView contentContainerStyle={styles.list}>
        {loading ? <Text style={styles.muted}>Loading saved customers…</Text> : null}
        {!loading && customers.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>{search ? 'No matching customers' : 'Customer records will appear here'}</Text><Text style={styles.muted}>Customers are saved automatically when you receive a phone.</Text></View> : null}
        {customers.map((customer) => (
          <View key={customer.id} style={styles.row}>
            <View style={styles.initial}><Text style={styles.initialText}>{customer.name.trim().charAt(0).toUpperCase() || '?'}</Text></View>
            <View style={styles.info}><Text style={styles.name}>{customer.name}</Text><Text style={styles.phone}>{customer.phone}</Text><Text style={styles.jobs}>{customer.repairCount} {customer.repairCount === 1 ? 'repair' : 'repairs'}</Text></View>
            <Text style={styles.balance}>{customer.outstandingPaisa > 0 ? formatPkr(customer.outstandingPaisa) : '—'}</Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.light.background, paddingHorizontal: 16, paddingTop: 6 }, title: { color: Colors.light.text, fontSize: 25, fontWeight: '700', marginBottom: 13 },
  search: { height: 48, borderRadius: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.surface, color: Colors.light.text, fontSize: 14, marginBottom: 14 }, list: { paddingBottom: 24 },
  row: { backgroundColor: Colors.light.surface, borderRadius: 13, borderWidth: 1, borderColor: Colors.light.border, padding: 13, marginBottom: 9, flexDirection: 'row', alignItems: 'center', gap: 11 }, initial: { height: 40, width: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E1EEE9' }, initialText: { color: Colors.light.primary, fontSize: 16, fontWeight: '700' }, info: { flex: 1 }, name: { color: Colors.light.text, fontSize: 14, fontWeight: '700' }, phone: { color: Colors.light.textSecondary, fontSize: 12, marginTop: 3 }, jobs: { color: Colors.light.textSecondary, fontSize: 11, marginTop: 4 }, balance: { color: Colors.light.warning, fontSize: 11, fontWeight: '700' },
  empty: { padding: 18, borderRadius: 13, borderColor: Colors.light.border, borderWidth: 1, backgroundColor: Colors.light.surface }, emptyTitle: { color: Colors.light.text, fontSize: 14, fontWeight: '700', marginBottom: 6 }, muted: { color: Colors.light.textSecondary, fontSize: 12, lineHeight: 19 }, error: { color: Colors.light.error, padding: 12 },
});
