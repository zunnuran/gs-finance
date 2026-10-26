import { runMigrations } from "../server/migrate";
import { pool } from "../server/db";
try {
  await runMigrations();
  console.log("Migrations applied successfully");
} finally {
  await pool.end();
}
