// src/operator/outreach-operator-inspect.ts
import { db } from "../db.js";

export type OutreachJobInspection = {
  jobId: string;
  jobStatus: string;
  attemptCount: number;
  lastError: string | null;

  draftId: string;
  subject: string;
  recipientEmail: string;
  reviewStatus: string;
  sendStatus: string;
  gmailDraftId: string | null;
  sentMessageId: string | null;
  sentAt: Date | null;

  prospectId: string;
  companyName: string;
  contactEmail: string | null;
  prospectStage: string;
};

export const inspectOutreachJob = async (
  jobId: string,
): Promise<OutreachJobInspection | null> => {
  const result = await db.query<OutreachJobInspection>(
    `
      SELECT
        j.id AS "jobId",
        j.status AS "jobStatus",
        j.attempt_count AS "attemptCount",
        j.last_error AS "lastError",

        d.id AS "draftId",
        d.subject,
        d.recipient_email AS "recipientEmail",
        d.review_status AS "reviewStatus",
        d.send_status AS "sendStatus",
        d.gmail_draft_id AS "gmailDraftId",
        d.sent_message_id AS "sentMessageId",
        d.sent_at AS "sentAt",

        p.id AS "prospectId",
        p.company_name AS "companyName",
        p.contact_email AS "contactEmail",
        p.stage AS "prospectStage"
      FROM outreach_jobs j
      JOIN message_drafts d
        ON d.id = j.draft_id
      JOIN prospects p
        ON p.id = d.prospect_id
      WHERE j.id = $1;
    `,
    [jobId],
  );

  return result.rows[0] ?? null;
};

export const inspectOutreachQueue = async (): Promise<
  OutreachJobInspection[]
> => {
  const result = await db.query<OutreachJobInspection>(
    `
      SELECT
        j.id AS "jobId",
        j.status AS "jobStatus",
        j.attempt_count AS "attemptCount",
        j.last_error AS "lastError",

        d.id AS "draftId",
        d.subject,
        d.recipient_email AS "recipientEmail",
        d.review_status AS "reviewStatus",
        d.send_status AS "sendStatus",
        d.gmail_draft_id AS "gmailDraftId",
        d.sent_message_id AS "sentMessageId",
        d.sent_at AS "sentAt",

        p.id AS "prospectId",
        p.company_name AS "companyName",
        p.contact_email AS "contactEmail",
        p.stage AS "prospectStage"
      FROM outreach_jobs j
      JOIN message_drafts d
        ON d.id = j.draft_id
      JOIN prospects p
        ON p.id = d.prospect_id
      WHERE j.status IN ('pending', 'processing', 'failed')
      ORDER BY j.created_at ASC;
    `,
  );

  return result.rows;
};
