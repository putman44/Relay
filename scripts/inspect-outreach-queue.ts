// scripts/inspect-outreach-queue.ts

import "dotenv/config";

import { db } from "../src/db.js";

async function main(): Promise<void> {
  const result = await db.query(`
    SELECT
      j.id AS job_id,
      j.status AS job_status,
      j.attempt_count,
      j.available_at,
      j.available_at <= now() AS ready_now,
      d.id AS draft_id,
      d.recipient_email,
      d.subject,
      d.review_status,
      d.send_status,
      d.gmail_draft_id,
      p.company_name,
      p.contact_email,
      p.stage AS prospect_stage
    FROM outreach_jobs j
    JOIN message_drafts d
      ON d.id = j.draft_id
    JOIN prospects p
      ON p.id = d.prospect_id
    WHERE j.status IN ('pending', 'processing')
    ORDER BY j.available_at ASC, j.created_at ASC;
  `);

  console.table(result.rows);

  await db.end();
}

main().catch(async (error) => {
  console.error(error);
  await db.end();
  process.exit(1);
});
