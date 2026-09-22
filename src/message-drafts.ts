// src/message-drafts.ts
import { db } from "./db.js";

export type MessageDraft = {
  id: string;
  prospect_id: string;
  draft_type: "outreach" | "follow_up" | "response";
  recipient_email: string;
  subject: string;
  body: string;
  gmail_draft_id: string | null;
  gmail_thread_id: string | null;
  review_status:
    | "needs_review"
    | "approved"
    | "needs_edit"
    | "rejected"
    | "sent";
  send_status: "pending" | "sending" | "sent" | "needs_reconciliation";
  review_notes: string | null;
  send_error: string | null;
  reconciliation_at: Date | null;
  sent_message_id: string | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export async function getLatestOutreachDraft(
  prospectId: string,
): Promise<MessageDraft | null> {
  const result = await db.query<MessageDraft>(
    `
      SELECT *
      FROM message_drafts
      WHERE prospect_id = $1
        AND draft_type = 'outreach'
      ORDER BY created_at DESC
      LIMIT 1;
    `,
    [prospectId],
  );

  return result.rows[0] ?? null;
}
