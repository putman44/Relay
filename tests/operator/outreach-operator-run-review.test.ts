// tests/operator/outreach-operator-run-review.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { OutreachReview } from "../../src/outreach/outreach-review.js";
import { runOutreachOperator } from "../../src/operator/outreach-operator-run.js";

const prospectId = "11111111-1111-4111-8111-111111111111";

test("Outreach operator runner: returns a prospect review", async () => {
  const review: OutreachReview = {
    prospect: {
      id: prospectId,
      companyName: "Review Company",
      website: "https://review.example",
      contactName: "Review Contact",
      contactEmail: "review@devbytaylor.com",
      stage: "draft_ready",
    },
    draft: null,
  };

  let reviewedProspectId: string | null = null;
  let outputValue: unknown = null;

  await runOutreachOperator(
    ["review", "--prospect", prospectId],
    {
      getReview: async (prospectId) => {
        reviewedProspectId = prospectId;
        return review;
      },
      inspectJob: async () => null,
      inspectQueue: async () => [],
    },
    (value) => {
      outputValue = value;
    },
  );

  assert.equal(reviewedProspectId, prospectId);
  assert.deepEqual(outputValue, review);
});
