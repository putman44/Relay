import {
  PlannerResponseSchema,
  ImplementerResponseSchema,
  ReviewerResponseSchema,
  validateResponseContext,
  type ExecutionIdentity,
  type TrustedResponseContext,
} from "./contracts.js";
import {
  evaluateDispatchEligibility,
  type DenialReason,
  type TrustedAuthorizationContext,
  type TrustedVerificationEvidence,
} from "./policy.js";
import {
  applyTaskTransition,
  createPendingTask,
  type BlockingReason,
  type StageDecisionKind,
  type TaskEvent,
  type TaskState,
  type TaskStatus,
} from "./state.js";

export interface InjectedResponse {
  /** Attempt assigned by the simulation harness, independent of the response value. */
  attemptId: string;
  value: unknown;
}

/** Predefined orchestrator-owned input; never constructed from an agent response. */
export interface SimulatedGate {
  identity: ExecutionIdentity;
  kind: StageDecisionKind;
  evidenceReferences: readonly string[];
  commitSha?: string;
}

export interface SimulatedCommitSnapshot {
  identity: ExecutionIdentity;
  commitSha: string;
  changedFiles: readonly string[];
  evidenceReferences: readonly string[];
}

export interface SimulatedReviewBlock {
  identity: ExecutionIdentity;
  commitSha: string;
  reason: BlockingReason;
  evidenceReferences: readonly string[];
  authorizedNextAction: string;
}

export interface SimulatedImplementerBlock {
  identity: ExecutionIdentity;
  reason: BlockingReason;
  evidenceReferences: readonly string[];
  authorizedNextAction: string;
}

export type SimulatedVerifiedTaskEvidence = TrustedVerificationEvidence;

export interface SimulatedTaskInput {
  implementer: InjectedResponse;
  reviewer: InjectedResponse;
  commit?: SimulatedCommitSnapshot;
  gates: Partial<Record<StageDecisionKind, SimulatedGate>>;
  implementerBlock?: SimulatedImplementerBlock;
  reviewBlock?: SimulatedReviewBlock;
  verifiedTaskEvidence?: SimulatedVerifiedTaskEvidence;
}

export interface SimulationInput {
  planner: { value: unknown; context: TrustedResponseContext };
  tasks: Readonly<Record<string, SimulatedTaskInput>>;
  authorization: TrustedAuthorizationContext;
}

export type SimulationTrace =
  | { type: "DISPATCH_DENIED"; taskId: string; reasons: DenialReason[] }
  | { type: "STATE"; taskId: string; status: TaskStatus };

export type SimulationFailureCode =
  | "PLANNER_SCHEMA_INVALID"
  | "PLANNER_CONTEXT_MISMATCH"
  | "PLANNER_BLOCKED"
  | "POLICY_DENIED"
  | "TASK_INPUT_MISSING"
  | "TRUSTED_GATE_MISSING"
  | "TRUSTED_GATE_MISMATCH"
  | "IMPLEMENTER_SCHEMA_INVALID"
  | "IMPLEMENTER_CONTEXT_MISMATCH"
  | "IMPLEMENTER_BLOCK_DECISION_MISSING"
  | "IMPLEMENTER_BLOCK_DECISION_MISMATCH"
  | "COMMIT_EVIDENCE_MISSING"
  | "COMMIT_EVIDENCE_MISMATCH"
  | "IMPLEMENTER_REPORTED_INCOMPLETE"
  | "REVIEWER_SCHEMA_INVALID"
  | "REVIEWER_CONTEXT_MISMATCH"
  | "REVIEWER_REPORTED_INCOMPLETE"
  | "REVIEW_BLOCK_DECISION_MISSING"
  | "REVIEW_BLOCK_DECISION_MISMATCH"
  | "VERIFIED_TASK_EVIDENCE_MISSING"
  | "VERIFIED_TASK_EVIDENCE_MISMATCH"
  | "STATE_TRANSITION_REJECTED";

export interface SimulationResult {
  /** Internal task outcome only; final integration review and merge are outside this simulator. */
  status: "ALL_TASKS_VERIFIED" | "BLOCKED" | "STOPPED";
  states: Readonly<Record<string, TaskState>>;
  trace: readonly SimulationTrace[];
  failure?: { code: SimulationFailureCode; taskId?: string; detail: string };
}

