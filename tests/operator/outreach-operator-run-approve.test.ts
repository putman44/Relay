// tests/operator/outreach-operator-run-approve.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ApproveOutreachDraftResult } from "../../src/outreach/outreach-review-actions.js";
import { runOutreachOperator } from "../../src/operator/outreach-operator-run.js";

const prospectId = "11111111-1111-4111-8111-111111111111";
const draftId = "22222222-2222-4222-8222-222222222222";

test("Outreach operator runner: executes confirmed draft approval", async () => {
  const now = new Date();
  const approvalResult: ApproveOutreachDraftResult = {
    approved: true,
    draft: {
      id: draftId,
      prospect_id: prospectId,
      draft_type: "outreach",
      recipient_email: "approve@devbytaylor.com",
      subject: "Approval subject",
      body: "Approval body",
      gmail_draft_id: "gmail-draft-approval",
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
  };

  let approvedIds: [string, string] | null = null;
  let outputValue: unknown = null;

  await runOutreachOperator(
    [
      "approve",
      "--prospect",
      prospectId,
      "--draft",
      draftId,
      "--confirm-approval",
    ],
    {
      approveDraft: async (prospectId, draftId) => {
        approvedIds = [prospectId, draftId];
        return approvalResult;
      },
      inspectJob: async () => null,
      inspectQueue: async () => [],
    },
    (value) => {
      outputValue = value;
    },
  );

  assert.deepEqual(approvedIds, [prospectId, draftId]);
  assert.deepEqual(outputValue, approvalResult);
});
