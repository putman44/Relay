// tests/outreach/outreach-review-approve.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { getMessageDraftById } from "../../src/outreach/message-drafts.js";
import { approveOutreachDraft } from "../../src/outreach/outreach-review-actions.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach review approval: changes needs_review to approved", async (t) => {
  const prospectId = await createTestProspect({
    companyName: "Approval Test Company",
    contactEmail: "approval-test@devbytaylor.com",
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
    recipientEmail: "approval-test@devbytaylor.com",
    subject: "Approval test subject",
    body: "Approval test body.",
    reviewStatus: "needs_review",
  });

  const result = await approveOutreachDraft(prospectId, draftId);

  assert.equal(result.approved, true);

  const draft = await getMessageDraftById(draftId);

  assert.ok(draft);
  assert.equal(draft.review_status, "approved");
  assert.equal(draft.send_status, "pending");
});
