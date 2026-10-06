// src/jobs/outreach-reconciliation.ts
import { db } from "../db.js";
import type { MessageDraft } from "../outreach/message-drafts.js";
import type { OutreachJob } from "./outreach-jobs.js";

export type ReconciledProspectState = {
  id: string;
  stage: string;
};

export type ReconcileAndRequeueResult =
  | {
      reconciled: true;
      job: OutreachJob;
      draft: MessageDraft;
      prospect: ReconciledProspectState;
    }
  | {
      reconciled: false;
      reason: string;
    };

export const reconcileAndRequeueOutreachJobAsNotSent = async (
  jobId: string,
): Promise<ReconcileAndRequeueResult> => {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const stateResult = await client.query<{
      job_id: string;
      job_status: string;
      draft_id: string;
      draft_send_status: string;
      review_status: string;
      sent_message_id: string | null;
      sent_at: Date | null;
      prospect_id: string;
      prospect_stage: string;
    }>(
      `
        SELECT
        j.id AS job_id,
        j.status AS job_status,
        d.id AS draft_id,
        d.send_status AS draft_send_status,
        d.review_status,
        d.sent_message_id,
        d.sent_at,
        p.id AS prospect_id,
        p.stage AS prospect_stage
        FROM outreach_jobs j
        JOIN message_drafts d
          ON d.id = j.draft_id
        JOIN prospects p
          ON p.id = d.prospect_id
        WHERE j.id = $1
        FOR UPDATE OF j, d, p;
      `,
      [jobId],
    );

    const state = stateResult.rows[0];

    if (!state) {
      await client.query("ROLLBACK");

      return {
        reconciled: false,
        reason: "Outreach job not found",
      };
    }

    if (state.job_status !== "failed") {
      await client.query("ROLLBACK");

      return {
        reconciled: false,
        reason: `Outreach job cannot be reconciled. Current status: ${state.job_status}`,
      };
    }

    if (state.draft_send_status !== "needs_reconciliation") {
      await client.query("ROLLBACK");

      return {
        reconciled: false,
        reason: `Outreach draft cannot be reconciled. Current send status: ${state.draft_send_status}`,
      };
    }

    if (state.review_status !== "approved") {
      await client.query("ROLLBACK");

      return {
        reconciled: false,
        reason: "Outreach draft is not approved",
      };
    }

    if (state.prospect_stage !== "send_reconciliation") {
      await client.query("ROLLBACK");

      return {
        reconciled: false,
        reason: `Prospect cannot be reconciled. Current stage: ${state.prospect_stage}`,
      };
    }

    if (state.sent_message_id || state.sent_at) {
      await client.query("ROLLBACK");

      return {
        reconciled: false,
        reason: "Outreach draft contains confirmed send evidence",
      };
    }

    const draftResult = await client.query<MessageDraft>(
      `
        UPDATE message_drafts
        SET
          send_status = 'pending',
          send_error = NULL,
          reconciliation_at = NULL,
          updated_at = now()
        WHERE id = $1
        RETURNING *;
      `,
      [state.draft_id],
    );

    const prospectResult = await client.query<ReconciledProspectState>(
      `
          UPDATE prospects
          SET
            stage = 'draft_ready',
            updated_at = now()
          WHERE id = $1
          RETURNING id, stage;
        `,
      [state.prospect_id],
    );

    const jobResult = await client.query<OutreachJob>(
      `
        UPDATE outreach_jobs
        SET
          status = 'pending',
          available_at = now(),
          claimed_at = NULL,
          updated_at = now()
        WHERE id = $1
        RETURNING *;
      `,
      [state.job_id],
    );

    const draft = draftResult.rows[0];
    const prospect = prospectResult.rows[0];
    const job = jobResult.rows[0];

    if (!draft || !prospect || !job) {
      throw new Error("Failed to reconcile and requeue outreach job");
    }

    await client.query("COMMIT");

    return {
      reconciled: true,
      job,
      draft,
      prospect,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
