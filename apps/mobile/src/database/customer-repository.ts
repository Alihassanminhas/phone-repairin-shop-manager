import type { SQLiteDatabase } from 'expo-sqlite';

export type CustomerListItem = {
  id: string;
  name: string;
  phone: string;
  repairCount: number;
  outstandingPaisa: number;
};

export async function listCustomers(database: SQLiteDatabase, search = ''): Promise<CustomerListItem[]> {
  const query = `%${search.trim()}%`;
  return database.getAllAsync<CustomerListItem>(
    `SELECT c.id, c.name, c.phone, COUNT(DISTINCT r.id) AS repairCount,
      COALESCE(SUM(CASE WHEN r.final_cost_paisa IS NULL THEN 0 ELSE
        MAX(0, r.final_cost_paisa - COALESCE(p.total_paid, 0)) END), 0) AS outstandingPaisa
     FROM customers c
     LEFT JOIN repairs r ON r.customer_id = c.id
     LEFT JOIN (
        SELECT p.repair_id, SUM(p.amount_paisa - COALESCE(rv.reversed_paisa, 0)) AS total_paid FROM payments p
        LEFT JOIN (SELECT payment_id, SUM(amount_paisa) AS reversed_paisa FROM payment_reversals GROUP BY payment_id) rv ON rv.payment_id = p.id
        WHERE p.voided_at IS NULL GROUP BY p.repair_id
     ) p ON p.repair_id = r.id
     WHERE c.archived_at IS NULL AND (? = '%%' OR c.name LIKE ? OR c.phone LIKE ?)
     GROUP BY c.id ORDER BY c.name COLLATE NOCASE LIMIT 200`,
    query, query, query,
  );
}
