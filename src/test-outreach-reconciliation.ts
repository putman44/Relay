// src/test-outreach-reconciliation.ts
import { db } from "./db.js";
import {
  claimOutreachSend,
  markOutreachNeedsReconciliation,
} from "./outreach-send.js";
import { getProspectById } from "./prospects.js";

const prospectId = "03336ca4-c95a-406f-96a3-066fad35e107";
const gmailDraftId = `TEST_GMAIL_DRAFT_ID_${Date.now()}`;

async function main() {
  // Put our controlled prospect back into a sendable test state.
  await db.query(
    `
      UPDATE prospects
      SET
        stage = 'draft_ready',
        updated_at = now()
      WHERE id = $1;
    `,
    [prospectId],
  );

  // Create a fresh controlled draft.
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

  console.log("\nClaim result:");
  console.log(claim);

  if (!claim.claimed) {
    throw new Error(`Could not claim draft: ${claim.reason}`);
  }

  const reconciliation = await markOutreachNeedsReconciliation(
    prospectId,
    draftId,
    "Simulated Gmail timeout after send request.",
  );

  console.log("\nReconciliation result:");
  console.log(reconciliation);

  const prospect = await getProspectById(prospectId);
  console.log("\nProspect stage after reconciliation:");
  console.log(prospect?.stage);

  await db.end();
}

main().catch(async (error) => {
  console.error(error);
  await db.end();
  process.exit(1);
});
