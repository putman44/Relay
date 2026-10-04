// src/jobs/outreach-worker.ts

import { NonRetryableOutreachJobError } from "./non-retryable-job-error.js";
import {
  claimNextOutreachJob,
  completeOutreachJob,
  failOutreachJob,
  retryOutreachJob,
  type OutreachJob,
} from "./outreach-jobs.js";

export type OutreachWorkerEvent =
  | {
      type: "claimed";
      jobId: string;
      attemptCount: number;
    }
  | {
      type: "completed";
      jobId: string;
      attemptCount: number;
    }
  | {
      type: "retry_scheduled";
      jobId: string;
      attemptCount: number;
      error: string;
      retryAt: Date;
    }
  | {
      type: "failed";
      jobId: string;
      attemptCount: number;
      error: string;
    }
  | {
      type: "empty";
    };

export type OutreachWorkerLogger = (event: OutreachWorkerEvent) => void;

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60_000;

export type ProcessOutreachJob = (job: OutreachJob) => Promise<void>;

export const runOutreachWorkerOnce = async (
  processJob: ProcessOutreachJob,
  logger?: OutreachWorkerLogger,
): Promise<OutreachJob | null> => {
  const job = await claimNextOutreachJob();

  if (!job) {
    logger?.({
      type: "empty",
    });

    return null;
  }

  logger?.({
    type: "claimed",
    jobId: job.id,
    attemptCount: job.attempt_count,
  });

  try {
    await processJob(job);

    const completedJob = await completeOutreachJob(job.id);

    logger?.({
      type: "completed",
      jobId: completedJob.id,
      attemptCount: completedJob.attempt_count,
    });

    return completedJob;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown processing error";

    if (error instanceof NonRetryableOutreachJobError) {
      const failedJob = await failOutreachJob(job.id, errorMessage);

      logger?.({
        type: "failed",
        jobId: failedJob.id,
        attemptCount: failedJob.attempt_count,
        error: errorMessage,
      });

      return failedJob;
    }

    if (job.attempt_count < MAX_ATTEMPTS) {
      const retryAt = new Date(Date.now() + RETRY_DELAY_MS);

      const retriedJob = await retryOutreachJob(job.id, errorMessage, retryAt);

      logger?.({
        type: "retry_scheduled",
        jobId: retriedJob.id,
        attemptCount: retriedJob.attempt_count,
        error: errorMessage,
        retryAt: retriedJob.available_at,
      });

      return retriedJob;
    }
    const failedJob = await failOutreachJob(job.id, errorMessage);

    logger?.({
      type: "failed",
      jobId: failedJob.id,
      attemptCount: failedJob.attempt_count,
      error: errorMessage,
    });

    return failedJob;
  }
};
