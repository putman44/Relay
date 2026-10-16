// tests/operator/outreach-operator-run-review-missing.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runOutreachOperator } from "../../src/operator/outreach-operator-run.js";

const prospectId = "11111111-1111-4111-8111-111111111111";

test("Outreach operator runner: rejects a missing prospect review", async () => {
  await assert.rejects(
    runOutreachOperator(
      ["review", "--prospect", prospectId],
      {
        getReview: async () => null,
        inspectJob: async () => null,
        inspectQueue: async () => [],
      },
      () => undefined,
    ),
    { message: `Outreach prospect not found: ${prospectId}` },
  );
});
