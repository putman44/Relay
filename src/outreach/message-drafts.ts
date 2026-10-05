// src/outreach/message-drafts.ts
import { db } from "../db.js";
import type { DraftType } from "./types/draft-types.js";
import type { ReviewStatus } from "./types/review-statuses.js";
import type { SendStatus } from "./types/send-statuses.js";

export type MessageDraft = {
  id: string;
  prospect_id: string;
  draft_type: DraftType;
  recipient_email: string;
  subject: string;
  body: string;
  gmail_draft_id: string | null;
  gmail_thread_id: string | null;
  review_status: ReviewStatus;
  send_status: SendStatus;
  review_notes: string | null;
  send_error: string | null;
  reconciliation_at: Date | null;
  sent_message_id: string | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export async function getMessageDraftById(
  draftId: string,
): Promise<MessageDraft | null> {
  const result = await db.query<MessageDraft>(
    `
      SELECT *
      FROM message_drafts
      WHERE id = $1
      LIMIT 1;
    `,
    [draftId],
  );

  return result.rows[0] ?? null;
}

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
