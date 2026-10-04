// src/outreach-worker.ts

import {
  claimNextOutreachJob,
  completeOutreachJob,
  failOutreachJob,
  retryOutreachJob,
  type OutreachJob,
} from "./outreach-jobs.js";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60_000;

export type ProcessOutreachJob = (job: OutreachJob) => Promise<void>;

export const runOutreachWorkerOnce = async (
  processJob: ProcessOutreachJob,
): Promise<OutreachJob | null> => {
  const job = await claimNextOutreachJob();

  if (!job) {
    return null;
  }

  try {
    await processJob(job);

    return completeOutreachJob(job.id);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown processing error";

    if (job.attempt_count < MAX_ATTEMPTS) {
      const retryAt = new Date(Date.now() + RETRY_DELAY_MS);

      return retryOutreachJob(job.id, errorMessage, retryAt);
    }

    return failOutreachJob(job.id, errorMessage);
  }
};
