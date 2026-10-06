// tests/outreach/outreach-review-missing-prospect.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { getOutreachReview } from "../../src/outreach/outreach-review.js";

test("Outreach review: returns null when the prospect does not exist", async () => {
  const review = await getOutreachReview(
    "11111111-1111-4111-8111-111111111111",
  );

  assert.equal(review, null);
});
