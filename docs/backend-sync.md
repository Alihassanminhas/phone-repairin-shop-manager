# Backend, sync, and release operations

## API and database

The API is a single-shop, single-owner service. It uses Express with Helmet, a strict JSON body limit, CORS allowlisting, validated request schemas, generic credential errors, and owner identity taken only from the verified access token. The Prisma schema uses owner-scoped foreign keys and indexes, integer paisa, immutable payment/reversal events, audit events, and unique idempotency keys.

1. Create a Neon PostgreSQL project. Configure `DATABASE_URL` with the pooled connection string for API runtime and `DIRECT_URL` with the direct connection string for Prisma migration deployment.
2. Copy `.env.example` to `apps/api/.env`. Generate independent random secrets for `JWT_ACCESS_SECRET`, `RATE_LIMIT_HASH_SECRET`, and `BOOTSTRAP_CODE`; each must have at least 32 characters. Do not use the same secret for multiple variables or expose them through Expo.
3. Set `NODE_ENV=production`, `PORT`, and any exact browser origins in `CORS_ORIGINS`. Set `TRUST_PROXY_HOPS` only to the number of trusted reverse-proxy hops in front of the API.
4. Deploy and apply the checked-in migration with `corepack pnpm --filter @repair-shop/api db:migrate`. Start the service with `corepack pnpm --filter @repair-shop/api start`. Confirm `/health/live` and `/health/ready`.
5. Build the mobile app with `EXPO_PUBLIC_API_URL` set to the HTTPS API origin. In Settings, use the out-of-band bootstrap code once to create the owner account. The app displays a random recovery code one time; save it outside the device.
6. Remove the bootstrap code from the deployment environment after owner setup. The owner singleton prevents a second account from being created even if that code is accidentally retained.

Access JWTs expire after 15 minutes by default and stay in app memory. Refresh tokens are opaque random values; the API stores only SHA-256 hashes and the Android app stores the current refresh token in SecureStore. Refresh rotates the token, replay revokes its family, and password recovery revokes all sessions and rotates the recovery code. A failed refresh stops cloud sync but keeps local SQLCipher data and its outbox.

## Sync protocol

- Local writes and their outbox operations commit in the same SQLite transaction. The outbox is ordered by creation time and SQLite row ID; customer and repair creation precede dependent payment events.
- The encrypted local database binds to the first successfully authenticated owner. A different owner cannot push the phone’s existing records to a different shop account.
- `POST /v1/sync/push` accepts at most 100 validated operations. A unique `(ownerId, operationId)` records each result, so retrying an acknowledged operation cannot create a second payment, invoice, or status event.
- Mutable customers and repairs carry a base version. A mismatch is stored as a conflict result and the local outbox row is retained with `sync_state=conflict`; the API never resolves competing financial edits with last-write-wins.
- Payments and partial reversals are immutable events. The API row-locks each repair/payment while checking the final-cost and remaining-payment invariants; replays use stable operation and payment idempotency keys.
- `GET /v1/sync/pull` returns owner-filtered pages with a per-entity keyset cursor. The app applies each page in a local transaction and stores the next cursor in SQLite. Local records with pending/conflict outbox rows are not overwritten by pulled snapshots.
- Network failures increment attempts and retain the operation. Sync is currently foreground/manual and runs after account sign-in; Android background scheduling is not configured.

The Settings screen lists conflicts and offers safe rebase or use-server choices for supported customer, repair, and status changes. Financial and invoice conflicts cannot be merged automatically; the owner can retain them on this phone without uploading. Test push/pull and concurrency against PostgreSQL before production use; type checks and local unit tests do not replace database integration tests.

## Data recovery and privacy

The SQLite database is encrypted with SQLCipher and a random key held in SecureStore. Android backup is disabled for the app. If the app is uninstalled or the key is lost, local-only records cannot be recovered from that device; records already pushed to the owner account can be pulled after signing in on a new installation. This workspace does not yet implement an encrypted local backup/export-and-restore flow or an account-wide data export endpoint. Excel workbooks are readable business records and should be shared/stored with the same care as customer invoices.

## Build and release

1. Run `corepack pnpm test`, `corepack pnpm typecheck:all`, and `corepack pnpm android:bundle`.
2. Configure the Expo project using `corepack pnpm dlx eas-cli init --project-dir apps/mobile`, then configure Android signing credentials through EAS. Keep credentials out of the repository and record who controls the signing identity.
3. Set `EXPO_PUBLIC_API_URL` to the production HTTPS API origin and build an internal APK with `corepack pnpm dlx eas-cli build --project-dir apps/mobile --platform android --profile preview`.
4. Install the signed APK on a real Android device. Verify fresh SQLCipher setup, airplane-mode repair/payment/invoice/export, reconnect and push/pull, payment replay, stale-version conflict reporting, password reset, and session revocation.
5. Preserve the EAS Android signing identity for every future update. Review the generated APK, package name `com.mobilerepair.manager`, version, permissions, and release notes before distributing it.

No Expo project ID, Neon credentials, production domain, or signing identity is currently configured in this workspace, so a production API migration or signed APK has not been produced here.
