// tests/operator/outreach-operator-run-approve-rejected.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runOutreachOperator } from "../../src/operator/outreach-operator-run.js";

const prospectId = "11111111-1111-4111-8111-111111111111";
const draftId = "22222222-2222-4222-8222-222222222222";

test("Outreach operator runner: rejects an unsuccessful draft approval", async () => {
  await assert.rejects(
    runOutreachOperator(
      [
        "approve",
        "--prospect",
        prospectId,
        "--draft",
        draftId,
        "--confirm-approval",
      ],
      {
        approveDraft: async () => ({
          approved: false,
          reason: "Outreach draft cannot be approved.",
        }),
        inspectJob: async () => null,
        inspectQueue: async () => [],
      },
      () => undefined,
    ),
    { message: "Outreach draft cannot be approved." },
  );
});
