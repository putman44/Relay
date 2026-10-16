import type { Pool, PoolClient } from 'pg';
import type { GmailDraftApi } from '../gmail/gmail-draft-sender.js';
import { verifyGmailDraftSnapshot, type GmailDraftReadApi } from '../gmail/gmail-draft-preflight.js';
import type { GmailThreadReader } from '../gmail/gmail-thread-reader.js';
import type { ApprovedGmailDraft } from '../gmail/gmail-types.js';
import { approvalFingerprint, followUpTransaction, loadFollowUpState, requireDue, requireUuid,
  verifyColdFollowUpThread, type FollowUpRequest, type FollowUpState } from './follow-up-state.js';

async function readRequest(client: PoolClient, draftId: string) {
  const request = (await client.query<FollowUpRequest>(`SELECT *,due_date::text AS due_date
    FROM follow_up_draft_requests WHERE id=$1`, [draftId])).rows[0];
  if (!request) throw new Error('Follow-up creation request not found.');
  return request;
}
function matchingDraft(state: FollowUpState, request: FollowUpRequest, sendStatus: 'pending' | 'sending') {
  requireDue(state);
  const draft = state.drafts.find(d => d.id === request.id);
  if (!draft || draft.draft_type !== 'follow_up' || request.status !== 'created'
    || draft.send_status !== sendStatus || draft.sent_at || draft.sent_message_id
    || draft.follow_up_number !== state.schedule.number || request.follow_up_number !== draft.follow_up_number
    || draft.parent_outreach_draft_id !== state.outreach.id || request.parent_outreach_draft_id !== state.outreach.id
    || request.history_version !== state.version || request.due_date !== state.schedule.dueDate
    || !draft.gmail_draft_id || draft.gmail_draft_id !== request.gmail_draft_id
    || draft.gmail_thread_id !== request.gmail_thread_id || request.gmail_thread_id !== state.outreach.gmail_thread_id
    || draft.recipient_email !== request.recipient_email || draft.subject !== request.subject || draft.body !== request.body
    || request.parent_sent_message_id !== (state.sent.at(-1)?.sent_message_id ?? state.outreach.sent_message_id)) {
    throw new Error('Follow-up content, source, date, or send state changed; review required.');
  }
  return draft;
}

export async function approveFollowUpDraft(draftId: string, database: Pool, now = new Date()) {
  requireUuid(draftId);
  return followUpTransaction(database, async client => {
    const source = await readRequest(client, draftId);
    const state = await loadFollowUpState(client, source.prospect_id, source.time_zone, now, draftId);
    const request = state.requests.find(r => r.id === draftId)!;
    const draft = matchingDraft(state, request, 'pending');
    if (draft.review_status !== 'needs_review') throw new Error('Follow-up is not awaiting approval.');
    const prior = await client.query('SELECT 1 FROM follow_up_send_attempts WHERE draft_id=$1', [draftId]);
    if (prior.rowCount) throw new Error('Existing send attempt requires operator recovery.');
    await client.query("UPDATE message_drafts SET review_status='approved',updated_at=now() WHERE id=$1", [draftId]);
    await client.query('UPDATE follow_up_draft_requests SET approved_content_hash=$2,updated_at=now() WHERE id=$1',
      [draftId,approvalFingerprint(draft,request)]);
    return { draftId, reviewStatus: 'approved' };
  });
}

type SendDependencies = { database: Pool; gmail: GmailDraftApi & GmailDraftReadApi;
  readThread: GmailThreadReader; now?: () => Date };

