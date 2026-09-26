// src/gmail-success.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import { fakeGmailSend } from "./fake-gmail.js";
import { handleGmailSendResult } from "./handle-gmail-result.js";
import { claimOutreachSend } from "./outreach-send.js";
import { getProspectById } from "./prospects.js";

const gmailDraftId = `TEST_SUCCESS_${Date.now()}`;
let testProspectId: string | null = null;
let testDraftId: string | null = null;

test("marks the draft sent after a confirmed Gmail send", async () => {
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
      "devbytaylor",
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
      "Relay successful send test",
      "Controlled development-only successful send test.",
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

  const fakeGmailSuccess = await fakeGmailSend(false);

  await handleGmailSendResult(prospectId, draftId, fakeGmailSuccess);

  const draftResultAfterSend = await db.query(
    `
    SELECT
      send_status,
      sent_message_id,
      gmail_thread_id,
      sent_at,
      reconciliation_at
    FROM message_drafts
    WHERE id = $1;
  `,
    [draftId],
  );

  const finalDraft = draftResultAfterSend.rows[0];
  const prospect = await getProspectById(prospectId);

  assert.equal(prospect?.stage, "outreach_sent");
  assert.equal(finalDraft.send_status, "sent");
  assert.equal(finalDraft.sent_message_id, "TEST_MESSAGE_ID");
  assert.equal(finalDraft.gmail_thread_id, "TEST_THREAD_ID");
  assert.notEqual(finalDraft.sent_at, null);
  assert.equal(finalDraft.reconciliation_at, null);

  console.log("\nAll success assertions passed.");
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
