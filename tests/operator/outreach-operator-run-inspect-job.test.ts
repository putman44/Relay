// tests/operator/outreach-operator-run-inspect-job.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { OutreachJobInspection } from "../../src/operator/outreach-operator-inspect.js";
import { runOutreachOperator } from "../../src/operator/outreach-operator-run.js";

const jobId = "11111111-1111-4111-8111-111111111111";

test("Outreach operator runner: inspects the requested job", async () => {
  const inspection: OutreachJobInspection = {
    jobId: jobId,
    jobStatus: "failed",
    attemptCount: 1,
    lastError: "Test failure",

    draftId: "draft-123",
    subject: "Test subject",
    recipientEmail: "test@devbytaylor.com",
    reviewStatus: "approved",
    sendStatus: "needs_reconciliation",
    gmailDraftId: "gmail-draft-123",
    sentMessageId: null,
    sentAt: null,

    prospectId: "prospect-123",
    companyName: "Test Company",
    contactEmail: "test@devbytaylor.com",
    prospectStage: "send_reconciliation",
  };

  let inspectedJobId: string | null = null;
  let outputValue: unknown = null;

  await runOutreachOperator(
    ["inspect", "--job", jobId],
    {
      inspectJob: async (jobId) => {
        inspectedJobId = jobId;
        return inspection;
      },
      inspectQueue: async () => [],
    },
    (value) => {
      outputValue = value;
    },
  );

  assert.equal(inspectedJobId, jobId);
  assert.deepEqual(outputValue, inspection);
});
