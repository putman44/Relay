// tests/outreach/outreach-review-by-prospect.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { db } from "../../src/db.js";
import { getOutreachReview } from "../../src/outreach/outreach-review.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach review: returns the prospect and outreach draft", async (t) => {
  const prospectId = await createTestProspect({
    companyName: "Review Test Company",
    website: "https://review-test.example",
    contactName: "Review Test",
    contactEmail: "review-test@devbytaylor.com",
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
    recipientEmail: "review-test@devbytaylor.com",
    subject: "Review test subject",
    body: "Review test body.",
    reviewStatus: "needs_review",
  });

  const review = await getOutreachReview(prospectId);

  assert.ok(review);

  assert.equal(review.prospect.id, prospectId);
  assert.equal(review.prospect.companyName, "Review Test Company");
  assert.equal(review.prospect.contactEmail, "review-test@devbytaylor.com");

  assert.ok(review.draft);
  assert.equal(review.draft.id, draftId);
  assert.equal(review.draft.subject, "Review test subject");
  assert.equal(review.draft.body, "Review test body.");
  assert.equal(review.draft.reviewStatus, "needs_review");
});
