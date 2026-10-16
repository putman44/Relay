import type { PoolClient } from 'pg';

// Caller holds the prospect lock. Never rewrite in-flight or confirmed sends.
export async function invalidateStaleResponseDrafts(client: PoolClient, prospectId: string, latestReplyId: string) {
  await client.query(`UPDATE message_drafts SET review_status = 'rejected',
    review_notes = 'Superseded by a newer inbound reply; do not send.', updated_at = now()
    WHERE prospect_id = $1 AND draft_type = 'response'
      AND source_reply_message_id IS DISTINCT FROM $2
      AND send_status = 'pending' AND sent_at IS NULL AND sent_message_id IS NULL`, [prospectId, latestReplyId]);
  await client.query(`UPDATE reply_processing_requests SET
    status = CASE WHEN status = 'creating' THEN 'needs_reconciliation' ELSE 'stale' END,
    last_error = 'Superseded by a newer inbound reply.', updated_at = now()
    WHERE prospect_id = $1 AND source_reply_message_id <> $2
      AND status IN ('classifying','creating','created','no_draft')`, [prospectId, latestReplyId]);
}
