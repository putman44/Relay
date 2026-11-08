import { z } from "zod";
import { ExecutionIdentitySchema, type ExecutionIdentity } from "./contracts.js";
import { validateTaskGraph, type TaskProposal } from "./policy.js";
import { taskStateConsistencyError, type TaskState } from "./state.js";

export const CHECKPOINT_SCHEMA_VERSION = 1 as const;

const Text = z.string().min(1).refine((value) => value.trim() === value && value.trim().length > 0);
const CommitSha = z.string().regex(/^[0-9a-f]{40}$/);
export const CheckpointRunIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const References = z.array(Text).min(1);
const Stage = z.enum(["PENDING", "IMPLEMENTING", "VERIFYING", "PUBLISHING", "IN_REVIEW"]);
const Status = z.enum(["PENDING", "IMPLEMENTING", "VERIFYING", "PUBLISHING", "IN_REVIEW", "VERIFIED", "BLOCKED"]);
const Decision = z.enum([
  "DISPATCH_APPROVED", "IMPLEMENTATION_CONFIRMED", "VERIFICATION_PASSED",
  "PUBLICATION_CONFIRMED", "REVIEW_PASSED",
]);

const StageCompletionSchema = z.strictObject({
  stage: Stage,
  decision: Decision,
  evidenceReferences: References,
});
const BlockingReasonSchema = z.strictObject({
  code: z.enum(["DEPENDENCY", "REQUIREMENTS", "ENVIRONMENT", "EVIDENCE", "EXTERNAL_ACTION", "REVIEW", "SAFETY"]),
  detail: Text,
});
const StageRevalidationSchema = z.strictObject({
  stage: Stage,
  valid: z.boolean(),
  evidenceReferences: References,
});
const TaskStateSchema = z.strictObject({
  status: Status,
  completedStages: z.array(StageCompletionSchema),
  invalidatedStages: z.array(StageCompletionSchema),
  blockHistory: z.array(z.strictObject({
    lastValidStage: Stage,
    reason: BlockingReasonSchema,
    evidenceReferences: References,
    authorizedNextAction: Text,
  })),
  recoveryHistory: z.array(z.strictObject({
    resumedStage: Stage,
    evidenceReferences: References,
    stageRevalidations: z.array(StageRevalidationSchema),
  })),
});

const TaskProposalSchema = z.strictObject({
  taskId: Text,
  dependencies: z.array(Text),
  fileScope: z.array(Text).min(1),
  risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
});
const TaskRecordSchema = z.strictObject({
  taskId: Text,
  state: TaskStateSchema,
  recordedCommitSha: CommitSha.optional(),
});
const ExecutionRecordSchema = z.strictObject({
  recordId: Text,
  role: z.enum(["planner", "implementer", "reviewer"]),
  identity: ExecutionIdentitySchema,
  commitSha: CommitSha.optional(),
  evidenceReferences: References,
});

/** Recorded history only. This schema deliberately contains no dispatch authorization. */
export const RunCheckpointSchema = z.strictObject({
  schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
  revision: z.number().int().positive(),
  runId: CheckpointRunIdSchema,
  repository: z.strictObject({
    repositoryId: Text,
    branch: Text,
    observedHeadSha: CommitSha.optional(),
  }),
  workItemId: Text,
  authorizedRequirementsVersion: Text,
  authorizationEvidenceReferences: References,
  taskGraph: z.array(TaskProposalSchema).min(1),
  taskRecords: z.array(TaskRecordSchema).min(1),
  executionRecords: z.array(ExecutionRecordSchema),
});

export interface CheckpointTaskRecord {
  taskId: string;
  state: TaskState;
  recordedCommitSha?: string | undefined;
}

export interface CheckpointExecutionRecord {
  recordId: string;
  role: "planner" | "implementer" | "reviewer";
  identity: ExecutionIdentity;
  commitSha?: string | undefined;
  evidenceReferences: readonly string[];
}

