// src/jobs/resolve-outreach-job-draft.ts

import type { MessageDraft } from "../outreach/message-drafts.js";
import { getMessageDraftById } from "../outreach/message-drafts.js";
import { NonRetryableOutreachJobError } from "./non-retryable-job-error.js";
import type { OutreachJob } from "./outreach-jobs.js";

export async function resolveOutreachJobDraft(
  job: OutreachJob,
): Promise<MessageDraft> {
  const draft = await getMessageDraftById(job.draft_id);

  if (!draft) {
    throw new NonRetryableOutreachJobError(
      `Outreach draft ${job.draft_id} not found for job ${job.id}`,
    );
  }

  return draft;
}
