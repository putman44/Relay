import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CreatedGmailDraft, GmailDraftCreator } from '../gmail/gmail-draft-creator.js';
import type { GmailMessageReader } from '../gmail/gmail-message-reader.js';
import type { GmailThreadReader } from '../gmail/gmail-thread-reader.js';
import { findInboundReplies } from './reply-monitor.js';
import { buildResponseDraftMime, extractReplyContext, responseBodyWithSignature } from './reply-context.js';
import { noDraftDecision, validateReplyClassification, type ReplyClassifier } from './reply-classification.js';
import { invalidateStaleResponseDrafts } from './response-draft-invalidation.js';

type Target = {
  id: string; contact_email: string; company_name: string; communication_opted_out: boolean;
  reply_id: string; thread_id: string; outbound_id: string; original_subject: string; original_body: string;
};
type Dependencies = { database: Pool; readThread: GmailThreadReader; readMessage: GmailMessageReader;
  classify: ReplyClassifier; createGmailDraft: GmailDraftCreator };

async function transaction<T>(database: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect();
  try { await client.query('BEGIN'); const value = await action(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function checkTarget(client: PoolClient, target: Target) {
  const p = (await client.query(`SELECT contact_email,stage,communication_opted_out FROM prospects WHERE id=$1 FOR UPDATE`, [target.id])).rows[0];
  const latest = (await client.query(`SELECT gmail_message_id, gmail_thread_id FROM prospect_replies
    WHERE prospect_id=$1 ORDER BY received_at DESC, gmail_message_id DESC LIMIT 1`, [target.id])).rows[0];
  if (!p || p.stage === 'send_reconciliation' || p.contact_email !== target.contact_email
    || latest?.gmail_message_id !== target.reply_id || latest.gmail_thread_id !== target.thread_id) {
    throw new Error('Reply target changed or needs send reconciliation.');
  }
  return p as { communication_opted_out: boolean };
}

export async function processLatestReply(prospectId: string, deps: Dependencies) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(prospectId)) throw new Error('Invalid prospect UUID.');
  const { database } = deps;
  const requestId = randomUUID();
  const target = await transaction(database, async client => {
    await client.query('SELECT id FROM prospects WHERE id=$1 FOR UPDATE', [prospectId]);
    const row = (await client.query<Target>(`SELECT p.id,p.contact_email,p.company_name,p.communication_opted_out,
      r.gmail_message_id AS reply_id,r.gmail_thread_id AS thread_id,
      d.sent_message_id AS outbound_id,d.subject AS original_subject,d.body AS original_body
      FROM prospects p JOIN LATERAL (SELECT * FROM prospect_replies WHERE prospect_id=p.id
        ORDER BY received_at DESC,gmail_message_id DESC LIMIT 1) r ON true
      JOIN LATERAL (SELECT * FROM message_drafts WHERE prospect_id=p.id AND draft_type='outreach'
        AND send_status='sent' AND sent_message_id IS NOT NULL AND gmail_thread_id=r.gmail_thread_id
        ORDER BY sent_at DESC,id DESC LIMIT 1) d ON true WHERE p.id=$1`, [prospectId])).rows[0];
    if (!row?.contact_email) throw new Error('No confirmed outreach and recorded reply with known contact.');
    await checkTarget(client, row);
    await invalidateStaleResponseDrafts(client, row.id, row.reply_id);
    await client.query(`INSERT INTO reply_processing_requests (id,prospect_id,source_reply_message_id)
      VALUES ($1,$2,$3)`, [requestId, row.id, row.reply_id]);
    return row;
  });
  let invoked = false;
  let gmail: CreatedGmailDraft | undefined;
  const assertLiveLatest = async () => {
    const replies = findInboundReplies(await deps.readThread(target.thread_id), target.thread_id, target.outbound_id);
    if (replies.at(-1)?.messageId !== target.reply_id) throw new Error('Live latest reply differs; run reply monitoring and review.');
  };
  try {
    await assertLiveLatest();
    const context = await extractReplyContext(await deps.readMessage(target.reply_id), target.reply_id, target.thread_id, target.contact_email);
    const decision = target.communication_opted_out || context.optOut
      ? noDraftDecision('Opt Out', 'Opt-out detected; do not contact this prospect.')
      : context.automatic ? noDraftDecision('Unclear', 'Automatic message requires manual review; no response created.')
      : validateReplyClassification(await deps.classify({ companyName: target.company_name,
        originalSubject: target.original_subject, originalBody: target.original_body,
        replySubject: context.subject, replyBody: context.body }));
    await assertLiveLatest();
    await transaction(database, async client => {
      const current = await checkTarget(client, target);
      if (decision.shouldDraftResponse && current.communication_opted_out) throw new Error('Prospect opted out during classification.');
      const changed = await client.query(`UPDATE reply_processing_requests SET classification=$2,
        status=$3,updated_at=now() WHERE id=$1 AND status='classifying' RETURNING id`,
      [requestId, JSON.stringify(decision), decision.shouldDraftResponse ? 'creating' : 'no_draft']);
      if (!changed.rowCount) throw new Error('Reply request changed; inspect before recovery.');
      if (decision.classification === 'Opt Out') await client.query(`UPDATE prospects SET
        communication_opted_out=true,cold_outreach_blocked=true,updated_at=now() WHERE id=$1`, [target.id]);
    });
    if (!decision.shouldDraftResponse) return { requestId, status: 'no_draft' as const, draftId: null };
    const responseBody = responseBodyWithSignature(decision.suggestedResponse);
    const raw = buildResponseDraftMime(requestId, target.id, context, responseBody);
    await assertLiveLatest();
    // The durable creating reservation exists before the non-idempotent Gmail POST.
    invoked = true;
    gmail = await deps.createGmailDraft(raw, target.thread_id);
    if (!gmail.draftId?.trim() || !gmail.messageId?.trim() || gmail.threadId !== target.thread_id) {
      throw new Error('Response draft result is incomplete or on the wrong thread.');
    }
    await assertLiveLatest();
    await transaction(database, async client => {
      const current = await checkTarget(client, target);
      if (current.communication_opted_out) throw new Error('Prospect opted out during draft creation.');
      const updated = await client.query(`UPDATE reply_processing_requests SET status='created',
        gmail_draft_id=$2,gmail_message_id=$3,gmail_thread_id=$4,updated_at=now()
        WHERE id=$1 AND status='creating' RETURNING id`, [requestId, gmail!.draftId, gmail!.messageId, gmail!.threadId]);
      if (!updated.rowCount) throw new Error('Draft creation request requires reconciliation.');
      await client.query(`INSERT INTO message_drafts (id,prospect_id,draft_type,recipient_email,subject,body,
        gmail_draft_id,gmail_thread_id,source_reply_message_id,review_status,send_status)
        VALUES ($1,$2,'response',$3,$4,$5,$6,$7,$8,'needs_review','pending')`,
      [requestId, target.id, context.recipientEmail, context.subject, responseBody,
        gmail!.draftId, gmail!.threadId, target.reply_id]);
    });
    return { requestId, status: 'created' as const, draftId: requestId };
  } catch (error) {
    try {
      await database.query(`UPDATE reply_processing_requests SET status=$2,
        gmail_draft_id=COALESCE($3,gmail_draft_id),gmail_message_id=COALESCE($4,gmail_message_id),
        gmail_thread_id=COALESCE($5,gmail_thread_id),last_error=$6,updated_at=now()
        WHERE id=$1 AND status IN ('classifying','creating','needs_reconciliation','stale')`,
      [requestId, invoked ? 'needs_reconciliation' : 'failed', gmail?.draftId ?? null, gmail?.messageId ?? null,
        gmail?.threadId ?? null, invoked ? 'Gmail creation or finalization requires reconciliation; do not retry.' : 'Stopped before Gmail creation; inspect before any manual recovery.']);
    } catch { /* Original reservation remains a durable duplicate guard during DB outages. */ }
    throw new Error(`Reply request ${requestId} stopped; inspect its durable state before recovery.`, { cause: error });
  }
}
