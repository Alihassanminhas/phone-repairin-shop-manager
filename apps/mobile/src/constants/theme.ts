import { Platform } from 'react-native';

/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

export const Colors = {
  light: {
    text: '#17252B',
    background: '#F5F3EE',
    surface: '#FFFFFF',
    backgroundElement: '#E9EEEA',
    backgroundSelected: '#DAE5E1',
    textSecondary: '#4F5D64',
    primary: '#176B67',
    primaryPressed: '#125653',
    border: '#DCE4E0',
    success: '#18794E',
    warning: '#9A5B00',
    error: '#B42318',
  },
  dark: {
    text: '#F1F5F3',
    background: '#111A20',
    surface: '#1B272E',
    backgroundElement: '#26343B',
    backgroundSelected: '#34464D',
    textSecondary: '#A9B6BC',
    primary: '#57B3A6',
    primaryPressed: '#43998F',
    border: '#34434A',
    success: '#55B884',
    warning: '#E0A341',
    error: '#F0786C',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = {
  sans: 'DMSans_400Regular',
  sansMedium: 'DMSans_500Medium',
  sansSemiBold: 'DMSans_600SemiBold',
  sansBold: 'DMSans_700Bold',
  mono: 'IBMPlexMono_400Regular',
} as const;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
