// tests/operator/outreach-operator-run-queue.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { QueueApprovedOutreachDraftResult } from "../../src/outreach/outreach-review-actions.js";
import { runOutreachOperator } from "../../src/operator/outreach-operator-run.js";

const prospectId = "11111111-1111-4111-8111-111111111111";
const draftId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";

test("Outreach operator runner: executes confirmed draft queueing", async () => {
  const now = new Date();
  const queueResult: QueueApprovedOutreachDraftResult = {
    queued: true,
    job: {
      id: jobId,
      draft_id: draftId,
      status: "pending",
      attempt_count: 0,
      available_at: now,
      claimed_at: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    },
  };

  let queuedIds: [string, string] | null = null;
  let outputValue: unknown = null;

  await runOutreachOperator(
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
      queueDraft: async (prospectId, draftId) => {
        queuedIds = [prospectId, draftId];
        return queueResult;
      },
    },
    (value) => {
      outputValue = value;
    },
  );

  assert.deepEqual(queuedIds, [prospectId, draftId]);
  assert.deepEqual(outputValue, queueResult);
});
