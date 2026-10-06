// tests/outreach/outreach-review-no-draft.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { getOutreachReview } from "../../src/outreach/outreach-review.js";
import { createTestProspect } from "../helpers/test-helpers.js";

test("Outreach review: returns the prospect with no draft", async (t) => {
  const prospectId = await createTestProspect({
    companyName: "No Draft Test Company",
    contactEmail: "no-draft@devbytaylor.com",
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

  const review = await getOutreachReview(prospectId);

  assert.ok(review);
  assert.equal(review.prospect.id, prospectId);
  assert.equal(review.prospect.companyName, "No Draft Test Company");
  assert.equal(review.draft, null);
});
