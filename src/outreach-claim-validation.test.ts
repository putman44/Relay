// src/outreach-claim-validation.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import { claimOutreachSend } from "./outreach-send.js";
import { getProspectById } from "./prospects.js";

const gmailDraftId = `TEST_UNAPPROVED_${Date.now()}`;
let testProspectId: string | null = null;
let testDraftId: string | null = null;

test("rejects an unapproved outreach draft", async () => {
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
          VALUES ($1, $2, $3, $4, $5, 'needs_review')
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

  assert.equal(claim.claimed, false);

  if (claim.claimed) {
    throw new Error("Expected the unapproved draft claim to be rejected.");
  }

  console.log("Claim rejected:", claim.reason);

  assert.equal(
    claim.reason,
    "Draft must be approved. Current review status: needs_review",
  );

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
  assert.equal(finalDraft.review_status, "needs_review");
  assert.equal(finalDraft.sent_message_id, null);
  assert.equal(finalDraft.sent_at, null);

  console.log("\nAll unapproved-draft assertions passed.");
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
