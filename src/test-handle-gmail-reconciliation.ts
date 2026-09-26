// src/test-handle-gmail-reconciliation.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import { fakeGmailSend } from "./fake-gmail.js";
import { handleGmailSendResult } from "./handle-gmail-result.js";
import { claimOutreachSend } from "./outreach-send.js";
import { getProspectById } from "./prospects.js";

// const prospectId = "03336ca4-c95a-406f-96a3-066fad35e107";
const gmailDraftId = `TEST_RECONCILIATION_${Date.now()}`;

test("marks an uncertain Gmail send for reconciliation", async () => {
  const prospectInsertResult = await db.query<{ id: string }>(
    `
   INSERT INTO prospects (
     company_name,
     website,
     contact_name,
     contact_email,
     stage
   )
   VALUES ($1, $2, $3, $4, 'draft_ready')
   RETURNING id;
 `,
    [
      "Relay Reconciliation Test",
      "https://devbytaylor.com",
      "Taylor Putman",
      "test@devbytaylor.com",
    ],
  );

  const createdProspect = prospectInsertResult.rows[0];

  assert.ok(createdProspect, "Expected prospect insert to return a row");

  const prospectId = createdProspect.id;

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
      "Relay reconciliation test",
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

  const fakeGmailResult = await fakeGmailSend(true);
  await handleGmailSendResult(prospectId, draftId, fakeGmailResult);

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
});

after(async () => {
  await db.end();
});
