// src/outreach-concurrent-claim.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import { claimOutreachSend } from "./outreach-send.js";
import { getProspectById } from "./prospects.js";
import { createTestDraft, createTestProspect } from "./test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;

test("two workers trying to claim the same draft at the same time.", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });
  testDraftId = draftId;

  console.log("Created draft:", draftId);

  const [claimA, claimB] = await Promise.all([
    claimOutreachSend(prospectId, draftId),
    claimOutreachSend(prospectId, draftId),
  ]);

  const claims = [claimA, claimB];
  console.log(claims);

  const successfulClaims = claims.filter((claim) => claim.claimed);
  const rejectedClaims = claims.filter((claim) => !claim.claimed);

  assert.equal(successfulClaims.length, 1);
  assert.equal(rejectedClaims.length, 1);

  const rejectedClaim = rejectedClaims[0];
  assert.ok(rejectedClaim, "Expected one rejected claim");

  if (rejectedClaim.claimed) {
    throw new Error("Expected this claim to be rejected");
  }

  assert.equal(
    rejectedClaim.reason,
    "Draft cannot be claimed. Current send status: sending",
  );

  const draftResultAfterClaims = await db.query(
    `
    SELECT send_status
    FROM message_drafts
    WHERE id = $1;
  `,
    [draftId],
  );

  const finalDraft = draftResultAfterClaims.rows[0];
  assert.ok(finalDraft, "Expected draft to still exist");

  const prospect = await getProspectById(prospectId);

  assert.equal(prospect?.stage, "draft_ready");
  assert.equal(finalDraft.send_status, "sending");
  
  console.log("\nAll concurrent-claim assertions passed.");
  console.log("\nFinal draft state:");
  console.log(draftResultAfterClaims.rows[0]);
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
