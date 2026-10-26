import "dotenv/config";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
pg.types.setTypeParser(1082, (s) => s);
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
export const db = drizzle(pool);
export interface Connection {
  query(
    text: string,
    values?: any[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export async function transaction<T>(
  fn: (c: Connection) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
