import type { SQLiteDatabase } from 'expo-sqlite';

/** Binds the encrypted local database to one owner before any cloud sync can run. */
export async function bindLocalRecordsToOwner(database: SQLiteDatabase, ownerId: string): Promise<void> {
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const existing = await transaction.getFirstAsync<{ value: string }>("SELECT value FROM sync_metadata WHERE key = 'cloud_owner_id'");
    if (existing && existing.value !== ownerId) {
      throw new Error('This phone’s local records are already linked to another shop account. Sign in with that account before syncing.');
    }
    if (!existing) await transaction.runAsync("INSERT INTO sync_metadata (key, value) VALUES ('cloud_owner_id', ?)", ownerId);
  });
}

export async function getBoundLocalOwnerId(database: SQLiteDatabase): Promise<string | null> {
  const binding = await database.getFirstAsync<{ value: string }>("SELECT value FROM sync_metadata WHERE key = 'cloud_owner_id'");
  return binding?.value ?? null;
}
