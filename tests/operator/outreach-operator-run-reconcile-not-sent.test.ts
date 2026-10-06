// tests/operator/outreach-operator-run-reconcile-not-sent.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ReconcileAndRequeueResult } from "../../src/jobs/outreach-reconciliation.js";
import { runOutreachOperator } from "../../src/operator/outreach-operator-run.js";

const jobId = "11111111-1111-4111-8111-111111111111";

test("Outreach operator runner: executes confirmed not-sent reconciliation", async () => {
  const now = new Date();

  const reconciliationResult: ReconcileAndRequeueResult = {
    reconciled: true,
    job: {
      id: jobId,
      draft_id: "draft-123",
      status: "pending",
      attempt_count: 1,
      available_at: now,
      claimed_at: null,
      last_error: "Test failure",
      created_at: now,
      updated_at: now,
    },
    draft: {
      id: "draft-123",
      prospect_id: "prospect-123",
      draft_type: "outreach",
      recipient_email: "test@devbytaylor.com",
      subject: "Test subject",
      body: "Test body",
      gmail_draft_id: "gmail-draft-123",
      gmail_thread_id: null,
      review_status: "approved",
      send_status: "pending",
      review_notes: null,
      send_error: null,
      reconciliation_at: null,
      sent_message_id: null,
      sent_at: null,
      created_at: now,
      updated_at: now,
    },
    prospect: {
      id: "prospect-123",
      stage: "draft_ready",
    },
  };

  let reconciledJobId: string | null = null;
  let outputValue: unknown = null;

  await runOutreachOperator(
    ["reconcile-not-sent", "--job", jobId, "--confirm-not-sent"],
    {
      inspectJob: async () => null,
      inspectQueue: async () => [],
      reconcileNotSent: async (jobId) => {
        reconciledJobId = jobId;
        return reconciliationResult;
      },
    },
    (value) => {
      outputValue = value;
    },
  );

  assert.equal(reconciledJobId, jobId);
  assert.deepEqual(outputValue, reconciliationResult);
});
