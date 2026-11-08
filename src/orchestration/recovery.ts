import { z } from "zod";
import { ExecutionIdentitySchema, type ExecutionIdentity } from "./contracts.js";
import type { RunCheckpoint } from "./checkpoint.js";
import { reconcileCheckpoint, type ReconciliationReason, type TrustedCurrentObservations } from "./reconcile.js";
import { applyTaskTransition, type TaskStage, type TaskState, type TrustedRecoveryDecision } from "./state.js";

/** A separate, caller-verified recovery decision. References identify evidence; this module cannot verify its source. */
export interface TrustedTaskRecoveryEvidence {
  runId: string;
  workItemId: string;
  taskId: string;
  repositoryId: string;
  branch: string;
  headSha: string;
  requirementsVersion: string;
  /** Required when agent execution is recorded; absent only for a pre-execution PENDING block. */
  executionRecordId?: string;
  executionIdentity?: ExecutionIdentity;
  commitSha?: string;
  blockIndex: number;
  recordedBlockEvidenceReferences: readonly string[];
  blockerResolutionEvidenceReferences: readonly string[];
  repositoryEvidenceReferences: readonly string[];
  requirementsEvidenceReferences: readonly string[];
  dependencyEvidenceReferences: readonly string[];
  environmentEvidenceReferences: readonly string[];
  decision: TrustedRecoveryDecision;
}

const Text = z.string().min(1).refine((value) => value.trim() === value);
const References = z.array(Text).min(1);
const TrustedRecoveryEvidenceSchema = z.strictObject({
  runId: Text, workItemId: Text, taskId: Text, repositoryId: Text, branch: Text,
  headSha: z.string().regex(/^[0-9a-f]{40}$/), requirementsVersion: Text,
  executionRecordId: Text.optional(), executionIdentity: ExecutionIdentitySchema.optional(),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  blockIndex: z.number().int().nonnegative(),
  recordedBlockEvidenceReferences: References,
  blockerResolutionEvidenceReferences: References,
  repositoryEvidenceReferences: References,
  requirementsEvidenceReferences: References,
  dependencyEvidenceReferences: References,
  environmentEvidenceReferences: References,
  decision: z.strictObject({
    blockerResolved: z.boolean(), requirementsValid: z.boolean(), repositoryValid: z.boolean(),
    dependenciesValid: z.boolean(), environmentAuthorized: z.boolean(),
    evidenceReferences: References,
    stageRevalidations: z.array(z.strictObject({
      stage: z.enum(["PENDING", "IMPLEMENTING", "VERIFYING", "PUBLISHING", "IN_REVIEW"]),
      valid: z.boolean(), evidenceReferences: References,
    })),
  }),
});

export type RecoveryDecisionKind =
  | "NO_RECOVERY_NEEDED" | "CONTINUE_INCOMPLETE" | "REVALIDATION_REQUIRED"
  | "BLOCKER_ACTIVE" | "RESUME_ELIGIBLE" | "STOP";

export interface TaskRecoveryResult {
  taskId: string;
  decision: RecoveryDecisionKind;
  nextStage: TaskStage | null;
  /** Present only after the existing RESUME transition accepts a separate trusted decision. */
  state?: TaskState;
  reasons: readonly (ReconciliationReason | { code: string; detail: string; taskId: string })[];
  authorizesDispatch: false;
}

const nonempty = (references: readonly string[]): boolean =>
  references.length > 0 && references.every((reference) => typeof reference === "string" && reference.trim().length > 0);
const sameReferences = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((reference, index) => reference === right[index]);
const sameIdentity = (left: ExecutionIdentity, right: ExecutionIdentity): boolean =>
  left.schemaVersion === right.schemaVersion && left.runId === right.runId &&
  left.taskId === right.taskId && left.attemptId === right.attemptId &&
  left.requirementsVersion === right.requirementsVersion;

