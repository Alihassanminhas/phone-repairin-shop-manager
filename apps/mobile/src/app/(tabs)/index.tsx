import { Link, router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Fonts, Spacing } from '@/constants/theme';
import { getDashboardSummary, listRepairs } from '@/database/repair-repository';
import type { DashboardSummary, RepairListItem } from '@/features/repairs/types';
import { formatPkr } from '@/lib/money';
import { RepairRow } from '@/components/repair-row';

const EMPTY_SUMMARY: DashboardSummary = {
  receivedToday: 0,
  inProgress: 0,
  ready: 0,
  overdue: 0,
  paidTodayPaisa: 0,
  outstandingPaisa: 0,
};

export default function DashboardScreen() {
  const database = useSQLiteContext();
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [recentRepairs, setRecentRepairs] = useState<RepairListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = useCallback(async () => {
    setError(null);
    try {
      const [nextSummary, nextRepairs] = await Promise.all([
        getDashboardSummary(database),
        listRepairs(database),
      ]);
      setSummary(nextSummary);
      setRecentRepairs(nextRepairs.slice(0, 4));
    } catch {
      setError('We could not load your saved shop records. Please try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [database]);

  useFocusEffect(useCallback(() => { void loadDashboard(); }, [loadDashboard]));

  const today = new Intl.DateTimeFormat('en-PK', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void loadDashboard(); }} tintColor={Colors.light.primary} />}
      >
        <View style={styles.topline}>
          <View>
            <Text style={styles.eyebrow}>{today}</Text>
            <Text accessibilityRole="header" style={styles.title}>Mobile Repair Shop</Text>
          </View>
          <View accessibilityLabel="Offline-ready; records save on this phone" style={styles.syncPill}>
            <View style={styles.syncDot} />
            <Text style={styles.syncText}>On this phone</Text>
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityHint="Opens a new repair record"
          onPress={() => router.push('/repairs/new')}
          style={({ pressed }) => [styles.receiveButton, pressed && styles.pressed]}
        >
          <Text style={styles.receivePlus}>＋</Text>
          <View>
            <Text style={styles.receiveTitle}>Receive a phone</Text>
            <Text style={styles.receiveSubtitle}>Start a new repair record</Text>
          </View>
          <Text style={styles.receiveArrow}>›</Text>
        </Pressable>

        <View style={styles.sectionHeading}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>Shop floor</Text>
          <Text style={styles.sectionHint}>Live from saved records</Text>
        </View>

        {error ? (
          <View accessibilityRole="alert" style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable accessibilityRole="button" onPress={() => { setLoading(true); void loadDashboard(); }}><Text style={styles.retryText}>Retry</Text></Pressable>
          </View>
        ) : (
          <View style={styles.statsGrid}>
            <StatTile label="In progress" value={summary.inProgress} accent={Colors.light.primary} loading={loading} />
            <StatTile label="Ready for pickup" value={summary.ready} accent={Colors.light.success} loading={loading} />
            <StatTile label="Overdue" value={summary.overdue} accent={summary.overdue > 0 ? Colors.light.error : Colors.light.textSecondary} loading={loading} />
            <StatTile label="Received today" value={summary.receivedToday} accent={Colors.light.text} loading={loading} />
          </View>
        )}

        <View style={styles.moneyRow}>
          <View style={styles.moneyCard}>
            <Text style={styles.moneyLabel}>Received today</Text>
            <Text style={styles.moneyValue}>{formatPkr(summary.paidTodayPaisa)}</Text>
          </View>
          <View style={[styles.moneyCard, styles.balanceCard]}>
            <Text style={styles.moneyLabel}>Outstanding</Text>
            <Text style={styles.moneyValue}>{formatPkr(summary.outstandingPaisa)}</Text>
          </View>
        </View>

        <View style={styles.sectionHeading}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>Recent repairs</Text>
          <Link href="/(tabs)/repairs" asChild><Pressable accessibilityRole="link"><Text style={styles.viewAll}>View all</Text></Pressable></Link>
        </View>

        {!loading && recentRepairs.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>Your repair list is clear</Text>
            <Text style={styles.emptyCopy}>New jobs will appear here as soon as you receive a phone.</Text>
          </View>
        ) : recentRepairs.map((repair) => <RepairRow key={repair.id} repair={repair} />)}
      </ScrollView>
    </SafeAreaView>
  );
}

