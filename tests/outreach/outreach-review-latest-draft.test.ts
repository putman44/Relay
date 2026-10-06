// tests/outreach/outreach-review-latest-draft.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { getOutreachReview } from "../../src/outreach/outreach-review.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach review: returns the latest outreach draft", async (t) => {
  const prospectId = await createTestProspect({
    companyName: "Latest Draft Test Company",
    contactEmail: "latest-draft@devbytaylor.com",
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

  const olderDraftId = await createTestDraft({
    prospectId,
    recipientEmail: "latest-draft@devbytaylor.com",
    subject: "Older subject",
    body: "Older body.",
    reviewStatus: "needs_review",
  });

  const newerDraftId = await createTestDraft({
    prospectId,
    recipientEmail: "latest-draft@devbytaylor.com",
    subject: "Newer subject",
    body: "Newer body.",
    reviewStatus: "needs_review",
  });

  await db.query(
    `
      UPDATE message_drafts
      SET created_at = now() - interval '1 hour'
      WHERE id = $1;
    `,
    [olderDraftId],
  );

  await db.query(
    `
      UPDATE message_drafts
      SET created_at = now()
      WHERE id = $1;
    `,
    [newerDraftId],
  );

  const review = await getOutreachReview(prospectId);

  assert.ok(review);
  assert.ok(review.draft);

  assert.equal(review.draft.id, newerDraftId);
  assert.equal(review.draft.subject, "Newer subject");
  assert.equal(review.draft.body, "Newer body.");
});