export async function sendApprovedFollowUp(draftId: string, deps: SendDependencies) {
  requireUuid(draftId);
  const now = deps.now ?? (() => new Date());
  const claim = await followUpTransaction(deps.database, async client => {
    const source = await readRequest(client, draftId);
    const state = await loadFollowUpState(client, source.prospect_id, source.time_zone, now(), draftId);
    const request = state.requests.find(r => r.id === draftId)!;
    const draft = matchingDraft(state,request,'pending');
    const hash = approvalFingerprint(draft,request);
    if (draft.review_status !== 'approved' || request.approved_content_hash !== hash) throw new Error('Exact follow-up content is not approved.');
    const approved: ApprovedGmailDraft = { recipientEmail: draft.recipient_email, subject: draft.subject,
      body: draft.body, threadId: draft.gmail_thread_id, parentMessageId: request.parent_rfc_message_id };
    await client.query(`INSERT INTO follow_up_send_attempts (draft_id,status,approved_snapshot)
      VALUES ($1,'preflight',$2)`, [draftId,JSON.stringify({ ...approved,hash,number:draft.follow_up_number,historyVersion:state.version })]);
    await client.query("UPDATE message_drafts SET send_status='sending',updated_at=now() WHERE id=$1", [draftId]);
    return { state,request,draft,approved,hash };
  });
  let invoked = false;
  let messageId: string | null = null, threadId: string | null = null;
  try {
    const snapshot = await deps.gmail.users.drafts.get({ userId: 'me', id: claim.draft.gmail_draft_id!, format: 'raw' });
    const verified = await verifyGmailDraftSnapshot(claim.draft.gmail_draft_id!,claim.approved,snapshot.data);
    // This is after MIME inspection, immediately before the final DB check/send.
    const parent = verifyColdFollowUpThread(await deps.readThread(claim.request.gmail_thread_id),claim.state);
    if (parent !== claim.request.parent_rfc_message_id) throw new Error('Thread parent changed since approval.');
    await followUpTransaction(deps.database, async client => {
      const state = await loadFollowUpState(client,claim.request.prospect_id,claim.request.time_zone,now(),draftId);
      const request = state.requests.find(r => r.id === draftId)!;
      const current = matchingDraft(state,request,'sending');
      if (current.review_status !== 'approved' || approvalFingerprint(current,request) !== claim.hash
        || request.approved_content_hash !== claim.hash) throw new Error('Approval changed during preflight.');
      const changed = await client.query(`UPDATE follow_up_send_attempts SET status='invoking',updated_at=now()
        WHERE draft_id=$1 AND status='preflight' RETURNING draft_id`, [draftId]);
      if (!changed.rowCount) throw new Error('Send attempt changed during preflight.');
    });
    invoked = true;
    const response = await deps.gmail.users.drafts.send({ userId: 'me', requestBody: {
      id: claim.draft.gmail_draft_id!, message: verified,
    } }, { retry: false });
    messageId = response.data.id ?? null; threadId = response.data.threadId ?? null;
    if (!messageId?.trim() || threadId !== claim.request.gmail_thread_id
      || [claim.state.outreach,...claim.state.sent].some(d => d.sent_message_id === messageId)) {
      throw new Error('Incomplete, reused, or wrong-thread send identity.');
    }
    await followUpTransaction(deps.database, async client => {
      await client.query('SELECT id FROM prospects WHERE id=$1 FOR UPDATE', [claim.request.prospect_id]);
      // Gmail has already confirmed sending. Record that fact even if a reply
      // arrived or approval was revoked while the request was in flight.
      const saved = await client.query(`UPDATE message_drafts SET send_status='sent',review_status='sent',
        sent_message_id=$2,sent_at=$3,updated_at=now() WHERE id=$1 AND draft_type='follow_up'
        AND send_status='sending' AND sent_message_id IS NULL AND sent_at IS NULL
        AND prospect_id=$4 AND parent_outreach_draft_id=$5 AND follow_up_number=$6 RETURNING id`,
      [draftId,messageId,now(),claim.request.prospect_id,claim.request.parent_outreach_draft_id,claim.request.follow_up_number]);
      if (!saved.rowCount) throw new Error('Confirmed send could not be finalized; inspect evidence.');
      const attempt = await client.query(`UPDATE follow_up_send_attempts SET status='sent',sent_message_id=$2,
        gmail_thread_id=$3,updated_at=now() WHERE draft_id=$1 AND status='invoking' RETURNING draft_id`, [draftId,messageId,threadId]);
      if (!attempt.rowCount) throw new Error('Confirmed send journal changed; reconcile.');
      // Do not overwrite replied/send_reconciliation stages or suppression flags.
    });
    return { draftId,status:'sent',number:claim.draft.follow_up_number };
  } catch (error) {
    try {
      await followUpTransaction(deps.database, async client => {
        await client.query('SELECT id FROM prospects WHERE id=$1 FOR UPDATE', [claim.request.prospect_id]);
        await client.query(`UPDATE follow_up_send_attempts SET status=$2,sent_message_id=$3,gmail_thread_id=$4,
          last_error=$5,updated_at=now() WHERE draft_id=$1 AND status <> 'sent'`,
        [draftId,invoked ? 'needs_reconciliation' : 'blocked',messageId,threadId,
          invoked ? 'Send outcome requires human reconciliation. Do not retry.' : 'Preflight stopped before send. Review required; no automatic retry.']);
        const changed = await client.query(`UPDATE message_drafts SET send_status=$2,
          review_status=CASE WHEN $3 THEN review_status ELSE 'needs_edit' END,
          send_error=$4,reconciliation_at=CASE WHEN $3 THEN now() ELSE reconciliation_at END,updated_at=now()
          WHERE id=$1 AND prospect_id=$5 AND send_status='sending' AND sent_message_id IS NULL AND sent_at IS NULL
            AND ($3 OR review_status='approved') RETURNING id`,
        [draftId,invoked ? 'needs_reconciliation' : 'pending',invoked,
          invoked ? 'Follow-up send requires reconciliation.' : 'Follow-up preflight blocked before sending.',claim.request.prospect_id]);
        if (invoked && changed.rowCount) await client.query("UPDATE prospects SET stage='send_reconciliation',updated_at=now() WHERE id=$1", [claim.request.prospect_id]);
      });
    } catch { /* Sending/invoking reservations remain fail-closed during DB outages. */ }
    throw new Error(`Follow-up send ${draftId} stopped; inspect draft and attempt state before recovery.`, { cause: error });
  }
}
