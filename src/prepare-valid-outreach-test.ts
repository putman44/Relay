// src/prepare-valid-outreach-test.ts
import { db } from "./db.js";

const prospectId = "03336ca4-c95a-406f-96a3-066fad35e107";
const draftId = "feb1e8e5-b104-4a4b-aa03-3ca3e2c7b9b3";

async function main() {
  await db.query(
    `
      UPDATE prospects
      SET
        stage = 'draft_ready',
        updated_at = now()
      WHERE id = $1;
    `,
    [prospectId],
  );

  await db.query(
    `
      UPDATE message_drafts
      SET
        review_status = 'approved',
        gmail_draft_id = 'TEST_GMAIL_DRAFT_ID',
        updated_at = now()
      WHERE id = $1;
    `,
    [draftId],
  );

  console.log("Controlled outreach test record prepared.");

  await db.end();
}

main().catch(async (error) => {
  console.error(error);
  await db.end();
  process.exit(1);
});