const hasReferences = (references: readonly string[] | undefined): boolean =>
  Array.isArray(references) && references.length > 0 &&
  references.every((reference) => typeof reference === "string" && reference.trim().length > 0);

const blockingReasonCodes: readonly string[] = [
  "DEPENDENCY", "REQUIREMENTS", "ENVIRONMENT", "EVIDENCE",
  "EXTERNAL_ACTION", "REVIEW", "SAFETY",
];

const validBlockText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

const sameIdentity = (actual: unknown, expected: ExecutionIdentity): boolean => {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const identity = actual as Partial<ExecutionIdentity>;
  return Object.keys(identity).length === 5 &&
    identity.schemaVersion === expected.schemaVersion &&
    identity.runId === expected.runId &&
    identity.taskId === expected.taskId &&
    identity.attemptId === expected.attemptId &&
    identity.requirementsVersion === expected.requirementsVersion;
};

const sameFiles = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length > 0 && actual.length === expected.length &&
  new Set(actual).size === actual.length && new Set(expected).size === expected.length &&
  actual.every((file) => expected.includes(file));

/** Pure simulation. The caller owns all trusted identities, evidence and decisions. */
export function simulateOrchestration(input: SimulationInput): SimulationResult {
  const states: Record<string, TaskState> = Object.create(null);
  const trace: SimulationTrace[] = [];
  const stop = (code: SimulationFailureCode, detail: string, taskId?: string): SimulationResult => ({
    status: "STOPPED",
    states,
    trace,
    failure: { code, detail, ...(taskId === undefined ? {} : { taskId }) },
  });
  const parsedPlanner = PlannerResponseSchema.safeParse(input.planner.value);
  if (!parsedPlanner.success) return stop("PLANNER_SCHEMA_INVALID", "Planner response failed structural validation");
  const planner = parsedPlanner.data;
  const plannerContext = validateResponseContext(planner, input.planner.context);
  if (!plannerContext.valid) return stop("PLANNER_CONTEXT_MISMATCH", plannerContext.errors.join("; "));
  if (planner.status === "BLOCKED") return stop("PLANNER_BLOCKED", planner.reason);

  const plannedTasks = planner.plan.tasks;
  for (const task of plannedTasks) {
    if (Object.hasOwn(states, task.taskId)) return stop("POLICY_DENIED", "Duplicate task ID in planner queue", task.taskId);
    states[task.taskId] = createPendingTask();
  }
  const authorization: TrustedAuthorizationContext = {
    ...input.authorization,
    // Every planned task starts PENDING; historical proof cannot preauthorize it.
    verifiedTaskEvidence: {},
    expectedVerifiedCommitByTask: {},
    expectedVerifiedIdentityByTask: {},
  };
  const remaining = new Set(plannedTasks.map((task) => task.taskId));
  const rootIdentity = input.planner.context;
  authorization.currentRunId = rootIdentity.runId;
  let reviewerBlocked = false;

  const advance = (taskId: string, event: TaskEvent): SimulationResult | null => {
    const transition = applyTaskTransition(states[taskId]!, event);
    if (!transition.applied) return stop("STATE_TRANSITION_REJECTED", transition.reason, taskId);
    states[taskId] = transition.state;
    trace.push({ type: "STATE", taskId, status: transition.state.status });
    return null;
  };
  const expectedIdentity = (taskId: string, attemptId: string): ExecutionIdentity => ({
    schemaVersion: rootIdentity.schemaVersion,
    runId: rootIdentity.runId,
    taskId,
    attemptId,
    requirementsVersion: rootIdentity.requirementsVersion,
  });
  const requireGate = (
    taskId: string,
    taskInput: SimulatedTaskInput,
    kind: StageDecisionKind,
    identity: ExecutionIdentity,
    commitSha?: string,
  ): SimulationResult | null => {
    const gate = taskInput.gates[kind];
    if (!gate) return stop("TRUSTED_GATE_MISSING", `${kind} decision is missing`, taskId);
    if (gate.kind !== kind || !sameIdentity(gate.identity, identity) ||
        !hasReferences(gate.evidenceReferences) || gate.commitSha !== commitSha) {
      return stop("TRUSTED_GATE_MISMATCH", `${kind} decision does not match trusted execution`, taskId);
    }
    return advance(taskId, {
      type: "ADVANCE",
      to: ({
        DISPATCH_APPROVED: "IMPLEMENTING",
        IMPLEMENTATION_CONFIRMED: "VERIFYING",
        VERIFICATION_PASSED: "PUBLISHING",
        PUBLICATION_CONFIRMED: "IN_REVIEW",
        REVIEW_PASSED: "VERIFIED",
      } as const)[kind],
      decision: { kind, evidenceReferences: gate.evidenceReferences },
    });
  };

  while (remaining.size > 0) {
    let progressed = false;
    const denials: DenialReason[] = [];
    for (const task of plannedTasks) {
      if (!remaining.has(task.taskId)) continue;
      const eligibility = evaluateDispatchEligibility({
        tasks: plannedTasks,
        taskId: task.taskId,
        proposedRequirementsVersion: planner.requirementsVersion,
        states,
        authorization,
      });
      if (!eligibility.eligible) {
        denials.push(...eligibility.reasons);
        trace.push({ type: "DISPATCH_DENIED", taskId: task.taskId, reasons: eligibility.reasons });
        continue;
      }
      const taskInput = Object.hasOwn(input.tasks, task.taskId) ? input.tasks[task.taskId] : undefined;
      if (!taskInput) return stop("TASK_INPUT_MISSING", "Simulated task inputs are missing", task.taskId);
      const implementerIdentity = expectedIdentity(task.taskId, taskInput.implementer.attemptId);
      const reviewerIdentity = expectedIdentity(task.taskId, taskInput.reviewer.attemptId);
      const dispatchFailure = requireGate(task.taskId, taskInput, "DISPATCH_APPROVED", implementerIdentity);
      if (dispatchFailure) return dispatchFailure;

      const parsedImplementer = ImplementerResponseSchema.safeParse(taskInput.implementer.value);
      if (!parsedImplementer.success) return stop("IMPLEMENTER_SCHEMA_INVALID", "Implementer response failed structural validation", task.taskId);
      const implementer = parsedImplementer.data;
      if (implementer.status === "BLOCKED") {
        const blockedContext = validateResponseContext(implementer, {
          ...implementerIdentity,
          expectedRole: "implementer",
        });
        if (!blockedContext.valid) return stop("IMPLEMENTER_CONTEXT_MISMATCH", blockedContext.errors.join("; "), task.taskId);
        const block = taskInput.implementerBlock;
        if (!block) return stop("IMPLEMENTER_BLOCK_DECISION_MISSING", "Trusted implementer block decision is missing", task.taskId);
        if (!sameIdentity(block.identity, implementerIdentity) ||
            !block.reason || typeof block.reason !== "object" ||
            Array.isArray(block.reason) || Object.keys(block.reason).length !== 2 ||
            !blockingReasonCodes.includes(block.reason?.code) ||
            !validBlockText(block.reason?.detail) ||
            !hasReferences(block.evidenceReferences) ||
            !block.evidenceReferences.every(validBlockText) ||
            !validBlockText(block.authorizedNextAction)) {
          return stop("IMPLEMENTER_BLOCK_DECISION_MISMATCH", "Trusted implementer block decision is stale or incomplete", task.taskId);
        }
        const failure = advance(task.taskId, {
          type: "BLOCK",
          reason: block.reason,
          evidenceReferences: block.evidenceReferences,
          authorizedNextAction: block.authorizedNextAction,
        });
        if (failure) return failure;
        return { status: "BLOCKED", states, trace };
      }
      const commit = taskInput.commit;
      if (!commit) return stop("COMMIT_EVIDENCE_MISSING", "Trusted commit snapshot is missing", task.taskId);
      if (!sameIdentity(commit.identity, implementerIdentity) || !hasReferences(commit.evidenceReferences)) {
        return stop("COMMIT_EVIDENCE_MISMATCH", "Trusted commit snapshot is stale or lacks evidence", task.taskId);
      }
      const implementerContext = validateResponseContext(implementer, {
        ...implementerIdentity,
        expectedRole: "implementer",
        expectedCommitSha: commit.commitSha,
      });
      if (!implementerContext.valid) {
        const code = implementerContext.errors.some((error) => error.includes("commitSha"))
          ? "COMMIT_EVIDENCE_MISMATCH" : "IMPLEMENTER_CONTEXT_MISMATCH";
        return stop(code, implementerContext.errors.join("; "), task.taskId);
      }
      if (!sameFiles(implementer.changedFiles, commit.changedFiles) ||
          commit.changedFiles.some((file) => !task.fileScope.includes(file))) {
        return stop("COMMIT_EVIDENCE_MISMATCH", "Reported and trusted changes or approved task scope differ", task.taskId);
      }
      if (implementer.verificationEvidence.some((evidence) => evidence.result !== "PASSED")) {
        return stop("IMPLEMENTER_REPORTED_INCOMPLETE", "Implementer reported failed or incomplete verification", task.taskId);
      }

      for (const kind of ["IMPLEMENTATION_CONFIRMED", "VERIFICATION_PASSED", "PUBLICATION_CONFIRMED"] as const) {
        const failure = requireGate(task.taskId, taskInput, kind, implementerIdentity, commit.commitSha);
        if (failure) return failure;
      }
      const parsedReviewer = ReviewerResponseSchema.safeParse(taskInput.reviewer.value);
      if (!parsedReviewer.success) return stop("REVIEWER_SCHEMA_INVALID", "Reviewer response failed structural validation", task.taskId);
      const reviewer = parsedReviewer.data;
      const reviewerContext = validateResponseContext(reviewer, {
        ...reviewerIdentity,
        expectedRole: "reviewer",
        expectedCommitSha: commit.commitSha,
      });
      if (!reviewerContext.valid) return stop("REVIEWER_CONTEXT_MISMATCH", reviewerContext.errors.join("; "), task.taskId);

      if (reviewer.status === "BLOCKED") {
        const block = taskInput.reviewBlock;
        if (!block) return stop("REVIEW_BLOCK_DECISION_MISSING", "Trusted review block decision is missing", task.taskId);
        if (!sameIdentity(block.identity, reviewerIdentity) || block.commitSha !== commit.commitSha ||
            !hasReferences(block.evidenceReferences)) {
          return stop("REVIEW_BLOCK_DECISION_MISMATCH", "Trusted review block decision is stale or unsupported", task.taskId);
        }
        const failure = advance(task.taskId, {
          type: "BLOCK",
          reason: block.reason,
          evidenceReferences: block.evidenceReferences,
          authorizedNextAction: block.authorizedNextAction,
        });
        if (failure) return failure;
        authorization.currentRepositoryCommitSha = commit.commitSha;
        remaining.delete(task.taskId);
        reviewerBlocked = true;
        progressed = true;
        continue;
      }

      if (reviewer.coverage.verificationChecks.some((evidence) => evidence.result !== "PASSED")) {
        return stop("REVIEWER_REPORTED_INCOMPLETE", "Reviewer reported failed or incomplete verification", task.taskId);
      }

      const proof = taskInput.verifiedTaskEvidence;
      if (!proof) return stop("VERIFIED_TASK_EVIDENCE_MISSING", "Trusted task verification proof is missing", task.taskId);
      if (!sameIdentity(proof.identity, reviewerIdentity) || proof.commitSha !== commit.commitSha ||
          proof.requirementsVersion !== authorization.currentRequirementsVersion ||
          !hasReferences(proof.evidenceReferences)) {
        return stop("VERIFIED_TASK_EVIDENCE_MISMATCH", "Trusted task verification proof is stale or mismatched", task.taskId);
      }
      const reviewFailure = requireGate(task.taskId, taskInput, "REVIEW_PASSED", reviewerIdentity, commit.commitSha);
      if (reviewFailure) return reviewFailure;
      authorization.verifiedTaskEvidence = {
        ...authorization.verifiedTaskEvidence,
        [task.taskId]: {
          identity: { ...proof.identity },
          requirementsVersion: proof.requirementsVersion,
          commitSha: proof.commitSha,
          evidenceReferences: proof.evidenceReferences,
        },
      };
      authorization.expectedVerifiedCommitByTask = {
        ...authorization.expectedVerifiedCommitByTask,
        [task.taskId]: commit.commitSha,
      };
      authorization.expectedVerifiedIdentityByTask = {
        ...authorization.expectedVerifiedIdentityByTask,
        [task.taskId]: { ...reviewerIdentity },
      };
      authorization.currentRepositoryCommitSha = commit.commitSha;
      remaining.delete(task.taskId);
      progressed = true;
    }
    if (!progressed) {
      if (reviewerBlocked) return { status: "BLOCKED", states, trace };
      return stop("POLICY_DENIED", denials.map((reason) => reason.code).join(", "));
    }
  }
  return { status: reviewerBlocked ? "BLOCKED" : "ALL_TASKS_VERIFIED", states, trace };
}
