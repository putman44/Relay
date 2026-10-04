// scripts/create-test-draft.ts
import { db } from "../src/db.js";

const prospectId = "03336ca4-c95a-406f-96a3-066fad35e107";

async function main() {
  const result = await db.query(
    `
      INSERT INTO message_drafts (
        prospect_id,
        recipient_email,
        subject,
        body
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `,
    [
      prospectId,
      "test@devbytaylor.com",
      "Relay development outreach test",
      "This is a controlled development-only outreach draft.",
    ],
  );

  console.log(result.rows[0]);

  await db.end();
}

main().catch(async (error) => {
  console.error(error);
  await db.end();
  process.exit(1);
});
