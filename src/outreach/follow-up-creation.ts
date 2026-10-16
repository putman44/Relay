import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { GmailDraftCreator, CreatedGmailDraft } from '../gmail/gmail-draft-creator.js';
import type { GmailThreadReader } from '../gmail/gmail-thread-reader.js';
import { buildResponseDraftMime } from './reply-context.js';
import { followUpTransaction, loadFollowUpState, requireDue, requireUuid, followUpCopy, verifyColdFollowUpThread } from './follow-up-state.js';

type Dependencies = { database: Pool; readThread: GmailThreadReader; createGmailDraft: GmailDraftCreator; now?: () => Date };
export async function inspectFollowUp(prospectId: string, timeZone: string, database: Pool, now = new Date()) {
  requireUuid(prospectId);
  return followUpTransaction(database, async client => {
    const state = await loadFollowUpState(client, prospectId, timeZone, now);
    return { ...state.schedule, confirmedFollowUps: state.sent.length };
  });
}
export async function createFollowUpDraft(prospectId: string, timeZone: string, deps: Dependencies) {
  requireUuid(prospectId);
  const now = deps.now ?? (() => new Date());
  const initial = await followUpTransaction(deps.database, client => loadFollowUpState(client, prospectId, timeZone, now()));
  requireDue(initial);
  const parent = verifyColdFollowUpThread(await deps.readThread(initial.outreach.gmail_thread_id!), initial);
  const requestId = randomUUID();
  const body = followUpCopy(initial);
  const raw = buildResponseDraftMime(requestId, prospectId, { recipientEmail: initial.prospect.contact_email!,
    subject: initial.outreach.subject, body: '', messageIdHeader: parent, optOut: false, automatic: false }, body);
  await followUpTransaction(deps.database, async client => {
    const state = await loadFollowUpState(client, prospectId, timeZone, now()); requireDue(state);
    if (state.version !== initial.version) throw new Error('Follow-up source changed before reservation.');
    await client.query(`INSERT INTO follow_up_draft_requests
      (id,prospect_id,parent_outreach_draft_id,follow_up_number,time_zone,due_date,recipient_email,subject,body,
       parent_sent_message_id,parent_rfc_message_id,history_version,gmail_thread_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [requestId,prospectId,state.outreach.id,state.schedule.number,state.schedule.timeZone,state.schedule.dueDate,
      state.prospect.contact_email,state.outreach.subject,body,state.sent.at(-1)?.sent_message_id ?? state.outreach.sent_message_id,
      parent,state.version,state.outreach.gmail_thread_id]);
  });
  let invoked = false; let gmail: CreatedGmailDraft | undefined;
  try {
    if (verifyColdFollowUpThread(await deps.readThread(initial.outreach.gmail_thread_id!), initial) !== parent) throw new Error('Parent changed before creation.');
    invoked = true; gmail = await deps.createGmailDraft(raw, initial.outreach.gmail_thread_id!);
    if (!gmail.draftId?.trim() || !gmail.messageId?.trim() || gmail.threadId !== initial.outreach.gmail_thread_id) throw new Error('Incomplete or wrong-thread creation result.');
    if (verifyColdFollowUpThread(await deps.readThread(initial.outreach.gmail_thread_id!), initial) !== parent) throw new Error('Thread changed during creation.');
    await followUpTransaction(deps.database, async client => {
      const state = await loadFollowUpState(client, prospectId, timeZone, now(), requestId); requireDue(state);
      if (state.version !== initial.version) throw new Error('Follow-up source changed during creation.');
      const update = await client.query(`UPDATE follow_up_draft_requests SET status='created',gmail_draft_id=$2,
        gmail_message_id=$3,returned_gmail_thread_id=$4,updated_at=now() WHERE id=$1 AND status='creating' RETURNING id`, [requestId,gmail!.draftId,gmail!.messageId,gmail!.threadId]);
      if (!update.rowCount) throw new Error('Follow-up request changed; reconcile before recovery.');
      await client.query(`INSERT INTO message_drafts
        (id,prospect_id,draft_type,recipient_email,subject,body,gmail_draft_id,gmail_thread_id,follow_up_number,parent_outreach_draft_id)
        VALUES ($1,$2,'follow_up',$3,$4,$5,$6,$7,$8,$9)`,
      [requestId,prospectId,state.prospect.contact_email,state.outreach.subject,body,gmail!.draftId,gmail!.threadId,state.schedule.number,state.outreach.id]);
    });
    return { draftId: requestId, number: initial.schedule.number, reviewStatus: 'needs_review' };
  } catch (error) {
    try { await deps.database.query(`UPDATE follow_up_draft_requests SET status=$2,gmail_draft_id=$3,gmail_message_id=$4,returned_gmail_thread_id=$5,
      last_error='Creation stopped; verify Gmail before recovery. No automatic retries.',updated_at=now()
      WHERE id=$1 AND status='creating'`, [requestId,invoked ? 'needs_reconciliation' : 'failed',gmail?.draftId ?? null,gmail?.messageId ?? null,gmail?.threadId ?? null]);
    } catch { /* The creating reservation still blocks duplicates during DB outages. */ }
    throw new Error(`Follow-up request ${requestId} stopped; inspect durable state before recovery.`, { cause: error });
  }
}
