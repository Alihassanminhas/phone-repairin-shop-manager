# Android app

This Expo Router app uses native React Native screens and SQLCipher SQLite. Expo Go is not supported because it does not include the configured SQLCipher native module.

## Run

From the workspace root:

```powershell
corepack pnpm install
corepack pnpm start
```

For a development build, associate the app with an Expo project and run `corepack pnpm dlx eas-cli build --project-dir apps/mobile --platform android --profile development`.

## Connect to the API

Set the public API origin before bundling. The value must be an HTTPS URL reachable by the Android device; it contains no secrets.

```powershell
$env:EXPO_PUBLIC_API_URL = 'https://api.example.com'
corepack pnpm android:bundle
```

The owner account starts with an out-of-band bootstrap code configured only on the API. After setup, save the one-time recovery code securely. Local repair records remain available while the device is offline.

## Build an installable APK

See [EAS profiles](eas.json) and the [workspace release instructions](../../README.md#android-apk). EAS signing credentials are required.
