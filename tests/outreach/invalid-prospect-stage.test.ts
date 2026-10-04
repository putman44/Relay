// src/invalid-prospect-stage.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import { claimOutreachSend } from "../../src/outreach-send.js";
import { getProspectById } from "../../src/prospects.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;

test("Invalid prospect stage: rejects an outreach draft when the prospect is not draft_ready", async () => {
  const prospectId = await createTestProspect({
    stage: "researching",
  });

  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });

  testDraftId = draftId;

  const claim = await claimOutreachSend(prospectId, draftId);

  assert.equal(claim.claimed, false);

  if (claim.claimed) {
    throw new Error(
      "Expected the outreach claim to be rejected while the prospect is researching.",
    );
  }

  assert.equal(
    claim.reason,
    "Prospect stage must be draft_ready. Current stage: researching",
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

  assert.equal(prospect?.stage, "researching");
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