export interface RunCheckpoint {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  revision: number;
  runId: string;
  repository: { repositoryId: string; branch: string; observedHeadSha?: string | undefined };
  workItemId: string;
  authorizedRequirementsVersion: string;
  authorizationEvidenceReferences: readonly string[];
  taskGraph: readonly TaskProposal[];
  taskRecords: readonly CheckpointTaskRecord[];
  executionRecords: readonly CheckpointExecutionRecord[];
}

export type CheckpointErrorCode =
  | "MISSING" | "CORRUPT" | "UNSUPPORTED_VERSION" | "INVALID_RUN_ID" | "IO_ERROR"
  | "REVISION_CONFLICT" | "RUN_IDENTITY_MISMATCH" | "CONTINUITY_VIOLATION";
export interface CheckpointError {
  code: CheckpointErrorCode;
  detail: string;
}
export type CheckpointValidation =
  | { valid: true; checkpoint: RunCheckpoint }
  | { valid: false; error: CheckpointError };

const corrupt = (detail: string): CheckpointValidation => ({ valid: false, error: { code: "CORRUPT", detail } });

/** Validate recorded data without treating it as current authorization or proof. */
export function validateRunCheckpoint(value: unknown): CheckpointValidation {
  if (value && typeof value === "object" && "schemaVersion" in value &&
      typeof value.schemaVersion === "number" && Number.isInteger(value.schemaVersion) &&
      value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    return { valid: false, error: { code: "UNSUPPORTED_VERSION", detail: "Checkpoint schema version is unsupported" } };
  }
  const parsed = RunCheckpointSchema.safeParse(value);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") || "checkpoint";
    return corrupt(`Invalid checkpoint structure at ${path}`);
  }
  const checkpoint: RunCheckpoint = parsed.data;
  const graph = validateTaskGraph(checkpoint.taskGraph);
  if (!graph.valid) return corrupt(`Invalid task graph: ${graph.issues.map((issue) => issue.code).join(", ")}`);

  const plannedIds = new Set(checkpoint.taskGraph.map((task) => task.taskId));
  const recordedIds = new Set<string>();
  for (const record of checkpoint.taskRecords) {
    if (!plannedIds.has(record.taskId) || recordedIds.has(record.taskId)) {
      return corrupt("Task records do not match the validated graph");
    }
    recordedIds.add(record.taskId);
    const inconsistency = taskStateConsistencyError(record.state);
    if (inconsistency) return corrupt(`Task ${record.taskId} has inconsistent stage history: ${inconsistency}`);
    const blocks = record.state.blockHistory.length;
    const recoveries = record.state.recoveryHistory.length;
    if (blocks !== recoveries + (record.state.status === "BLOCKED" ? 1 : 0)) {
      return corrupt(`Task ${record.taskId} has inconsistent block and recovery history`);
    }
    const activeStage = record.state.status === "BLOCKED"
      ? record.state.blockHistory.at(-1)!.lastValidStage
      : record.state.status;
    if (["VERIFYING", "PUBLISHING", "IN_REVIEW", "VERIFIED"].includes(activeStage) &&
        !record.recordedCommitSha) {
      return corrupt(`Task ${record.taskId} lacks its recorded commit`);
    }
  }
  if (recordedIds.size !== plannedIds.size) return corrupt("A planned task has no recorded state");

  const executionIds = new Set<string>();
  for (const execution of checkpoint.executionRecords) {
    if (executionIds.has(execution.recordId)) return corrupt("Execution record identifiers are duplicated");
    executionIds.add(execution.recordId);
    if (execution.identity.runId !== checkpoint.runId ||
        (execution.role !== "planner" && !plannedIds.has(execution.identity.taskId))) {
      return corrupt("Execution identity does not belong to this run and task graph");
    }
  }
  for (const record of checkpoint.taskRecords) {
    if (record.state.status === "VERIFIED" && !checkpoint.executionRecords.some((execution) =>
      execution.role === "reviewer" && execution.identity.taskId === record.taskId &&
      execution.commitSha === record.recordedCommitSha)) {
      return corrupt(`Verified task ${record.taskId} lacks a matching recorded review execution`);
    }
  }
  return { valid: true, checkpoint };
}
