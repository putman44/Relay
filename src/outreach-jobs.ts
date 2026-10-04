// src/outreach-jobs.ts

import { db } from "./db.js";
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
