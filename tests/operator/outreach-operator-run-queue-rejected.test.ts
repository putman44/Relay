// tests/operator/outreach-operator-run-queue-rejected.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runOutreachOperator } from "../../src/operator/outreach-operator-run.js";

const prospectId = "11111111-1111-4111-8111-111111111111";
const draftId = "22222222-2222-4222-8222-222222222222";

test("Outreach operator runner: rejects unsuccessful draft queueing", async () => {
  await assert.rejects(
    runOutreachOperator(
      [
        "queue",
        "--prospect",
        prospectId,
        "--draft",
        draftId,
        "--confirm-queue",
      ],
      {
        inspectJob: async () => null,
        inspectQueue: async () => [],
        queueDraft: async () => ({
          queued: false,
          reason: "Outreach draft cannot be queued.",
        }),
      },
      () => undefined,
    ),
    { message: "Outreach draft cannot be queued." },
  );
});
