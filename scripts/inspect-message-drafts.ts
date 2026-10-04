// scripts/inspect-message-drafts.ts
import { db } from "../src/db.js";

async function main() {
  const result = await db.query(`
    SELECT
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_name = 'message_drafts'
    ORDER BY ordinal_position;
  `);

  console.table(result.rows);

  await db.end();
}

main().catch(async (error) => {
  console.error(error);
  await db.end();
  process.exit(1);
});
