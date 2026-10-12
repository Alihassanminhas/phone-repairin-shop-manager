import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from '@expo-google-fonts/dm-sans';
import { IBMPlexMono_400Regular } from '@expo-google-fonts/ibm-plex-mono';
import { SQLiteProvider } from 'expo-sqlite';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';
import { migrateDatabase } from '@/database/schema';

void SplashScreen.preventAutoHideAsync();

export function ErrorBoundary({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <View style={styles.errorScreen}>
      <Text accessibilityRole="header" style={styles.errorTitle}>Shop data could not be opened</Text>
      <Text style={styles.errorBody}>{error.message}</Text>
      <Text accessibilityRole="button" onPress={retry} style={styles.retry}>Try again</Text>
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
    IBMPlexMono_400Regular,
  });

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <SQLiteProvider databaseName="repair-shop.db" onInit={async (database) => {
        try {
          await migrateDatabase(database);
        } finally {
          await SplashScreen.hideAsync();
        }
      }}>
        <StatusBar style="dark" />
        <Stack screenOptions={{ contentStyle: { backgroundColor: Colors.light.background } }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="repairs/new" options={{ title: 'Receive phone', presentation: 'modal' }} />
          <Stack.Screen name="repairs/[id]" options={{ title: 'Repair details' }} />
          <Stack.Screen name="payments/new" options={{ title: 'Record payment', presentation: 'modal' }} />
          <Stack.Screen name="payments/reverse" options={{ title: 'Payment adjustment', presentation: 'modal' }} />
        </Stack>
      </SQLiteProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  errorScreen: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: Colors.light.background },
  errorTitle: { color: Colors.light.text, fontSize: 20, fontWeight: '700', marginBottom: 8 },
  errorBody: { color: Colors.light.textSecondary, fontSize: 15, lineHeight: 22 },
  retry: { color: Colors.light.primary, fontWeight: '700', marginTop: 20, paddingVertical: 12 },
});
