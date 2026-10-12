import * as SecureStore from 'expo-secure-store';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { DATABASE_KEY_STORAGE_KEY } from '@/database/schema';
const transactionQueues = new WeakMap<SQLiteDatabase, Promise<void>>();

/**
 * Runs a serialized write transaction on a separately opened connection.
 * SQLCipher keys and SQLite foreign-key settings are connection-local, so they
 * must be initialized before beginning the transaction.
 */
export async function withEncryptedExclusiveTransaction<T>(
  database: SQLiteDatabase,
  task: (transaction: SQLiteDatabase) => Promise<T>,
): Promise<T> {
  const previousTransaction = transactionQueues.get(database) ?? Promise.resolve();
  let releaseTransaction!: () => void;
  const transactionGate = new Promise<void>((resolve) => { releaseTransaction = resolve; });
  const queuedTransaction = previousTransaction.then(() => transactionGate);
  transactionQueues.set(database, queuedTransaction);

  await previousTransaction;
  try {
    const encryptionKey = await SecureStore.getItemAsync(DATABASE_KEY_STORAGE_KEY);
    if (!encryptionKey || !/^[a-f0-9]{64}$/i.test(encryptionKey)) {
      throw new Error('The encrypted shop database key is unavailable. Reinstall the app to create a new local database.');
    }

    const separatorIndex = database.databasePath.lastIndexOf('/');
    if (separatorIndex < 0) throw new Error('Could not determine the encrypted database location.');
    const databaseName = database.databasePath.slice(separatorIndex + 1);
    const databaseDirectory = database.databasePath.slice(0, separatorIndex);
    const transactionDatabase = await openDatabaseAsync(
      databaseName,
      { ...database.options, useNewConnection: true },
      databaseDirectory,
    );

    try {
      await transactionDatabase.execAsync(`PRAGMA key = '${encryptionKey}';`);
      const cipher = await transactionDatabase.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version;');
      if (!cipher?.cipher_version) throw new Error('Encrypted local storage is unavailable in this app build.');
      await transactionDatabase.execAsync('PRAGMA foreign_keys = ON;');
      await transactionDatabase.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM sqlite_master;');
      await transactionDatabase.execAsync('BEGIN IMMEDIATE;');

      try {
        const result = await task(transactionDatabase);
        await transactionDatabase.execAsync('COMMIT;');
        return result;
      } catch (error) {
        await transactionDatabase.execAsync('ROLLBACK;').catch(() => undefined);
        throw error;
      }
    } finally {
      await transactionDatabase.closeAsync();
    }
  } finally {
    releaseTransaction();
    if (transactionQueues.get(database) === queuedTransaction) transactionQueues.delete(database);
  }
}
