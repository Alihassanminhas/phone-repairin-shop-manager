import { SymbolView } from 'expo-symbols';
import { Tabs } from 'expo-router';

import { Colors } from '@/constants/theme';

const tabIcons = {
  index: { ios: 'house.fill', android: 'home', web: 'home' },
  repairs: { ios: 'wrench.and.screwdriver.fill', android: 'build', web: 'build' },
  customers: { ios: 'person.2.fill', android: 'people', web: 'people' },
  records: { ios: 'doc.text.fill', android: 'description', web: 'description' },
  settings: { ios: 'gearshape.fill', android: 'settings', web: 'settings' },
} as const;

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: Colors.light.primary,
        tabBarInactiveTintColor: Colors.light.textSecondary,
        tabBarStyle: { backgroundColor: Colors.light.surface, borderTopColor: Colors.light.border },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarIcon: ({ color }) => (
          <SymbolView name={tabIcons[route.name as keyof typeof tabIcons]} tintColor={color} size={20} />
        ),
      })}>
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="repairs" options={{ title: 'Repairs' }} />
      <Tabs.Screen name="customers" options={{ title: 'Customers' }} />
      <Tabs.Screen name="records" options={{ title: 'Records' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
