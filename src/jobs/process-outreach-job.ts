// src/jobs/process-outreach-job.ts

import type {
  GmailDraftSender,
  GmailResultFinalizer,
  GmailSendResult,
} from "../gmail/gmail-types.js";
import { handleGmailSendResult } from "../gmail/handle-gmail-result.js";
import {
  claimOutreachSend,
  type CompleteOutreachResult,
} from "../outreach/outreach-send.js";
import { NonRetryableOutreachJobError } from "./non-retryable-job-error.js";
import type { OutreachJob } from "./outreach-jobs.js";
import { resolveOutreachJobDraft } from "./resolve-outreach-job-draft.js";

export async function processOutreachJob(
  job: OutreachJob,
  sendDraft: GmailDraftSender,
  finalizeResult: GmailResultFinalizer = handleGmailSendResult,
) {
  const draft = await resolveOutreachJobDraft(job);

  const claim = await claimOutreachSend(draft.prospect_id, draft.id);

  if (!claim.claimed) {
    throw new NonRetryableOutreachJobError(claim.reason);
  }

  const gmailDraftId = claim.draft.gmail_draft_id;

  if (!gmailDraftId) {
    throw new NonRetryableOutreachJobError(
      `Claimed draft ${claim.draft.id} has no Gmail draft ID`,
    );
  }

  let gmailResult: GmailSendResult;

  try {
    gmailResult = await sendDraft(gmailDraftId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    let reconciliation: CompleteOutreachResult;

    try {
      reconciliation = await finalizeResult(
        claim.draft.prospect_id,
        claim.draft.id,
        {
          status: "uncertain",
          error: errorMessage,
        },
      );
    } catch (finalizationError) {
      const finalizationMessage =
        finalizationError instanceof Error
          ? finalizationError.message
          : String(finalizationError);

      throw new NonRetryableOutreachJobError(
        `Gmail outcome is uncertain for draft ${claim.draft.id}, and reconciliation could not be persisted: ${finalizationMessage}`,
      );
    }

    if (!reconciliation.completed) {
      throw new NonRetryableOutreachJobError(
        `Could not reconcile outreach draft ${claim.draft.id}: ${reconciliation.reason}`,
      );
    }

    throw new NonRetryableOutreachJobError(
      `Gmail send outcome uncertain for draft ${claim.draft.id}: ${errorMessage}`,
    );
  }

  let finalization: CompleteOutreachResult;

  try {
    finalization = await finalizeResult(
      claim.draft.prospect_id,
      claim.draft.id,
      gmailResult,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    throw new NonRetryableOutreachJobError(
      `Could not persist Gmail ${gmailResult.status} result for draft ${claim.draft.id}: ${errorMessage}`,
    );
  }

  if (!finalization.completed) {
    throw new NonRetryableOutreachJobError(
      `Could not finalize outreach draft ${claim.draft.id}: ${finalization.reason}`,
    );
  }

  if (gmailResult.status === "uncertain") {
    throw new NonRetryableOutreachJobError(
      `Gmail send outcome uncertain for draft ${claim.draft.id}: ${gmailResult.error}`,
    );
  }

  return {
    claim,
    gmailResult,
    finalization,
  };
}
