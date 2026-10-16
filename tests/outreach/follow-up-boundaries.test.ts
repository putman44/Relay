import { strict as assert } from 'node:assert';
import { after,test } from 'node:test';
import { db } from '../../src/db.js';
import { createTestDraft,createTestProspect } from '../helpers/test-helpers.js';
import { approveOutreachDraft,queueApprovedOutreachDraft } from '../../src/outreach/outreach-review-actions.js';
import { claimOutreachSend } from '../../src/outreach/outreach-send.js';
import { resolveOutreachReconciliationAsNotSent } from '../../src/outreach/outreach-reconciliation.js';

after(async()=>{await db.end();});
test('Follow-up boundary: initial-outreach approval, queue and claim reject follow-up drafts',async t=>{
  const prospectId=await createTestProspect();t.after(async()=>{await db.query('DELETE FROM prospects WHERE id=$1',[prospectId]);});
  const draftId=await createTestDraft({ prospectId,reviewStatus:'needs_review' });
  await db.query("UPDATE message_drafts SET draft_type='follow_up' WHERE id=$1",[draftId]);
  assert.equal((await approveOutreachDraft(prospectId,draftId)).approved,false);
  await db.query("UPDATE message_drafts SET review_status='approved' WHERE id=$1",[draftId]);
  assert.equal((await queueApprovedOutreachDraft(prospectId,draftId)).queued,false);
  assert.equal((await claimOutreachSend(prospectId,draftId)).claimed,false);
});
test('Follow-up boundary: outreach-only reconciliation cannot reset follow-up uncertainty',async t=>{
  const prospectId=await createTestProspect({ stage:'send_reconciliation' });t.after(async()=>{await db.query('DELETE FROM prospects WHERE id=$1',[prospectId]);});
  const draftId=await createTestDraft({ prospectId });
  await db.query("UPDATE message_drafts SET draft_type='follow_up',send_status='needs_reconciliation' WHERE id=$1",[draftId]);
  assert.equal((await resolveOutreachReconciliationAsNotSent(prospectId,draftId)).resolved,false);
  assert.equal((await db.query('SELECT send_status FROM message_drafts WHERE id=$1',[draftId])).rows[0].send_status,'needs_reconciliation');
  assert.equal((await db.query('SELECT stage FROM prospects WHERE id=$1',[prospectId])).rows[0].stage,'send_reconciliation');
});
