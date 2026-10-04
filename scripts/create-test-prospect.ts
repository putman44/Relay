// scripts/create-test-prospect.ts
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
  const result = await pool.query(
    `
      INSERT INTO prospects (
        company_name,
        website,
        contact_name,
        contact_email
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `,
    [
      "Relay Development Test",
      "https://devbytaylor.com",
      "Taylor Test",
      "test@devbytaylor.com",
    ],
  );

  console.log(result.rows[0]);

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
