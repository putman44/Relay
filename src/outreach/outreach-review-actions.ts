// src/outreach/outreach-review-actions.ts
import { db } from "../db.js";
import type { OutreachJob } from "../jobs/outreach-jobs.js";
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

export type QueueApprovedOutreachDraftResult =
  | {
      queued: true;
      job: OutreachJob;
    }
  | {
      queued: false;
      reason: string;
    };

export const queueApprovedOutreachDraft = async (
  prospectId: string,
  draftId: string,
): Promise<QueueApprovedOutreachDraftResult> => {
  const result = await db.query<OutreachJob>(
    `
      INSERT INTO outreach_jobs (
        draft_id
      )
      SELECT d.id
      FROM message_drafts d
      JOIN prospects p
        ON p.id = d.prospect_id
      WHERE d.id = $2
        AND d.prospect_id = $1
        AND d.draft_type = 'outreach'
        AND d.review_status = 'approved'
        AND d.send_status = 'pending'
        AND p.stage = 'draft_ready'
        AND NOT p.cold_outreach_blocked
        AND NOT p.communication_opted_out
        AND NOT EXISTS (SELECT 1 FROM prospect_replies r WHERE r.prospect_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM message_drafts prior
          JOIN reply_thread_checks c ON c.draft_id = prior.id
          WHERE prior.prospect_id = p.id AND c.status <> 'ok')
      ON CONFLICT (draft_id) DO NOTHING
      RETURNING *;
    `,
    [prospectId, draftId],
  );

  const job = result.rows[0];

  if (!job) {
    return {
      queued: false,
      reason: "Outreach draft cannot be queued.",
    };
  }

  return {
    queued: true,
    job,
  };
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
