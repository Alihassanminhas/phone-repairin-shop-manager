# Development status

## Implemented

- Native Android app with encrypted local SQLCipher database, repair/customer/payment/invoice screens, and individual/monthly Excel exports.
- Shared strict TypeScript schemas and domain rules.
- Express/Prisma owner auth and owner-filtered record endpoints, plus Neon PostgreSQL schema and initial migration.
- Android owner bootstrap, login, recovery-code password reset, SecureStore refresh-token rotation, and sign-out.
- Transactional local sync outbox, bounded idempotent push, per-record paginated pull cursor, local apply transaction, and retained version conflicts.
- Conflict review with explicit rebase, use-server, or local-only choices; local-only financial conflicts remain on the device and are excluded from upload.
- Partial payment reversals are audited locally, synchronized as idempotent events, and included as negative monthly ledger rows.
- EAS APK profiles and backend/sync/release operations guide.

## Remaining to meet the full approved plan

- Finish entity tombstones and online/offline financial race handling.
- Deploy Neon/API and exercise integration, replay, authorization, and concurrency cases against PostgreSQL. No database credentials or service are configured here.
- Add connectivity-triggered/background sync; current sync is manual and after login.
- Complete Urdu translations and RTL layouts, expand Excel reports to repair/customer/balance/daily summaries, and add encrypted local backup/restore.
- Set up an Expo project/signing identity, produce and install a signed APK, and run real-device release checks. No signed APK exists yet.

See [backend and sync operations](backend-sync.md) for the deployed configuration, token lifecycle, sync protocol, recovery limits, and release steps.

## Verification commands

```powershell
corepack pnpm test
corepack pnpm typecheck:all
corepack pnpm build:api
corepack pnpm android:bundle
```
