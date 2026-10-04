// src/outreach-wrong-prospect.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import { claimOutreachSend } from "../../src/outreach/outreach-send.js";
import { getProspectById } from "../../src/outreach/prospects.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";
const testProspectIds: string[] = [];
let testDraftId: string | null = null;

test("Outreach wrong prospect: rejects an outreach draft when it belongs to a different prospect", async () => {
  const prospectAId = await createTestProspect();

  testProspectIds.push(prospectAId);

  const prospectBId = await createTestProspect({
    companyName: "Heating and Cooling Test",
    website: "https://heatingandcooling.com",
    contactName: "Jerry Bob",
    contactEmail: "test@heatingcooling.com",
  });

  testProspectIds.push(prospectBId);

  const draftId = await createTestDraft({
    prospectId: prospectBId,
    recipientEmail: "test@heatingcooling.com",
  });

  testDraftId = draftId;

  const claim = await claimOutreachSend(prospectAId, draftId);

  assert.equal(claim.claimed, false);

  if (claim.claimed) {
    throw new Error(
      "Expected the outreach claim to be rejected because the draft belongs to a different prospect.",
    );
  }

  assert.equal(claim.reason, "Outreach draft not found.");

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

  const prospectA = await getProspectById(prospectAId);
  const prospectB = await getProspectById(prospectBId);

  assert.equal(prospectA?.stage, "draft_ready");
  assert.equal(prospectB?.stage, "draft_ready");
  assert.equal(finalDraft.send_status, "pending");
  assert.equal(finalDraft.review_status, "approved");
  assert.equal(finalDraft.sent_message_id, null);
  assert.equal(finalDraft.sent_at, null);
});

after(async () => {
  for (const testProspectId of testProspectIds) {
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
