import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';
import { listRepairs } from '@/database/repair-repository';
import type { RepairListItem } from '@/features/repairs/types';
import { RepairRow } from '@/components/repair-row';

export default function RepairsScreen() {
  const database = useSQLiteContext();
  const [search, setSearch] = useState('');
  const [repairs, setRepairs] = useState<RepairListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setRepairs(await listRepairs(database, search));
    } catch {
      setError('Saved repairs could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [database, search]);

  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>Repairs</Text>
        <Link href="/repairs/new" asChild><Pressable accessibilityRole="button" style={styles.addButton}><Text style={styles.addText}>＋ Receive phone</Text></Pressable></Link>
      </View>
      <TextInput accessibilityLabel="Search repairs" placeholder="Search receipt, customer, or phone model" placeholderTextColor={Colors.light.textSecondary} value={search} onChangeText={setSearch} style={styles.search} />
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <ScrollView contentContainerStyle={styles.list}>
        {loading ? <Text style={styles.hint}>Loading saved repairs…</Text> : null}
        {!loading && !error && repairs.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>{search ? 'No matching repairs' : 'No repairs yet'}</Text><Text style={styles.hint}>{search ? 'Try another receipt number, customer, brand, or model.' : 'Receive a phone to start the first job record.'}</Text></View> : null}
        {repairs.map((repair) => <RepairRow key={repair.id} repair={repair} />)}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.light.background, paddingHorizontal: 16 },
  header: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: Colors.light.text, fontSize: 25, fontWeight: '700' },
  addButton: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: Colors.light.primary },
  addText: { color: '#FFFFFF', fontWeight: '700', fontSize: 12 },
  search: { height: 48, borderRadius: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.surface, color: Colors.light.text, fontSize: 14, marginTop: 8, marginBottom: 15 },
  list: { paddingBottom: 24 },
  hint: { color: Colors.light.textSecondary, fontSize: 13, lineHeight: 19 },
  error: { color: Colors.light.error, padding: 12 },
  empty: { backgroundColor: Colors.light.surface, padding: 18, borderWidth: 1, borderColor: Colors.light.border, borderRadius: 14 },
  emptyTitle: { color: Colors.light.text, fontWeight: '700', fontSize: 15, marginBottom: 6 },
});
