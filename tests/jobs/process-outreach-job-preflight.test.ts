import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import { GmailPreflightError } from "../../src/gmail/gmail-preflight-error.js";
import { createVerifiedGmailDraftSender } from "../../src/gmail/gmail-verified-draft-sender.js";
import { createOutreachJob } from "../../src/jobs/outreach-jobs.js";
import { NonRetryableOutreachJobError } from "../../src/jobs/non-retryable-job-error.js";
import { processOutreachJob } from "../../src/jobs/process-outreach-job.js";
import { runOutreachWorkerOnce } from "../../src/jobs/outreach-worker.js";
import { blockOutreachAfterPreflight } from "../../src/outreach/outreach-send.js";
import { createTestDraft, createTestProspect } from "../helpers/test-helpers.js";

after(async () => { await db.end(); });

test("Processor preflight: returns blocked draft to pending Needs Edit without send reconciliation or retry", async (t) => {
  const prospectId = await createTestProspect();
  t.after(async () => { await db.query("DELETE FROM prospects WHERE id = $1", [prospectId]); });
  const draftId = await createTestDraft({ prospectId, subject: "Approved subject", body: "Approved copy", gmailDraftId: "draft-preflight" });
  await createOutreachJob(draftId);
  const sender = createVerifiedGmailDraftSender({ users: { drafts: {
    get: async () => ({ data: { id: "different-draft" } }),
    send: async () => { assert.fail("send must not be invoked after rejection"); },
  } } });
  const result = await runOutreachWorkerOnce(async (job) => {
    await processOutreachJob(job, sender, async () => { assert.fail("must not claim an uncertain send"); });
  });
  assert.equal(result?.status, "failed");
  assert.equal(result?.attempt_count, 1);
  const draft = (await db.query("SELECT * FROM message_drafts WHERE id = $1", [draftId])).rows[0];
  assert.equal(draft.send_status, "pending");
  assert.equal(draft.review_status, "needs_edit");
  assert.match(draft.send_error, /preflight blocked/);
  assert.equal(draft.reconciliation_at, null);
  assert.equal(draft.sent_message_id, null);
  assert.equal((await db.query("SELECT stage FROM prospects WHERE id = $1", [prospectId])).rows[0].stage, "draft_ready");
});

test("Processor preflight: passes approved content to the sender", async (t) => {
  const prospectId = await createTestProspect();
  t.after(async () => { await db.query("DELETE FROM prospects WHERE id = $1", [prospectId]); });
  const draftId = await createTestDraft({ prospectId, subject: "Approved subject", body: "Approved body" });
  const job = await createOutreachJob(draftId);
  await processOutreachJob(job, async (_id, approved) => {
    assert.deepEqual(approved, { recipientEmail: "test@devbytaylor.com", subject: "Approved subject", body: "Approved body", threadId: null });
    return { status: "sent", messageId: "test-message", threadId: "test-thread" };
  });
});

test("Processor preflight: refuses to overwrite confirmed-send evidence", async (t) => {
  const prospectId = await createTestProspect();
  t.after(async () => { await db.query("DELETE FROM prospects WHERE id = $1", [prospectId]); });
  const draftId = await createTestDraft({ prospectId, sentMessageId: "confirmed-message", sentAt: new Date() });
  await db.query("UPDATE message_drafts SET send_status = 'sent' WHERE id = $1", [draftId]);
  assert.equal(await blockOutreachAfterPreflight(prospectId, draftId, "preflight rejected"), false);
  const row = (await db.query("SELECT * FROM message_drafts WHERE id = $1", [draftId])).rows[0];
  assert.equal(row.send_status, "sent");
  assert.equal(row.sent_message_id, "confirmed-message");
});

test("Processor preflight: block-persistence errors are terminal and preserve claimed state", async (t) => {
  const prospectId = await createTestProspect();
  t.after(async () => { await db.query("DELETE FROM prospects WHERE id = $1", [prospectId]); });
  const draftId = await createTestDraft({ prospectId });
  const job = await createOutreachJob(draftId);
  await assert.rejects(processOutreachJob(job, async () => {
    // Simulate a state change between validation and recording the block.
    await db.query("UPDATE message_drafts SET review_status = 'rejected' WHERE id = $1", [draftId]);
    throw new GmailPreflightError("preflight rejected");
  }), NonRetryableOutreachJobError);
  const row = (await db.query("SELECT send_status, review_status FROM message_drafts WHERE id = $1", [draftId])).rows[0];
  assert.equal(row.send_status, "sending");
  assert.equal(row.review_status, "rejected");
});
