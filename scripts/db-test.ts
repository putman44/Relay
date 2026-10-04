// scripts/db-test.ts
import "dotenv/config";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({
  connectionString,
});

async function main() {
  const result = await pool.query(`
    SELECT
      current_database() AS database_name,
      now() AS database_time;
  `);

  console.log(result.rows);

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
