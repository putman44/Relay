import { z } from "zod";
import { ExecutionIdentitySchema, type ExecutionIdentity } from "./contracts.js";
import { CheckpointRunIdSchema, validateRunCheckpoint, type RunCheckpoint } from "./checkpoint.js";
import { type CompletedStage, type StageDecisionKind, type TaskStatus, type TaskStage } from "./state.js";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Text = z.string().min(1).refine((value) => value.trim() === value);
const WorkItemId = Text.refine((value) => value.trim().length > 0);
const References = z.array(Text).min(1);
const Stage = z.enum(["PENDING", "IMPLEMENTING", "VERIFYING", "PUBLISHING", "IN_REVIEW"]);
const Decision = z.enum([
  "DISPATCH_APPROVED", "IMPLEMENTATION_CONFIRMED", "VERIFICATION_PASSED",
  "PUBLICATION_CONFIRMED", "REVIEW_PASSED",
]);

const ExecutionProofSchema = z.strictObject({
  executionRecordId: Text,
  identity: ExecutionIdentitySchema,
  commitSha: Sha,
  evidenceReferences: References,
});
const StageEvidenceSchema = z.strictObject({
  stage: Stage,
  decision: Decision,
  valid: z.boolean(),
  recordedEvidenceReferences: References,
  evidenceReferences: References,
  executionRecordId: Text,
  identity: ExecutionIdentitySchema,
  commitSha: Sha.optional(),
});
const TaskObservationSchema = z.strictObject({
  dependenciesValid: z.boolean(),
  environmentAuthorized: z.boolean(),
  blockerResolved: z.boolean().optional(),
  verifiedCommitEvidence: ExecutionProofSchema.optional(),
  completedStageEvidence: z.array(StageEvidenceSchema),
});
const CurrentObservationsSchema = z.strictObject({
  runId: CheckpointRunIdSchema,
  workItemId: WorkItemId,
  repository: z.strictObject({ repositoryId: Text, branch: Text, observedHeadSha: Sha }),
  authorizedRequirementsVersion: Text,
  authorizationEvidenceReferences: References,
  tasks: z.record(z.string(), TaskObservationSchema),
});

/** Supplied by the orchestrator from independent current context, not copied from the checkpoint or an agent response. */
export type TrustedCurrentObservations = z.infer<typeof CurrentObservationsSchema>;
type TaskObservation = z.infer<typeof TaskObservationSchema>;
type StageEvidence = z.infer<typeof StageEvidenceSchema>;

export type ReconciliationReasonCode =
  | "INVALID_CHECKPOINT" | "INVALID_OBSERVATIONS" | "RUN_ID_MISMATCH" | "WORK_ITEM_ID_MISMATCH"
  | "REPOSITORY_IDENTITY_MISMATCH"
  | "REPOSITORY_COMMIT_MISSING" | "REPOSITORY_COMMIT_MISMATCH" | "REQUIREMENTS_MISMATCH"
  | "TASK_OBSERVATION_MISSING" | "DEPENDENCIES_INVALID" | "ENVIRONMENT_UNAUTHORIZED"
  | "STAGE_EVIDENCE_MISSING" | "STAGE_EVIDENCE_INVALID" | "STAGE_EVIDENCE_INCONSISTENT"
  | "EXECUTION_IDENTITY_MISMATCH" | "COMMIT_EVIDENCE_MISSING" | "COMMIT_EVIDENCE_MISMATCH"
  | "BLOCKER_UNRESOLVED" | "SEPARATE_RESUME_REQUIRED";

export interface ReconciliationReason {
  code: ReconciliationReasonCode;
  detail: string;
  taskId?: string;
  stage?: CompletedStage;
}

export interface TaskReconciliation {
  taskId: string;
  recordedStatus: TaskStatus;
  /** Advisory only. A later policy check and, for BLOCKED, a separate RESUME decision are required. */
  earliestStage: TaskStage | null;
  reusableStages: readonly CompletedStage[];
  disposition: "STOP" | "BLOCKED" | "REVALIDATION_REQUIRED" | "INCOMPLETE" | "RECORDED_COMPLETE";
  reasons: readonly ReconciliationReason[];
}

export interface CheckpointReconciliation {
  status: "RECONCILED" | "INVALID_CHECKPOINT" | "INVALID_OBSERVATIONS";
  reasons: readonly ReconciliationReason[];
  tasks: readonly TaskReconciliation[];
  /** Reconciliation is never a dispatch or recovery authorization. */
  authorizesDispatch: false;
}

const requiredRole = (stage: CompletedStage): "implementer" | "reviewer" =>
  stage === "IN_REVIEW" ? "reviewer" : "implementer";
const sameReferences = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((reference, index) => reference === right[index]);
const sameIdentity = (left: ExecutionIdentity, right: ExecutionIdentity): boolean =>
  left.schemaVersion === right.schemaVersion && left.runId === right.runId &&
  left.taskId === right.taskId && left.attemptId === right.attemptId &&
  left.requirementsVersion === right.requirementsVersion;

