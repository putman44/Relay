// src/operator/outreach-operator-run.ts
import type { ReconcileAndRequeueResult } from "../jobs/outreach-reconciliation.js";
import type {
  ApproveOutreachDraftResult,
  QueueApprovedOutreachDraftResult,
} from "../outreach/outreach-review-actions.js";
import type { OutreachReview } from "../outreach/outreach-review.js";
import { parseOutreachOperatorArgs } from "./outreach-operator-args.js";
import type { OutreachJobInspection } from "./outreach-operator-inspect.js";

export type OutreachOperatorDependencies = {
  approveDraft?: (
    prospectId: string,
    draftId: string,
  ) => Promise<ApproveOutreachDraftResult>;
  getReview?: (prospectId: string) => Promise<OutreachReview | null>;
  inspectJob: (jobId: string) => Promise<OutreachJobInspection | null>;
  queueDraft?: (
    prospectId: string,
    draftId: string,
  ) => Promise<QueueApprovedOutreachDraftResult>;
  reconcileNotSent?: (jobId: string) => Promise<ReconcileAndRequeueResult>;
  inspectQueue: () => Promise<OutreachJobInspection[]>;
};

export type OutreachOperatorOutput = (
  value:
    | OutreachJobInspection
    | OutreachJobInspection[]
    | OutreachReview
    | ApproveOutreachDraftResult
    | QueueApprovedOutreachDraftResult
    | ReconcileAndRequeueResult,
) => void;

export const runOutreachOperator = async (
  args: string[],
  dependencies: OutreachOperatorDependencies,
  output: OutreachOperatorOutput,
): Promise<void> => {
  const command = parseOutreachOperatorArgs(args);

  if (command.command === "inspect") {
    if (command.jobId) {
      const inspection = await dependencies.inspectJob(command.jobId);

      if (!inspection) {
        throw new Error(`Outreach job not found: ${command.jobId}`);
      }

      output(inspection);
      return;
    }

    const queue = await dependencies.inspectQueue();
    output(queue);
    return;
  }

  if (command.command === "review") {
    if (!dependencies.getReview) {
      throw new Error("Review execution not implemented");
    }

    const review = await dependencies.getReview(command.prospectId);

    if (!review) {
      throw new Error(`Outreach prospect not found: ${command.prospectId}`);
    }

    output(review);
    return;
  }

  if (command.command === "approve") {
    if (!dependencies.approveDraft) {
      throw new Error("Approval execution not implemented");
    }

    const result = await dependencies.approveDraft(
      command.prospectId,
      command.draftId,
    );

    if (!result.approved) {
      throw new Error(result.reason);
    }

    output(result);
    return;
  }

  if (command.command === "queue") {
    if (!dependencies.queueDraft) {
      throw new Error("Queue execution not implemented");
    }

    const result = await dependencies.queueDraft(
      command.prospectId,
      command.draftId,
    );

    if (!result.queued) {
      throw new Error(result.reason);
    }

    output(result);
    return;
  }

  if (command.command === "reconcile-not-sent") {
    if (!dependencies.reconcileNotSent) {
      throw new Error("Reconciliation execution not implemented");
    }

    const result = await dependencies.reconcileNotSent(command.jobId);

    if (!result.reconciled) {
      throw new Error(result.reason);
    }

    output(result);
    return;
  }
};
