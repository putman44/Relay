// tests/operator/outreach-operator-run-inspect-queue.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { OutreachJobInspection } from "../../src/operator/outreach-operator-inspect.js";
import { runOutreachOperator } from "../../src/operator/outreach-operator-run.js";

test("Outreach operator runner: inspects the default queue", async () => {
  const queue: OutreachJobInspection[] = [
    {
      jobId: "job-123",
      jobStatus: "pending",
      attemptCount: 0,
      lastError: null,

      draftId: "draft-123",
      subject: "Test subject",
      recipientEmail: "test@devbytaylor.com",
      reviewStatus: "approved",
      sendStatus: "pending",
      gmailDraftId: "gmail-draft-123",
      sentMessageId: null,
      sentAt: null,

      prospectId: "prospect-123",
      companyName: "Test Company",
      contactEmail: "test@devbytaylor.com",
      prospectStage: "draft_ready",
    },
  ];

  let inspectJobCalled = false;
  let inspectQueueCalled = false;
  let outputValue: unknown = null;

  await runOutreachOperator(
    ["inspect"],
    {
      inspectJob: async () => {
        inspectJobCalled = true;
        return null;
      },
      inspectQueue: async () => {
        inspectQueueCalled = true;
        return queue;
      },
    },
    (value) => {
      outputValue = value;
    },
  );

  assert.equal(inspectJobCalled, false);
  assert.equal(inspectQueueCalled, true);
  assert.deepEqual(outputValue, queue);
});
