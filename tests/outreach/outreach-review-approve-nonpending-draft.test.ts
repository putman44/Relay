// tests/outreach/outreach-review-approve-nonpending-draft.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { getMessageDraftById } from "../../src/outreach/message-drafts.js";
import { approveOutreachDraft } from "../../src/outreach/outreach-review-actions.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach review approval: rejects a draft that is not pending", async (t) => {
  const prospectId = await createTestProspect({
    companyName: "Nonpending Approval Company",
    contactEmail: "nonpending-approval@devbytaylor.com",
  });

  t.after(async () => {
    await db.query(
      `
        DELETE FROM prospects
        WHERE id = $1;
      `,
      [prospectId],
    );
  });

  const draftId = await createTestDraft({
    prospectId,
    recipientEmail: "nonpending-approval@devbytaylor.com",
    reviewStatus: "needs_review",
  });

  await db.query(
    `
      UPDATE message_drafts
      SET send_status = 'needs_reconciliation'
      WHERE id = $1;
    `,
    [draftId],
  );

  const result = await approveOutreachDraft(prospectId, draftId);

  assert.equal(result.approved, false);

  const draft = await getMessageDraftById(draftId);

  assert.ok(draft);
  assert.equal(draft.review_status, "needs_review");
  assert.equal(draft.send_status, "needs_reconciliation");
});
