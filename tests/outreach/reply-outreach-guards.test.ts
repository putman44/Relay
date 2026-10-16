import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { db } from '../../src/db.js';
import { claimOutreachSend, completeOutreachSend } from '../../src/outreach/outreach-send.js';
import { queueApprovedOutreachDraft } from '../../src/outreach/outreach-review-actions.js';
import { createTestDraft, createTestProspect } from '../helpers/test-helpers.js';

after(async () => { await db.end(); });
test('Reply guards: opt-out independently blocks queue and claim when cold flags are reset', async t => {
  const prospect = await createTestProspect();
  t.after(async () => { await db.query('DELETE FROM prospects WHERE id=$1', [prospect]); });
  const draft = await createTestDraft({ prospectId: prospect });
  await db.query('UPDATE prospects SET communication_opted_out=true,cold_outreach_blocked=false WHERE id=$1', [prospect]);
  assert.equal((await queueApprovedOutreachDraft(prospect, draft)).queued, false);
  assert.equal((await claimOutreachSend(prospect, draft)).claimed, false);
});
test('Reply guards: durable suppression prevents queue and claim even after a stage reset', async t => {
  const prospect = await createTestProspect();
  t.after(async () => { await db.query('DELETE FROM prospects WHERE id=$1', [prospect]); });
  const draft = await createTestDraft({ prospectId: prospect });
  await db.query('UPDATE prospects SET cold_outreach_blocked=true WHERE id=$1', [prospect]);
  assert.equal((await queueApprovedOutreachDraft(prospect, draft)).queued, false);
  assert.equal((await claimOutreachSend(prospect, draft)).claimed, false);
  // Stored reply evidence is authoritative even if another tool resets flags.
  await db.query(`INSERT INTO prospect_replies (prospect_id,gmail_message_id,gmail_thread_id,received_at,sender,subject,snippet)
    VALUES ($1,'reply','thread',now(),'person@example.com','Re: Subject','Hi')`, [prospect]);
  await db.query('UPDATE prospects SET cold_outreach_blocked=false WHERE id=$1', [prospect]);
  assert.equal((await queueApprovedOutreachDraft(prospect, draft)).queued, false);
  assert.equal((await claimOutreachSend(prospect, draft)).claimed, false);
});
test('Reply guards: unhealthy thread checks stop sends until a successful check', async t => {
  const prospect = await createTestProspect();
  t.after(async () => { await db.query('DELETE FROM prospects WHERE id=$1', [prospect]); });
  const draft = await createTestDraft({ prospectId: prospect });
  await db.query("INSERT INTO reply_thread_checks (draft_id,status) VALUES ($1,'error')", [draft]);
  assert.equal((await queueApprovedOutreachDraft(prospect, draft)).queued, false);
  assert.equal((await claimOutreachSend(prospect, draft)).claimed, false);
  await db.query("UPDATE reply_thread_checks SET status='ok' WHERE draft_id=$1", [draft]);
  assert.equal((await claimOutreachSend(prospect, draft)).claimed, true);
});
test('Reply guards: late send finalization preserves durable replies and suppression', async t => {
  const prospect = await createTestProspect();
  t.after(async () => { await db.query('DELETE FROM prospects WHERE id=$1', [prospect]); });
  const draft = await createTestDraft({ prospectId: prospect });
  assert.equal((await claimOutreachSend(prospect, draft)).claimed, true);
  await db.query(`INSERT INTO prospect_replies (prospect_id,gmail_message_id,gmail_thread_id,received_at,sender,subject,snippet)
    VALUES ($1,'reply','thread',now(),'person@example.com','Re: Subject','Hi')`, [prospect]);
  await db.query("UPDATE prospects SET cold_outreach_blocked=true,stage='replied' WHERE id=$1", [prospect]);
  const result = await completeOutreachSend(prospect, draft, 'confirmed-send', 'thread');
  assert.equal(result.completed, true);
  const row = (await db.query('SELECT * FROM prospects WHERE id=$1', [prospect])).rows[0];
  assert.equal(row.stage, 'replied'); assert.equal(row.cold_outreach_blocked, true);
});