function StatTile({ label, value, accent, loading }: { label: string; value: number; accent: string; loading: boolean }) {
  return (
    <View style={styles.statTile}>
      <Text style={[styles.statValue, { color: accent }]}>{loading ? '—' : value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: Colors.light.background },
  content: { paddingHorizontal: Spacing.three, paddingTop: Spacing.two, paddingBottom: 32 },
  topline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 },
  eyebrow: { color: Colors.light.textSecondary, fontSize: 13, marginBottom: 4 },
  title: { color: Colors.light.text, fontSize: 25, lineHeight: 31, fontWeight: '700', fontFamily: Fonts.sansBold, letterSpacing: -0.4 },
  syncPill: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: Colors.light.surface, borderRadius: 20, borderWidth: 1, borderColor: Colors.light.border },
  syncDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.light.success },
  syncText: { color: Colors.light.textSecondary, fontSize: 11, fontWeight: '600' },
  receiveButton: { minHeight: 80, borderRadius: 14, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: Colors.light.primary, marginBottom: 28 },
  receivePlus: { color: '#FFFFFF', fontSize: 30, fontWeight: '300', lineHeight: 34 },
  receiveTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  receiveSubtitle: { color: '#D6EAE6', fontSize: 12, marginTop: 3 },
  receiveArrow: { color: '#FFFFFF', fontSize: 28, marginLeft: 'auto' },
  pressed: { opacity: 0.78 },
  sectionHeading: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitle: { color: Colors.light.text, fontSize: 18, fontWeight: '700', fontFamily: Fonts.sansBold },
  sectionHint: { color: Colors.light.textSecondary, fontSize: 12 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  statTile: { width: '48%', flexGrow: 1, backgroundColor: Colors.light.surface, paddingHorizontal: 14, paddingVertical: 13, borderRadius: 13, borderWidth: 1, borderColor: Colors.light.border, minHeight: 82, justifyContent: 'center' },
  statValue: { fontSize: 25, fontWeight: '700', marginBottom: 3, fontVariant: ['tabular-nums'] },
  statLabel: { color: Colors.light.textSecondary, fontSize: 12 },
  moneyRow: { flexDirection: 'row', gap: 10, marginBottom: 27 },
  moneyCard: { flex: 1, backgroundColor: '#E1EEE9', borderRadius: 13, padding: 14, minHeight: 80, justifyContent: 'center' },
  balanceCard: { backgroundColor: '#F0E8D9' },
  moneyLabel: { color: Colors.light.textSecondary, fontSize: 12, marginBottom: 6 },
  moneyValue: { color: Colors.light.text, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  viewAll: { color: Colors.light.primary, fontWeight: '700', fontSize: 13, paddingVertical: 8 },
  emptyState: { backgroundColor: Colors.light.surface, borderWidth: 1, borderStyle: 'dashed', borderColor: Colors.light.border, borderRadius: 13, padding: 18 },
  emptyTitle: { color: Colors.light.text, fontSize: 14, fontWeight: '700', marginBottom: 5 },
  emptyCopy: { color: Colors.light.textSecondary, fontSize: 12, lineHeight: 18 },
  errorBox: { padding: 14, borderRadius: 12, borderColor: '#E7BDB9', borderWidth: 1, marginBottom: 14 },
  errorText: { color: Colors.light.error, fontSize: 13 },
  retryText: { color: Colors.light.primary, fontWeight: '700', paddingTop: 10 },
});
