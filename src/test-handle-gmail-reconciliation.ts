// src/test-handle-gmail-reconciliation.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import { fakeGmailSend } from "./fake-gmail.js";
import { handleGmailSendResult } from "./handle-gmail-result.js";
import { claimOutreachSend } from "./outreach-send.js";
import { getProspectById } from "./prospects.js";

const gmailDraftId = `TEST_RECONCILIATION_${Date.now()}`;
let testProspectId: string | null = null;
let testDraftId: string | null = null;

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
  testProspectId = prospectId;


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
  testDraftId = draftId;

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
  if (testProspectId) {
    await db.query(
      `
        DELETE FROM prospects
        WHERE id = $1;
      `,
      [testProspectId],
    );
  }

  if (testDraftId) {
    const remainingDraft = await db.query(
      `
        SELECT id
        FROM message_drafts
        WHERE id = $1;
      `,
      [testDraftId],
    );

    assert.equal(
      remainingDraft.rowCount,
      0,
      "Expected draft to be deleted by ON DELETE CASCADE",
    );
  }

  await db.end();
});
