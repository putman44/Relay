import type { Pool } from 'pg';
import { GmailThreadUnavailableError, type GmailThread, type GmailThreadReader } from '../gmail/gmail-thread-reader.js';
import { invalidateStaleResponseDrafts } from './response-draft-invalidation.js';

export type InboundReply = {
  messageId: string; threadId: string; receivedAt: Date;
  sender: string; subject: string; snippet: string;
};

export function findInboundReplies(thread: GmailThread, threadId: string, sentMessageId: string): InboundReply[] {
  if (!sentMessageId || thread.id !== threadId || !thread.messages?.length) {
    throw new Error('Thread identity, messages, or sent message identity is invalid.');
  }
  const outbound = thread.messages.find(m => m.id === sentMessageId);
  if (!outbound?.labelIds?.includes('SENT') || outbound.labelIds.includes('DRAFT')) {
    throw new Error('Confirmed outbound message is absent from the thread.');
  }
  // Database finalization can occur after a fast inbound reply. Anchor to
  // Gmail's actual outbound timestamp, not the later database sent_at value.
  const baseline = Number(outbound.internalDate);
  const ids = new Set<string>();
  const replies: InboundReply[] = [];
  for (const message of thread.messages) {
    const timestamp = Number(message.internalDate);
    // Gmail may omit an empty label list for a read, archived message.
    // Missing labels never prove an outbound message; conservatively count it.
    const labels = message.labelIds ?? [];
    if (!message.id?.trim() || message.threadId !== threadId || !Array.isArray(labels)
      || !message.internalDate || !/^\d+$/.test(message.internalDate)
      || !Number.isSafeInteger(timestamp) || !Number.isFinite(new Date(timestamp).getTime()) || ids.has(message.id)) {
      throw new Error('Thread contains an incomplete or ambiguous message.');
    }
    ids.add(message.id);
    if (labels.includes('SENT') || labels.includes('DRAFT') || timestamp < baseline) continue;
    const header = (name: string) => (message.payload?.headers ?? [])
      .filter(h => h.name?.toLowerCase() === name).map(h => h.value ?? '').join('\n');
    // Any inbound message, including a bounce or OOO, stops cold outreach.
    replies.push({ messageId: message.id, threadId, receivedAt: new Date(timestamp),
      sender: header('from'), subject: header('subject'), snippet: message.snippet ?? '' });
  }
  return replies.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.messageId.localeCompare(b.messageId));
}

export async function monitorReplies(database: Pool, readThread: GmailThreadReader, limit = 50) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Reply monitor limit must be 1..500.');
  const { rows } = await database.query<{
    id: string; prospect_id: string; gmail_thread_id: string; sent_message_id: string; sent_at_version: string;
  }>(`SELECT d.id, d.prospect_id, d.gmail_thread_id, d.sent_message_id, d.sent_at::text AS sent_at_version
      FROM message_drafts d LEFT JOIN reply_thread_checks c ON c.draft_id = d.id
      WHERE d.draft_type = 'outreach' AND d.send_status = 'sent'
        AND d.sent_at IS NOT NULL AND d.sent_message_id IS NOT NULL
        AND d.gmail_thread_id IS NOT NULL AND btrim(d.gmail_thread_id) <> ''
        AND (c.status IS NULL OR c.status <> 'unavailable')
      ORDER BY c.checked_at ASC NULLS FIRST, d.id LIMIT $1`, [limit]);
  const result = { checked: 0, recorded: 0, errors: 0, unavailable: 0, attentionRequired: 0 };
  for (const target of rows) {
    let replies: InboundReply[] = [];
    let status: 'ok' | 'error' | 'unavailable' = 'ok';
    try {
      replies = findInboundReplies(await readThread(target.gmail_thread_id), target.gmail_thread_id, target.sent_message_id);
    } catch (error) {
      status = error instanceof GmailThreadUnavailableError ? 'unavailable' : 'error';
    }
    const client = await database.connect();
    let inserted = 0;
    try {
      await client.query('BEGIN');
      // Match send-claim lock order. Never reset a sending or uncertain draft.
      await client.query('SELECT id FROM prospects WHERE id = $1 FOR UPDATE', [target.prospect_id]);
      const current = await client.query(`SELECT id FROM message_drafts WHERE id = $1
        AND prospect_id = $2 AND gmail_thread_id = $3 AND sent_at = $4
        AND send_status = 'sent' AND sent_message_id = $5 FOR UPDATE`,
      [target.id, target.prospect_id, target.gmail_thread_id, target.sent_at_version, target.sent_message_id]);
      if (!current.rowCount) throw new Error('Monitored draft changed during thread read.');
      for (const reply of replies) {
        const saved = await client.query(`INSERT INTO prospect_replies
          (prospect_id, gmail_message_id, gmail_thread_id, received_at, sender, subject, snippet)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [target.prospect_id, reply.messageId, reply.threadId, reply.receivedAt, reply.sender, reply.subject, reply.snippet]);
        inserted += saved.rowCount ?? 0;
      }
      if (replies.length || status === 'unavailable') {
        await client.query(`UPDATE prospects SET cold_outreach_blocked = true,
          stage = CASE WHEN stage = 'send_reconciliation' OR $2 = false THEN stage ELSE 'replied' END,
          updated_at = now() WHERE id = $1`, [target.prospect_id, replies.length > 0]);
      }
      if (replies.length) {
        const latest = (await client.query(`SELECT gmail_message_id FROM prospect_replies
          WHERE prospect_id=$1 ORDER BY received_at DESC,gmail_message_id DESC LIMIT 1`, [target.prospect_id])).rows[0];
        await invalidateStaleResponseDrafts(client, target.prospect_id, latest.gmail_message_id);
        await client.query(`UPDATE message_drafts SET review_status='rejected',
          review_notes='Inbound reply blocks cold follow-up.',updated_at=now()
          WHERE prospect_id=$1 AND draft_type='follow_up' AND send_status='pending'
            AND sent_at IS NULL AND sent_message_id IS NULL`, [target.prospect_id]);
      }
      await client.query(`INSERT INTO reply_thread_checks (draft_id, status) VALUES ($1,$2)
        ON CONFLICT (draft_id) DO UPDATE SET status = CASE
          WHEN reply_thread_checks.status = 'unavailable' THEN 'unavailable' ELSE EXCLUDED.status END,
          checked_at = now()`, [target.id, status]);
      await client.query('COMMIT');
      result.recorded += inserted;
      result.checked++;
      if (status !== 'ok') result.errors++;
      if (status === 'unavailable') result.unavailable++;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error; // Persistence failures must never look like a successful poll.
    } finally { client.release(); }
  }
  result.attentionRequired = Number((await database.query(
    "SELECT count(*) AS count FROM reply_thread_checks WHERE status <> 'ok'",
  )).rows[0].count);
  return result;
}
