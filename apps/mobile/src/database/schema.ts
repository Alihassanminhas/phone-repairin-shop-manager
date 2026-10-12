import type { SQLiteDatabase } from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const DATABASE_VERSION = 5;
export const DATABASE_KEY_STORAGE_KEY = 'repair_manager_database_key';

/** Creates and upgrades the on-device schema before any screen reads data. */
export async function migrateDatabase(database: SQLiteDatabase): Promise<void> {
  const storedKey = await SecureStore.getItemAsync(DATABASE_KEY_STORAGE_KEY);
  const databaseKey = storedKey ?? bytesToHex(await Crypto.getRandomBytesAsync(32));
  if (!storedKey) await SecureStore.setItemAsync(DATABASE_KEY_STORAGE_KEY, databaseKey);

  // The key is generated as lowercase hex, so it cannot alter the PRAGMA statement.
  await database.execAsync(`PRAGMA key = '${databaseKey}';`);
  const cipher = await database.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version;');
  if (!cipher?.cipher_version) throw new Error('Encrypted local storage is unavailable in this app build. Reinstall the signed Android build to continue.');
  await database.execAsync('PRAGMA foreign_keys = ON;');
  const { user_version: currentVersion } = await database.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version;',
  ) ?? { user_version: 0 };

  if (currentVersion >= DATABASE_VERSION) return;

  await database.withTransactionAsync(async () => {
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS shop_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        shop_name TEXT NOT NULL,
        owner_name TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT 'en',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        alternate_phone TEXT,
        address TEXT,
        notes TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        sync_state TEXT NOT NULL DEFAULT 'local'
      );

      CREATE TABLE IF NOT EXISTS repairs (
        id TEXT PRIMARY KEY NOT NULL,
        receipt_number TEXT NOT NULL UNIQUE,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        brand TEXT NOT NULL,
        model TEXT NOT NULL,
        imei TEXT,
        reported_problem TEXT NOT NULL,
        inspection_notes TEXT,
        accessories TEXT,
        received_at TEXT NOT NULL,
        expected_delivery_date TEXT,
        delivered_at TEXT,
        status TEXT NOT NULL DEFAULT 'received'
          CHECK (status IN ('received','diagnosing','awaiting_approval','waiting_for_parts','in_repair','ready','delivered','cancelled')),
        estimated_cost_paisa INTEGER CHECK (estimated_cost_paisa IS NULL OR estimated_cost_paisa >= 0),
        final_cost_paisa INTEGER CHECK (final_cost_paisa IS NULL OR final_cost_paisa >= 0),
        internal_notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        sync_state TEXT NOT NULL DEFAULT 'local'
      );

      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY NOT NULL,
        repair_id TEXT NOT NULL REFERENCES repairs(id),
        amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
        currency TEXT NOT NULL DEFAULT 'PKR',
        method TEXT NOT NULL CHECK (method IN ('cash','bank_transfer','other')),
        transaction_reference TEXT,
        note TEXT,
        paid_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        voided_at TEXT,
        void_reason TEXT,
        created_at TEXT NOT NULL,
        sync_state TEXT NOT NULL DEFAULT 'local'
      );

      CREATE TABLE IF NOT EXISTS payment_reversals (
        id TEXT PRIMARY KEY NOT NULL,
        payment_id TEXT NOT NULL REFERENCES payments(id),
        repair_id TEXT NOT NULL REFERENCES repairs(id),
        amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
        reason TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        reversed_at TEXT NOT NULL,
        sync_state TEXT NOT NULL DEFAULT 'synced'
      );

      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY NOT NULL,
        invoice_code TEXT NOT NULL UNIQUE,
        repair_id TEXT NOT NULL UNIQUE REFERENCES repairs(id),
        issued_at TEXT NOT NULL,
        customer_name_snapshot TEXT NOT NULL,
        customer_phone_snapshot TEXT NOT NULL,
        repair_description_snapshot TEXT NOT NULL,
        total_paisa INTEGER NOT NULL CHECK (total_paisa >= 0),
        paid_paisa INTEGER NOT NULL CHECK (paid_paisa >= 0),
        balance_paisa INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        sync_state TEXT NOT NULL DEFAULT 'local'
      );

      CREATE TABLE IF NOT EXISTS repair_status_history (
        id TEXT PRIMARY KEY NOT NULL,
        repair_id TEXT NOT NULL REFERENCES repairs(id),
        from_status TEXT,
        to_status TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        base_version INTEGER,
        sync_state TEXT NOT NULL DEFAULT 'pending'
      );

      CREATE TABLE IF NOT EXISTS sync_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_repairs_received_at ON repairs(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_repairs_status ON repairs(status);
      CREATE INDEX IF NOT EXISTS idx_repairs_customer ON repairs(customer_id);
      CREATE INDEX IF NOT EXISTS idx_payments_repair_date ON payments(repair_id, paid_at);
      CREATE INDEX IF NOT EXISTS idx_invoices_issued_at ON invoices(issued_at DESC);
      CREATE INDEX IF NOT EXISTS idx_status_history_repair ON repair_status_history(repair_id, changed_at DESC);
    `);
  });

  if (currentVersion === 1) {
    await database.withTransactionAsync(async () => {
      await database.execAsync(`
        ALTER TABLE outbox ADD COLUMN base_version INTEGER;
        ALTER TABLE outbox ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'pending';
        ALTER TABLE customers ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE repairs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        CREATE TABLE IF NOT EXISTS sync_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      `);
    });
  }
  if (currentVersion > 0 && currentVersion < 4) {
    await database.withTransactionAsync(async () => {
      await database.execAsync(`ALTER TABLE repair_status_history ADD COLUMN created_at TEXT NOT NULL DEFAULT ''; UPDATE repair_status_history SET created_at = changed_at WHERE created_at = '';`);
    });
  }
  if (currentVersion > 0 && currentVersion < 5) {
    const reversalColumns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(payment_reversals);');
    await database.withTransactionAsync(async () => {
      if (!reversalColumns.some((column) => column.name === 'idempotency_key')) await database.execAsync('ALTER TABLE payment_reversals ADD COLUMN idempotency_key TEXT;');
      await database.execAsync('CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_reversal_idempotency ON payment_reversals(idempotency_key);');
    });
  }
  await database.execAsync(`PRAGMA user_version = ${DATABASE_VERSION};`);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
