// src/outreach-wrong-prospect.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import { claimOutreachSend } from "./outreach-send.js";
import { getProspectById } from "./prospects.js";

const gmailDraftId = `TEST_WRONG_PROSPECT_${Date.now()}`;
const testProspectIds: string[] = [];
let testDraftId: string | null = null;

test("rejects an outreach draft when it belongs to a different prospect", async () => {
  const prospectAInsertResult = await db.query<{ id: string }>(
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

  const createdProspectA = prospectAInsertResult.rows[0];

  assert.ok(createdProspectA, "Expected prospect insert to return a row");

  const prospectAId = createdProspectA.id;
  testProspectIds.push(prospectAId);

  const prospectBInsertResult = await db.query<{ id: string }>(
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
      "Heating and Cooling Test",
      "https://heatingandcooling.com",
      "Jerry Bob",
      "test@heatingcooling.com",
    ],
  );

  const createdProspectB = prospectBInsertResult.rows[0];

  assert.ok(createdProspectB, "Expected prospect insert to return a row");

  const prospectBId = createdProspectB.id;
  testProspectIds.push(prospectBId);

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
      prospectBId,
      "test@heatingcooling.com",
      "Relay wrong-prospect test",
      "Controlled development-only test for a draft assigned to another prospect.",
      gmailDraftId,
    ],
  );

  const draftId = draftResult.rows[0].id;
  testDraftId = draftId;

  console.log("Created draft:", draftId);

  const claim = await claimOutreachSend(prospectAId, draftId);

  assert.equal(claim.claimed, false);

  if (claim.claimed) {
    throw new Error(
      "Expected the outreach claim to be rejected because the draft belongs to a different prospect.",
    );
  }

  console.log("Claim rejected:", claim.reason);

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

  console.log("\nAll wrong-prospect assertions passed.");
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
