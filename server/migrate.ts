import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { transaction } from "./db";
export async function runMigrations() {
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(871234)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const filename of readdirSync("migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (
        (
          await c.query("SELECT 1 FROM schema_migrations WHERE filename=$1", [
            filename,
          ])
        ).rows.length
      )
        continue;
      await c.query(readFileSync(resolve("migrations", filename), "utf8"));
      await c.query("INSERT INTO schema_migrations(filename) VALUES($1)", [
        filename,
      ]);
    }
  });
}
