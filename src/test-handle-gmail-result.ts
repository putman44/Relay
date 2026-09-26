// src/test-handle-gmail-result.ts
import { strict as assert } from "node:assert";
import { db } from "./db.js";
import { fakeGmailSend } from "./fake-gmail.js";
import { handleGmailSendResult } from "./handle-gmail-result.js";
import { claimOutreachSend } from "./outreach-send.js";
import { getProspectById } from "./prospects.js";

const prospectId = "03336ca4-c95a-406f-96a3-066fad35e107";
const gmailDraftId = `TEST_SUCCESS_${Date.now()}`;

const main = async () => {
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

  const draftResult = await db.query(
    `
          INSERT INTO message_drafts (
            prospect_id,
            recipient_email,
            subject,
            body,
            gmail_draft_id,
            review_status
          )
          VALUES ($1, $2, $3, $4, $5, 'approved')
          RETURNING id;
        `,
    [
      prospectId,
      "test@devbytaylor.com",
      "Relay successful send test",
      "Controlled development-only reconciliation test.",
      gmailDraftId,
    ],
  );

  const draftId = draftResult.rows[0].id;

  console.log("Created draft:", draftId);

  const claim = await claimOutreachSend(prospectId, draftId);

  if (!claim.claimed) {
    throw new Error(`Could not claim draft: ${claim.reason}`);
  }

  const fakeGmailSuccess = await fakeGmailSend(true);

  await handleGmailSendResult(prospectId, draftId, fakeGmailSuccess);

  const draftResultAfterSend = await db.query(
    `
    SELECT send_status, send_error, reconciliation_at
    FROM message_drafts
    WHERE id = $1;
  `,
    [draftId],
  );

  const finalDraft = draftResultAfterSend.rows[0];
  const prospect = await getProspectById(prospectId);

  assert.equal(prospect?.stage, "send_reconciliation");
  assert.equal(finalDraft.send_status, "needs_reconciliation");
  assert.equal(finalDraft.send_error, "Simulated Gmail timeout");
  assert.notEqual(finalDraft.reconciliation_at, null);

  console.log("\nAll reconciliation assertions passed.");

  console.log("\nFinal draft state:");
  console.log(draftResultAfterSend.rows[0]);

  await db.end();
};

main().catch(async (error) => {
  console.log(error);
  await db.end();
  process.exit(1);
});