function executionMatches(
  checkpoint: RunCheckpoint,
  taskId: string,
  recordId: string,
  identity: ExecutionIdentity,
  role: "implementer" | "reviewer",
  requirementsVersion: string,
  commitSha?: string,
): boolean {
  if (identity.runId !== checkpoint.runId || identity.taskId !== taskId ||
      identity.requirementsVersion !== requirementsVersion) return false;
  const records = checkpoint.executionRecords.filter((record) => record.recordId === recordId);
  const recorded = records[0];
  return records.length === 1 && recorded?.role === role &&
    sameIdentity(recorded.identity, identity) &&
    (commitSha === undefined || recorded.commitSha === commitSha);
}

function stageReason(
  checkpoint: RunCheckpoint,
  taskId: string,
  completion: { stage: CompletedStage; decision: StageDecisionKind; evidenceReferences: readonly string[] },
  evidence: StageEvidence | undefined,
  requirementsVersion: string,
  recordedCommitSha: string | undefined,
  commitProof: TaskObservation["verifiedCommitEvidence"],
): ReconciliationReason | null {
  const stage = completion.stage;
  if (!evidence) return { code: "STAGE_EVIDENCE_MISSING", detail: "Current stage evidence is missing", taskId, stage };
  if (!evidence.valid) return { code: "STAGE_EVIDENCE_INVALID", detail: "Current assessment invalidates this stage", taskId, stage };
  if (evidence.decision !== completion.decision ||
      !sameReferences(evidence.recordedEvidenceReferences, completion.evidenceReferences)) {
    return { code: "STAGE_EVIDENCE_INCONSISTENT", detail: "Current evidence does not identify the recorded stage decision", taskId, stage };
  }
  if (!executionMatches(checkpoint, taskId, evidence.executionRecordId, evidence.identity,
      requiredRole(stage), requirementsVersion, stage === "PENDING" ? undefined : recordedCommitSha)) {
    return { code: "EXECUTION_IDENTITY_MISMATCH", detail: "Stage evidence belongs to a different execution", taskId, stage };
  }
  if (stage !== "PENDING" && stage !== "IN_REVIEW" && commitProof &&
      (evidence.executionRecordId !== commitProof.executionRecordId ||
       !sameIdentity(evidence.identity, commitProof.identity))) {
    return { code: "EXECUTION_IDENTITY_MISMATCH", detail: "Stage and verified commit evidence identify different executions", taskId, stage };
  }
  if (stage === "PENDING" ? evidence.commitSha !== undefined : evidence.commitSha !== recordedCommitSha) {
    return { code: "COMMIT_EVIDENCE_MISMATCH", detail: "Stage evidence is bound to a different commit", taskId, stage };
  }
  return null;
}

function reconcileTask(
  checkpoint: RunCheckpoint,
  record: RunCheckpoint["taskRecords"][number],
  observation: TaskObservation | undefined,
  requirementsVersion: string,
): TaskReconciliation {
  const taskId = record.taskId;
  const recordedStatus = record.state.status;
  const stop = (reason: ReconciliationReason): TaskReconciliation => ({
    taskId, recordedStatus, earliestStage: "PENDING", reusableStages: [],
    disposition: "STOP", reasons: [reason],
  });
  if (!observation) return stop({ code: "TASK_OBSERVATION_MISSING", detail: "Current task observations are missing", taskId });
  if (!observation.dependenciesValid) return stop({ code: "DEPENDENCIES_INVALID", detail: "Current dependency validity is unproven", taskId });
  if (!observation.environmentAuthorized) return stop({ code: "ENVIRONMENT_UNAUTHORIZED", detail: "Current environment authorization is missing", taskId });

  const completed = record.state.completedStages;
  const evidenceByStage = new Map<CompletedStage, StageEvidence>();
  for (const evidence of observation.completedStageEvidence) {
    if (evidenceByStage.has(evidence.stage) || !completed.some((item) => item.stage === evidence.stage)) {
      return stop({ code: "STAGE_EVIDENCE_INCONSISTENT", detail: "Current stage evidence is duplicate or unexpected", taskId, stage: evidence.stage });
    }
    evidenceByStage.set(evidence.stage, evidence);
  }

  const reusableStages: CompletedStage[] = [];
  const reasons: ReconciliationReason[] = [];
  for (const completion of completed) {
    if (completion.stage === "IMPLEMENTING") {
      const proof = observation.verifiedCommitEvidence;
      if (!proof) {
        reasons.push({ code: "COMMIT_EVIDENCE_MISSING", detail: "Current verified commit evidence is missing", taskId, stage: completion.stage });
        break;
      }
      if (proof.commitSha !== record.recordedCommitSha) {
        reasons.push({ code: "COMMIT_EVIDENCE_MISMATCH", detail: "Current verified commit differs from the recorded task commit", taskId, stage: completion.stage });
        break;
      }
      if (!executionMatches(checkpoint, taskId, proof.executionRecordId, proof.identity,
          "implementer", requirementsVersion, proof.commitSha)) {
        reasons.push({ code: "EXECUTION_IDENTITY_MISMATCH", detail: "Verified commit evidence belongs to a different execution", taskId, stage: completion.stage });
        break;
      }
    }
    const reason = stageReason(checkpoint, taskId, completion, evidenceByStage.get(completion.stage),
      requirementsVersion, record.recordedCommitSha, observation.verifiedCommitEvidence);
    if (reason) {
      reasons.push(reason);
      break;
    }
    reusableStages.push(completion.stage);
  }

  const earliestStage: TaskStage | null = reusableStages.length < completed.length
    ? completed[reusableStages.length]!.stage
    : recordedStatus === "BLOCKED"
      ? record.state.blockHistory.at(-1)!.lastValidStage
      : recordedStatus === "VERIFIED" ? null : recordedStatus;

  if (recordedStatus === "BLOCKED") {
    reasons.push({
      code: observation.blockerResolved === true ? "SEPARATE_RESUME_REQUIRED" : "BLOCKER_UNRESOLVED",
      detail: observation.blockerResolved === true
        ? "A separate trusted RESUME decision is required to clear the recorded blocker"
        : "The recorded blocker has not been independently resolved",
      taskId,
    });
    return { taskId, recordedStatus, earliestStage, reusableStages, disposition: "BLOCKED", reasons };
  }
  const disposition = reasons.length > 0 ? "REVALIDATION_REQUIRED"
    : earliestStage === null ? "RECORDED_COMPLETE" : "INCOMPLETE";
  return { taskId, recordedStatus, earliestStage, reusableStages, disposition, reasons };
}

