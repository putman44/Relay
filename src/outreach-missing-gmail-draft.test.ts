// src/outreach-missing-gmail-draft.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import { claimOutreachSend } from "./outreach-send.js";
import { getProspectById } from "./prospects.js";
import { createTestDraft, createTestProspect } from "./test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;

test("Outreach missing Gmail draft: rejects an outreach draft without a Gmail draft ID", async () => {
  const prospectId = await createTestProspect();

  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
    gmailDraftId: null,
  });

  testDraftId = draftId;
  const claim = await claimOutreachSend(prospectId, draftId);

  assert.equal(claim.claimed, false);

  if (claim.claimed) {
    throw new Error(
      "Expected the draft without a Gmail draft ID to be rejected.",
    );
  }

  assert.equal(claim.reason, "Gmail draft ID is missing.");

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
  assert.equal(finalDraft.review_status, "approved");
  assert.equal(finalDraft.sent_message_id, null);
  assert.equal(finalDraft.sent_at, null);

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
