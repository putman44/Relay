// src/outreach/outreach-review-actions.ts
import { db } from "../db.js";
import type { MessageDraft } from "./message-drafts.js";

export type ApproveOutreachDraftResult =
  | {
      approved: true;
      draft: MessageDraft;
    }
  | {
      approved: false;
      reason: string;
    };

export const approveOutreachDraft = async (
  prospectId: string,
  draftId: string,
): Promise<ApproveOutreachDraftResult> => {
  const result = await db.query<MessageDraft>(
    `
      UPDATE message_drafts
      SET
        review_status = 'approved',
        updated_at = now()
      WHERE id = $1
        AND prospect_id = $2
        AND draft_type = 'outreach'
        AND review_status = 'needs_review'
        AND send_status = 'pending'
      RETURNING *;
    `,
    [draftId, prospectId],
  );

  const draft = result.rows[0];

  if (!draft) {
    return {
      approved: false,
      reason: "Outreach draft cannot be approved.",
    };
  }

  return {
    approved: true,
    draft,
  };
};
