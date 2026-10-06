// tests/outreach/outreach-review-approve-already-approved.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { getMessageDraftById } from "../../src/outreach/message-drafts.js";
import { approveOutreachDraft } from "../../src/outreach/outreach-review-actions.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach review approval: rejects an already approved draft", async (t) => {
  const prospectId = await createTestProspect({
    companyName: "Already Approved Company",
    contactEmail: "already-approved@devbytaylor.com",
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
    recipientEmail: "already-approved@devbytaylor.com",
    reviewStatus: "approved",
  });

  const result = await approveOutreachDraft(prospectId, draftId);

  assert.equal(result.approved, false);

  const draft = await getMessageDraftById(draftId);

  assert.ok(draft);
  assert.equal(draft.review_status, "approved");
});
