import { useEffect, useState } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { Alert, ScrollView, StyleSheet, Text, TextInput, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';
import { getOutboxConflicts, type OutboxConflict } from '@/database/outbox';
import { bindLocalRecordsToOwner } from '@/database/owner-binding';
import { getSavedOwner, recoverOwnerPassword, setupOwner, signInOwner, signOutOwner, type OwnerAccount } from '@/services/auth/owner-auth';
import { resolveSyncConflict, syncPendingOperations } from '@/services/sync/sync-client';

export default function SettingsScreen() {
  const [mode, setMode] = useState<'login' | 'setup' | 'recover'>('login');
  const [owner, setOwner] = useState<OwnerAccount | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [shopName, setShopName] = useState('');
  const [bootstrapCode, setBootstrapCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  const [checkingSession, setCheckingSession] = useState(true);
  const [conflicts, setConflicts] = useState<OutboxConflict[]>([]);
  const database = useSQLiteContext();

  useEffect(() => {
    void getSavedOwner().then(setOwner).catch(() => setError('Could not read the saved owner session.')).finally(() => setCheckingSession(false));
    void getOutboxConflicts(database).then(setConflicts).catch(() => setError('Could not read the sync conflict list.'));
  }, [database]);

  async function submitAuth(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      if (mode === 'recover') {
        const nextRecoveryCode = await recoverOwnerPassword(email, recoveryCode, password);
        setPassword('');
        setRecoveryCode('');
        setMode('login');
        Alert.alert('Password recovery submitted', nextRecoveryCode
          ? `Your password was reset. Save the new recovery code somewhere private:\n\n${nextRecoveryCode}`
          : 'If those recovery details were valid, the password was reset. Try signing in with the new password.');
        return;
      }
      const session = mode === 'login' ? await signInOwner(email, password) : await setupOwner({ email, password, shopName, bootstrapCode });
      try {
        await bindLocalRecordsToOwner(database, session.owner.id);
      } catch (bindingError) {
        await signOutOwner();
        throw bindingError;
      }
      setOwner(session.owner);
      setPassword('');
      setBootstrapCode('');
      if (session.recoveryCode) Alert.alert('Save your recovery code', `${session.recoveryCode}\n\nStore this somewhere private. It is shown only once.`);
      const summary = await syncPendingOperations(database);
      setSyncMessage(`Sync complete: ${summary.pushed} sent, ${summary.conflicts} need review.`);
      setConflicts(await getOutboxConflicts(database));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect the owner account.');
    } finally {
      setBusy(false);
    }
  }

  async function logout(): Promise<void> {
    setBusy(true);
    try {
      await signOutOwner();
      setOwner(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign out.');
    } finally {
      setBusy(false);
    }
  }

  async function syncNow(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const summary = await syncPendingOperations(database);
      setSyncMessage(`Sync complete: ${summary.pushed} sent, ${summary.conflicts} need review, ${summary.pending} waiting.`);
      setConflicts(await getOutboxConflicts(database));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Sync could not complete.';
      setError(message);
      if (message.includes('Sign in again')) setOwner(null);
    } finally {
      setBusy(false);
    }
  }

  async function resolveConflict(id: string, choice: 'keep_local' | 'use_server' | 'local_only'): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await resolveSyncConflict(database, id, choice);
      setConflicts(await getOutboxConflicts(database));
      setSyncMessage(choice === 'keep_local' ? 'Local version queued to retry against the current cloud version.' : choice === 'use_server' ? 'The phone now uses the saved cloud version.' : 'This change will stay on this phone and will not be uploaded.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This conflict could not be resolved.');
    } finally { setBusy(false); }
  }

  function confirmUseServer(id: string, label: string): void {
    Alert.alert('Use the cloud version?', `This replaces the conflicting ${label} details on this phone. The saved cloud record will be kept.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Use cloud version', style: 'destructive', onPress: () => { void resolveConflict(id, 'use_server'); } },
    ]);
  }

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>Settings</Text>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Owner account</Text>
          {checkingSession ? <Text style={styles.description}>Checking saved owner session…</Text> : owner ? <>
            <Text style={styles.description}>{owner.shopName} · {owner.email}</Text>
            {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            {!!syncMessage && <Text style={styles.description}>{syncMessage}</Text>}
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void syncNow()} style={[styles.button, busy && styles.disabled]}><Text style={styles.buttonText}>{busy ? 'Syncing…' : 'Sync records now'}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void logout()} style={styles.button}><Text style={styles.buttonText}>{busy ? 'Please wait…' : 'Sign out'}</Text></Pressable>
          </> : <>
            <Text style={styles.description}>Sign in to connect this phone to your shop account. Repairs stay available locally when offline.</Text>
            {mode === 'setup' && <TextInput accessibilityLabel="Shop name" placeholder="Shop name" value={shopName} onChangeText={setShopName} style={styles.input} maxLength={120} />}
            <TextInput accessibilityLabel="Owner email" placeholder="Owner email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} style={styles.input} maxLength={254} />
            <TextInput accessibilityLabel={mode === 'recover' ? 'New password' : 'Password'} placeholder={mode === 'recover' ? 'New password (at least 12 characters)' : 'Password (at least 12 characters)'} secureTextEntry value={password} onChangeText={setPassword} style={styles.input} maxLength={128} />
            {mode === 'setup' && <TextInput accessibilityLabel="One-time setup code" placeholder="One-time setup code" secureTextEntry value={bootstrapCode} onChangeText={setBootstrapCode} style={styles.input} maxLength={128} />}
            {mode === 'recover' && <TextInput accessibilityLabel="Recovery code" placeholder="Saved recovery code" secureTextEntry value={recoveryCode} onChangeText={setRecoveryCode} style={styles.input} maxLength={128} />}
            {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            <Pressable accessibilityRole="button" disabled={busy || !email || !password || (mode === 'setup' && (!shopName || !bootstrapCode)) || (mode === 'recover' && !recoveryCode)} onPress={() => void submitAuth()} style={[styles.button, (busy || !email || !password || (mode === 'setup' && (!shopName || !bootstrapCode)) || (mode === 'recover' && !recoveryCode)) && styles.disabled]}>
              <Text style={styles.buttonText}>{busy ? 'Connecting…' : mode === 'login' ? 'Sign in' : mode === 'setup' ? 'Create owner account' : 'Reset password'}</Text>
            </Pressable>
            {mode === 'login' ? <>
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setMode('setup'); setError(''); }} style={styles.modeToggle}><Text style={styles.modeText}>First setup? Create the owner account</Text></Pressable>
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setMode('recover'); setError(''); }} style={styles.modeToggle}><Text style={styles.modeText}>Forgot password? Use recovery code</Text></Pressable>
            </> : <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setMode('login'); setError(''); }} style={styles.modeToggle}><Text style={styles.modeText}>Back to sign in</Text></Pressable>}
          </>}
        </View>
        {conflicts.length > 0 ? <View style={styles.conflictCard}>
          <Text style={styles.conflictTitle}>Sync conflicts need review ({conflicts.length})</Text>
          <Text style={styles.description}>Your phone’s entries are preserved. Resolve these records before relying on the cloud copy.</Text>
          {conflicts.slice(0, 8).map((conflict) => <View key={conflict.id} style={styles.conflictRow}>
            <Text style={styles.conflictRecord}>{conflict.label} · {conflict.entityType.replaceAll('_', ' ')}</Text>
            <Text style={styles.conflictReason}>{conflict.reason}</Text>
            <View style={styles.conflictActions}>
              {conflict.canKeepLocal ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void resolveConflict(conflict.id, 'keep_local'); }} style={styles.conflictAction}><Text style={styles.conflictActionText}>Keep this phone’s version</Text></Pressable> : null}
              {conflict.canUseServer ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => confirmUseServer(conflict.id, conflict.label)} style={styles.conflictAction}><Text style={styles.conflictActionText}>Use cloud version…</Text></Pressable> : null}
              {conflict.canKeepLocalOnly ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => Alert.alert('Keep only on this phone?', `“${conflict.label}” will remain saved here and this change will not be sent to the shop account.`, [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Keep on this phone', style: 'destructive', onPress: () => { void resolveConflict(conflict.id, 'local_only'); } },
              ])} style={styles.conflictAction}><Text style={styles.conflictActionText}>Keep on this phone only…</Text></Pressable> : null}
              {!conflict.canKeepLocal && !conflict.canUseServer ? <Text style={styles.conflictManual}>Financial or invoice changes cannot be merged automatically. Choose “Keep on this phone only” to retain the change locally without uploading it.</Text> : null}
            </View>
          </View>)}
          {conflicts.length > 8 ? <Text style={styles.description}>And {conflicts.length - 8} more.</Text> : null}
        </View> : null}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Language</Text>
          <Text style={styles.description}>English is active. Urdu and right-to-left layout are being added.</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Cloud sync</Text>
          <View style={styles.syncRow}><View style={styles.pendingDot} /><Text style={styles.description}>Records are saved locally first. Tap Sync records now to upload pending changes and retrieve this shop’s other devices.</Text></View>
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Records and backup</Text>
          <Text style={styles.description}>Issue invoices and download individual or monthly Excel records from the Records tab.</Text>
        </View>
        <Text style={styles.version}>Mobile Repair Shop Manager · Android</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.light.background }, content: { padding: 16, paddingBottom: 32 },
  title: { color: Colors.light.text, fontSize: 25, fontWeight: '700', marginBottom: 16 },
  card: { backgroundColor: Colors.light.surface, borderWidth: 1, borderColor: Colors.light.border, borderRadius: 13, padding: 15, marginBottom: 10 },
  sectionTitle: { color: Colors.light.text, fontSize: 15, fontWeight: '700', marginBottom: 6 }, description: { color: Colors.light.textSecondary, fontSize: 12, lineHeight: 18 },
  input: { borderColor: Colors.light.border, borderWidth: 1, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 11, color: Colors.light.text, marginTop: 10, backgroundColor: Colors.light.background },
  button: { backgroundColor: Colors.light.primary, borderRadius: 9, padding: 13, alignItems: 'center', marginTop: 12 }, buttonText: { color: '#fff', fontWeight: '700' }, disabled: { opacity: 0.5 },
  error: { color: Colors.light.error, fontSize: 12, marginTop: 10 }, modeToggle: { alignItems: 'center', padding: 12 }, modeText: { color: Colors.light.primary, fontSize: 12, fontWeight: '600' },
  conflictCard: { backgroundColor: '#FFF4E5', borderColor: '#F0D2A8', borderWidth: 1, borderRadius: 13, padding: 15, marginBottom: 10 }, conflictTitle: { color: Colors.light.warning, fontWeight: '700', fontSize: 14, marginBottom: 6 }, conflictRow: { borderTopWidth: 1, borderTopColor: '#F0D2A8', paddingTop: 8, marginTop: 8 }, conflictRecord: { color: Colors.light.text, fontSize: 12, fontWeight: '700' }, conflictReason: { color: Colors.light.textSecondary, fontSize: 12, marginTop: 3 }, conflictActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 }, conflictAction: { minHeight: 38, justifyContent: 'center', paddingHorizontal: 8 }, conflictActionText: { color: Colors.light.primary, fontSize: 12, fontWeight: '700' }, conflictManual: { color: Colors.light.warning, fontSize: 11, paddingVertical: 8 },
  syncRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 }, pendingDot: { width: 8, height: 8, marginTop: 5, borderRadius: 4, backgroundColor: Colors.light.warning }, version: { color: Colors.light.textSecondary, fontSize: 11, textAlign: 'center', marginTop: 10 },
});