/** Reconcile before evaluating a task. Neither checkpoint data nor reconciliation authorizes RESUME. */
export function recoverTask(
  checkpoint: RunCheckpoint,
  observations: TrustedCurrentObservations,
  taskId: string,
  trusted?: TrustedTaskRecoveryEvidence,
): TaskRecoveryResult {
  const reconciliation = reconcileCheckpoint(checkpoint, observations);
  const result = (decision: RecoveryDecisionKind, nextStage: TaskStage | null,
    reasons: TaskRecoveryResult["reasons"], state?: TaskState): TaskRecoveryResult => ({
    taskId, decision, nextStage, reasons, ...(state ? { state } : {}), authorizesDispatch: false,
  });
  const reason = (code: string, detail: string) => ({ code, detail, taskId });
  if (reconciliation.status !== "RECONCILED") {
    return result("STOP", null, reconciliation.reasons);
  }
  const task = reconciliation.tasks.find((item) => item.taskId === taskId);
  const record = checkpoint.taskRecords.find((item) => item.taskId === taskId);
  if (!task || !record) return result("STOP", null, [reason("UNKNOWN_TASK", "Task is absent from the checkpoint")]);
  if (task.disposition === "STOP") return result("STOP", null, task.reasons);
  if (task.disposition === "RECORDED_COMPLETE") return result("NO_RECOVERY_NEEDED", null, []);
  if (task.disposition === "INCOMPLETE") return result("CONTINUE_INCOMPLETE", task.earliestStage, []);
  if (task.disposition === "REVALIDATION_REQUIRED") {
    return result("REVALIDATION_REQUIRED", task.earliestStage, task.reasons);
  }
  if (task.reasons.some((item) => item.code === "BLOCKER_UNRESOLVED")) {
    return result("BLOCKER_ACTIVE", task.earliestStage, task.reasons);
  }
  // A failed or missing prerequisite requires investigation; RESUME must not clear the blocker.
  if (task.reusableStages.length !== record.state.completedStages.length ||
      task.reasons.some((item) => item.code !== "SEPARATE_RESUME_REQUIRED")) {
    return result("REVALIDATION_REQUIRED", task.earliestStage, task.reasons);
  }
  if (!trusted) {
    return result("REVALIDATION_REQUIRED", task.earliestStage,
      [reason("TRUSTED_RECOVERY_MISSING", "Separate trusted recovery evidence is required")]);
  }
  const parsed = TrustedRecoveryEvidenceSchema.safeParse(trusted);
  if (!parsed.success) {
    return result("STOP", null,
      [reason("INVALID_RECOVERY_EVIDENCE", "Trusted recovery evidence is incomplete or malformed")]);
  }
  const proof = parsed.data;

  const block = record.state.blockHistory.at(-1)!;
  const current = observations.tasks[taskId];
  const recordedAgentExecution = checkpoint.executionRecords.some((item) =>
    item.role !== "planner" && item.identity.taskId === taskId);
  const preExecutionBlock = block.lastValidStage === "PENDING" &&
    record.state.completedStages.length === 0 && record.state.invalidatedStages.length === 0 &&
    record.recordedCommitSha === undefined && !recordedAgentExecution &&
    current?.completedStageEvidence.length === 0 && current.verifiedCommitEvidence === undefined;
  const execution = checkpoint.executionRecords.find((item) => item.recordId === proof.executionRecordId);
  const executionContextValid = preExecutionBlock
    ? proof.executionRecordId === undefined && proof.executionIdentity === undefined && proof.commitSha === undefined
    : proof.executionRecordId !== undefined && proof.executionIdentity !== undefined &&
      execution?.role !== "planner" && execution?.identity.taskId === taskId &&
      sameIdentity(execution.identity, proof.executionIdentity) &&
      proof.executionIdentity.runId === observations.runId &&
      proof.executionIdentity.requirementsVersion === observations.authorizedRequirementsVersion &&
      proof.commitSha === record.recordedCommitSha &&
      (record.recordedCommitSha === undefined || execution.commitSha === record.recordedCommitSha) &&
      (!current?.completedStageEvidence.length || current.completedStageEvidence.some((evidence) =>
        evidence.executionRecordId === proof.executionRecordId &&
        sameIdentity(evidence.identity, proof.executionIdentity!)));
  const contextValid = proof.runId === observations.runId && proof.runId === checkpoint.runId &&
    proof.workItemId === observations.workItemId && proof.workItemId === checkpoint.workItemId &&
    proof.taskId === taskId && proof.repositoryId === observations.repository.repositoryId &&
    proof.branch === observations.repository.branch && proof.headSha === observations.repository.observedHeadSha &&
    proof.requirementsVersion === observations.authorizedRequirementsVersion &&
    proof.blockIndex === record.state.blockHistory.length - 1 &&
    sameReferences(proof.recordedBlockEvidenceReferences, block.evidenceReferences) &&
    executionContextValid;
  if (!contextValid) {
    return result("STOP", null, [reason("RECOVERY_IDENTITY_MISMATCH", "Recovery proof does not match this run, task, blocker, execution, requirements, or commit")]);
  }
  if (!current || !current.blockerResolved ||
      !nonempty(proof.blockerResolutionEvidenceReferences) ||
      !nonempty(proof.repositoryEvidenceReferences) ||
      !nonempty(proof.requirementsEvidenceReferences) ||
      !nonempty(proof.dependencyEvidenceReferences) ||
      !nonempty(proof.environmentEvidenceReferences) ||
      !nonempty(proof.decision.evidenceReferences) ||
      !proof.decision.blockerResolved || !proof.decision.repositoryValid ||
      !proof.decision.requirementsValid || !proof.decision.dependenciesValid ||
      !proof.decision.environmentAuthorized) {
    return result("REVALIDATION_REQUIRED", task.earliestStage,
      [reason("RECOVERY_PROOF_INCOMPLETE", "Blocker resolution or a current prerequisite lacks trusted evidence")]);
  }
  const revalidations = proof.decision.stageRevalidations;
  if (revalidations.length !== record.state.completedStages.length ||
      !revalidations.every((item, index) => {
        const completion = record.state.completedStages[index];
        const observed = current.completedStageEvidence.find((evidence) => evidence.stage === item.stage);
        return completion?.stage === item.stage && item.valid === true && observed?.valid === true &&
          nonempty(item.evidenceReferences) && sameReferences(item.evidenceReferences, observed.evidenceReferences);
      })) {
    return result("REVALIDATION_REQUIRED", task.earliestStage,
      [reason("STAGE_REVALIDATION_INVALID", "Completed stages lack matching current trusted revalidation")]);
  }
  const transition = applyTaskTransition(record.state, { type: "RESUME", decision: proof.decision });
  if (!transition.applied) {
    return result("STOP", null, [reason("RESUME_REJECTED", transition.reason)]);
  }
  return result("RESUME_ELIGIBLE", transition.state.status as TaskStage, [], transition.state);
}
