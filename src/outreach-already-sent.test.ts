// src/outreach-already-sent.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import { claimOutreachSend } from "./outreach-send.js";
import { getProspectById } from "./prospects.js";

const date = new Date();
const gmailDraftId = `TEST_GMAIL_ALREADY_SENT_${Date.now()}`;
let testProspectId: string | null = null;
let testDraftId: string | null = null;

test("rejects a draft because it was already sent", async () => {
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
            review_status,
            sent_message_id,
            sent_at
          )
          VALUES ($1, $2, $3, $4, $5, 'approved', $6, $7)
          RETURNING id;
        `,
    [
      prospectId,
      "test@devbytaylor.com",
      "Relay already-sent draft test",
      "Controlled development-only already-sent draft test.",
      gmailDraftId,
      "TEST_ALREADY_SENT",
      date,
    ],
  );

  const draftId = draftResult.rows[0].id;
  testDraftId = draftId;

  console.log("Created draft:", draftId);

  const claim = await claimOutreachSend(prospectId, draftId);

  assert.equal(claim.claimed, false);

  if (claim.claimed) {
    throw new Error("Expected the already-sent draft claim to be rejected.");
  }

  console.log("Claim rejected:", claim.reason);

  assert.equal(claim.reason, "Draft appears to have already been sent.");

  const draftResultAfterClaim = await db.query(
    `
    SELECT
      send_status,
      review_status,
      sent_message_id,
      sent_at
    FROM message_drafts
    WHERE id = $1;
  `,
    [draftId],
  );

  const finalDraft = draftResultAfterClaim.rows[0];
  assert.ok(finalDraft, "Expected draft to still exist");

  const prospect = await getProspectById(prospectId);

  assert.equal(prospect?.stage, "draft_ready");
  assert.equal(finalDraft.send_status, "pending");
  assert.equal(finalDraft.sent_message_id, "TEST_ALREADY_SENT");
  assert.equal(finalDraft.review_status, "approved");
  assert.notEqual(finalDraft.sent_at, null);

  console.log("\nAll Gmail already sent assertions passed.");
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