/** Compare recorded history with independent current observations. The caller must establish runId and workItemId from orchestrator context. Never transitions state or grants authority. */
export function reconcileCheckpoint(checkpointValue: unknown, observationsValue: unknown): CheckpointReconciliation {
  const validation = validateRunCheckpoint(checkpointValue);
  if (!validation.valid) {
    return { status: "INVALID_CHECKPOINT", reasons: [{ code: "INVALID_CHECKPOINT", detail: validation.error.detail }],
      tasks: [], authorizesDispatch: false };
  }
  const parsed = CurrentObservationsSchema.safeParse(observationsValue);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") || "observations";
    return { status: "INVALID_OBSERVATIONS", reasons: [{ code: "INVALID_OBSERVATIONS", detail: `Invalid current observations at ${path}` }],
      tasks: [], authorizesDispatch: false };
  }
  const checkpoint = validation.checkpoint;
  const observations = parsed.data;
  const reasons: ReconciliationReason[] = [];
  if (checkpoint.runId !== observations.runId) {
    reasons.push({ code: "RUN_ID_MISMATCH", detail: "Current engineering run differs from the checkpoint" });
  }
  if (checkpoint.workItemId !== observations.workItemId) {
    reasons.push({ code: "WORK_ITEM_ID_MISMATCH", detail: "Current work item differs from the checkpoint" });
  }
  if (checkpoint.repository.repositoryId !== observations.repository.repositoryId ||
      checkpoint.repository.branch !== observations.repository.branch) {
    reasons.push({ code: "REPOSITORY_IDENTITY_MISMATCH", detail: "Current repository or branch differs from the checkpoint" });
  }
  if (!checkpoint.repository.observedHeadSha) {
    reasons.push({ code: "REPOSITORY_COMMIT_MISSING", detail: "Checkpoint has no recorded repository commit to compare" });
  } else if (checkpoint.repository.observedHeadSha !== observations.repository.observedHeadSha) {
    reasons.push({ code: "REPOSITORY_COMMIT_MISMATCH", detail: "Current repository commit differs from the checkpoint" });
  }
  if (checkpoint.authorizedRequirementsVersion !== observations.authorizedRequirementsVersion) {
    reasons.push({ code: "REQUIREMENTS_MISMATCH", detail: "Current authorized requirements version differs from the checkpoint" });
  }

  const tasks: TaskReconciliation[] = reasons.length > 0
    ? checkpoint.taskRecords.map((record) => ({
        taskId: record.taskId, recordedStatus: record.state.status, earliestStage: "PENDING",
        reusableStages: [], disposition: "STOP", reasons: [...reasons],
      }))
    : checkpoint.taskRecords.map((record) => reconcileTask(checkpoint, record,
        Object.hasOwn(observations.tasks, record.taskId) ? observations.tasks[record.taskId] : undefined,
        observations.authorizedRequirementsVersion));
  return { status: "RECONCILED", reasons, tasks, authorizesDispatch: false };
}
