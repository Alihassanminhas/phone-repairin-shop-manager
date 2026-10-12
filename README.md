# Mobile Repair Shop Manager

Android app for one mobile repair shop. The app records customers, phone repairs, payments, and invoices locally first so the shop can continue working offline. It exports saved sales records to Excel. An optional owner account synchronizes records to the API when connectivity is available.

## Features implemented

- Expo SDK 57 / React Native Android app with strict TypeScript.
- SQLCipher SQLite local database; encryption key and rotating refresh credential in Android SecureStore. Access tokens remain in memory.
- Offline repair intake, customer reuse, repair status updates, estimates and final costs, payment recording, invoice snapshots, in-app records, and invoice/monthly-payment Excel exports.
- Immutable partial payment adjustments with a reason, preserved in the payment history and monthly Excel ledger.
- Transactional outbox for customer/repair/payment/status/invoice changes, idempotent API push, version conflict responses, and resumable paged pull.
- Single-owner account setup using an out-of-band bootstrap code, sign-in, password recovery code, token rotation, session revocation, and owner-scoped records.
- PostgreSQL/Neon Prisma schema and initial migration.

The API and cloud sync have strict unit/type checks, but have not been deployed against a live Neon database. Sync conflicts can be reviewed and explicitly rebased, replaced with the server copy, or retained on the phone without uploading.

## Workspace commands

```powershell
corepack pnpm install
corepack pnpm start
corepack pnpm dev:api
corepack pnpm test
corepack pnpm typecheck:all
corepack pnpm build:api
corepack pnpm android:bundle
```

Expo Go cannot load the SQLCipher native module. Use an EAS development build or install the signed APK to test the actual database behavior.

## Backend setup

Follow [backend deployment and sync notes](docs/backend-sync.md). Copy `.env.example` to `apps/api/.env`, set Neon pooled `DATABASE_URL`, direct `DIRECT_URL`, a random `JWT_ACCESS_SECRET`, `RATE_LIMIT_HASH_SECRET`, and the one-time `BOOTSTRAP_CODE`. Apply migrations with `corepack pnpm --filter @repair-shop/api db:migrate` after configuring the production environment.

## Android APK

EAS build profiles are in [apps/mobile/eas.json](apps/mobile/eas.json). Configure an Expo account and signing credentials, set `EXPO_PUBLIC_API_URL` to the deployed HTTPS API origin, then run:

```powershell
corepack pnpm dlx eas-cli login
corepack pnpm dlx eas-cli build --project-dir apps/mobile --platform android --profile preview
```

The preview profile creates an installable APK. EAS signing credentials and a project association are required; no signed APK is included in this source workspace.
