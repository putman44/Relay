// scripts/run-migration.ts
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
const migrationFile = process.argv[2];

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

if (!migrationFile) {
  throw new Error(
    "Migration file required. Example: npx tsx src/run-migration.ts migrations/002_create_message_drafts.sql",
  );
}

const pool = new Pool({
  connectionString,
});

async function main() {
  const migrationFile = process.argv[2];

  if (!migrationFile) {
    throw new Error(
      "Migration file required. Example: npx tsx src/run-migration.ts migrations/002_create_message_drafts.sql",
    );
  }

  const sql = await readFile(migrationFile, "utf8");

  await pool.query(sql);

  console.log(`Migration completed: ${migrationFile}`);

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
