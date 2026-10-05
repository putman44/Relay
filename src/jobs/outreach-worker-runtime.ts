// src/jobs/outreach-worker-runtime.ts

import type { GmailEnvironment } from "../gmail/gmail-auth.js";
import { createProductionGmailDraftSender } from "../gmail/gmail-runtime.js";
import type { ProcessOutreachJob } from "./outreach-worker.js";
import { processOutreachJob } from "./process-outreach-job.js";

export function createProductionOutreachProcessor(
  environment: GmailEnvironment = process.env,
): ProcessOutreachJob {
  const sendDraft = createProductionGmailDraftSender(environment);

  return async (job) => {
    await processOutreachJob(job, sendDraft);
  };
}
