// src/jobs/outreach-jobs.ts

import { db } from "../db.js";
import type { JobStatus } from "./job-statuses.js";

export type OutreachJob = {
  id: string;
  draft_id: string;
  status: JobStatus;
  attempt_count: number;
  available_at: Date;
  claimed_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

export const createOutreachJob = async (
  draftId: string,
): Promise<OutreachJob> => {
  const result = await db.query<OutreachJob>(
    `
    INSERT INTO outreach_jobs (
      draft_id
    )
    VALUES ($1)
    RETURNING *;
  `,
    [draftId],
  );

  const job = result.rows[0];

  if (!job) {
    throw new Error("Failed to create outreach job");
  }

  return job;
};

export const claimNextOutreachJob = async (): Promise<OutreachJob | null> => {
  const result = await db.query<OutreachJob>(
    `
      WITH next_job AS (
        SELECT id
        FROM outreach_jobs
        WHERE status = 'pending'
          AND available_at <= now()
        ORDER BY available_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE outreach_jobs
      SET
        status = 'processing',
        attempt_count = attempt_count + 1,
        claimed_at = now(),
        updated_at = now()
      WHERE id = (
        SELECT id
        FROM next_job
      )
      RETURNING *;
      `,
  );

  return result.rows[0] ?? null;
};

export const completeOutreachJob = async (
  jobId: string,
): Promise<OutreachJob> => {
  const result = await db.query<OutreachJob>(
    `
    UPDATE outreach_jobs
    SET
      status = 'completed',
      updated_at = now()
    WHERE id = $1
      AND status = 'processing'
    RETURNING *;
    `,
    [jobId],
  );

  const job = result.rows[0];

  if (!job) {
    throw new Error("Outreach job is not processing");
  }

  return job;
};

export const retryOutreachJob = async (
  jobId: string,
  errorMessage: string,
  retryAt: Date,
): Promise<OutreachJob> => {
  const result = await db.query<OutreachJob>(
    `
    UPDATE outreach_jobs
    SET
      status = 'pending',
      last_error = $2,
      available_at = $3,
      claimed_at = null,
      updated_at = now()
    WHERE id = $1
      AND status = 'processing'
    RETURNING *;
    `,
    [jobId, errorMessage, retryAt],
  );

  const job = result.rows[0];

  if (!job) {
    throw new Error("Outreach job is not processing");
  }

  return job;
};

export const failOutreachJob = async (
  jobId: string,
  errorMessage: string,
): Promise<OutreachJob> => {
  const result = await db.query<OutreachJob>(
    `
    UPDATE outreach_jobs
    SET
      status = 'failed',
      last_error = $2,
      updated_at = now()
    WHERE id = $1
      AND status = 'processing'
    RETURNING *;
    `,
    [jobId, errorMessage],
  );

  const job = result.rows[0];

  if (!job) {
    throw new Error("Outreach job is not processing");
  }

  return job;
};

export const findStaleOutreachJobs = async (
  staleBefore: Date,
): Promise<OutreachJob[]> => {
  const result = await db.query<OutreachJob>(
    `
    SELECT *
    FROM outreach_jobs
    WHERE status = 'processing'
      AND claimed_at IS NOT NULL
      AND claimed_at < $1
    ORDER BY claimed_at ASC;
    `,
    [staleBefore],
  );

  return result.rows;
};

export const requeueFailedOutreachJob = async (
  jobId: string,
): Promise<OutreachJob> => {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const stateResult = await client.query<
      OutreachJob & {
        draft_send_status: string;
        review_status: string;
        sent_message_id: string | null;
        sent_at: Date | null;
        prospect_stage: string;
      }
    >(
      `
        SELECT
          j.*,
          d.send_status AS draft_send_status,
          d.review_status,
          d.sent_message_id,
          d.sent_at,
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
      throw new Error("Outreach job not found");
    }

    if (state.status !== "failed") {
      throw new Error(
        `Outreach job cannot be requeued. Current status: ${state.status}`,
      );
    }

    if (state.draft_send_status !== "pending") {
      throw new Error(
        `Outreach draft is not safe to requeue. Current send status: ${state.draft_send_status}`,
      );
    }

    if (state.review_status !== "approved") {
      throw new Error("Outreach draft is not approved");
    }

    if (state.prospect_stage !== "draft_ready") {
      throw new Error(
        `Prospect is not ready for outreach. Current stage: ${state.prospect_stage}`,
      );
    }

    if (state.sent_message_id || state.sent_at) {
      throw new Error("Outreach draft already contains confirmed send evidence");
    }

    const updatedResult = await client.query<OutreachJob>(
      `
        UPDATE outreach_jobs
        SET
          status = 'pending',
          available_at = now(),
          claimed_at = NULL,
          updated_at = now()
        WHERE id = $1
          AND status = 'failed'
        RETURNING *;
      `,
      [jobId],
    );

    const updatedJob = updatedResult.rows[0];

    if (!updatedJob) {
      throw new Error("Failed to requeue outreach job");
    }

    await client.query("COMMIT");

    return updatedJob;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
