/** Repository-agnostic task stages. No agent response can advance a task directly. */
export type TaskStage =
  | "PENDING"
  | "IMPLEMENTING"
  | "VERIFYING"
  | "PUBLISHING"
  | "IN_REVIEW"
  | "VERIFIED";
export type TaskStatus = TaskStage | "BLOCKED";
export type CompletedStage = Exclude<TaskStage, "VERIFIED">;

export type StageDecisionKind =
  | "DISPATCH_APPROVED"
  | "IMPLEMENTATION_CONFIRMED"
  | "VERIFICATION_PASSED"
  | "PUBLICATION_CONFIRMED"
  | "REVIEW_PASSED";

/** Supplied only after the orchestrator independently checks the relevant gate. */
export interface TrustedStageDecision {
  kind: StageDecisionKind;
  evidenceReferences: readonly string[];
}

export interface StageCompletion {
  stage: CompletedStage;
  decision: StageDecisionKind;
  evidenceReferences: readonly string[];
}

export interface BlockingReason {
  code:
    | "DEPENDENCY"
    | "REQUIREMENTS"
    | "ENVIRONMENT"
    | "EVIDENCE"
    | "EXTERNAL_ACTION"
    | "REVIEW"
    | "SAFETY";
  detail: string;
}

export interface TaskBlock {
  lastValidStage: Exclude<TaskStage, "VERIFIED">;
  reason: BlockingReason;
  evidenceReferences: readonly string[];
  authorizedNextAction: string;
}

export interface StageRevalidation {
  stage: CompletedStage;
  valid: boolean;
  evidenceReferences: readonly string[];
}

/** These are trusted orchestrator decisions, not fields copied from agent replies. */
export interface TrustedRecoveryDecision {
  blockerResolved: boolean;
  requirementsValid: boolean;
  repositoryValid: boolean;
  dependenciesValid: boolean;
  environmentAuthorized: boolean;
  evidenceReferences: readonly string[];
  stageRevalidations: readonly StageRevalidation[];
}

export interface RecoveryRecord {
  resumedStage: Exclude<TaskStage, "VERIFIED">;
  evidenceReferences: readonly string[];
  stageRevalidations: readonly StageRevalidation[];
}

export interface TaskState {
  status: TaskStatus;
  /** Current completed stages whose evidence may be reused after revalidation. */
  completedStages: readonly StageCompletion[];
  /** Superseded evidence remains available for audit but cannot advance the task. */
  invalidatedStages: readonly StageCompletion[];
  blockHistory: readonly TaskBlock[];
  recoveryHistory: readonly RecoveryRecord[];
}

export type TaskEvent =
  | { type: "ADVANCE"; to: TaskStage; decision: TrustedStageDecision }
  | {
      type: "BLOCK";
      reason: BlockingReason;
      evidenceReferences: readonly string[];
      authorizedNextAction: string;
    }
  | { type: "RESUME"; decision: TrustedRecoveryDecision };

export type TransitionEvaluation =
  | { permitted: true; nextStatus: TaskStatus; invalidateFrom?: number }
  | { permitted: false; reason: string };

export type TransitionResult =
  | { applied: true; state: TaskState }
  | { applied: false; reason: string };

const nextStage: Record<CompletedStage, TaskStage> = {
  PENDING: "IMPLEMENTING",
  IMPLEMENTING: "VERIFYING",
  VERIFYING: "PUBLISHING",
  PUBLISHING: "IN_REVIEW",
  IN_REVIEW: "VERIFIED",
};

const requiredDecision: Record<CompletedStage, StageDecisionKind> = {
  PENDING: "DISPATCH_APPROVED",
  IMPLEMENTING: "IMPLEMENTATION_CONFIRMED",
  VERIFYING: "VERIFICATION_PASSED",
  PUBLISHING: "PUBLICATION_CONFIRMED",
  IN_REVIEW: "REVIEW_PASSED",
};

const completedStageOrder: readonly CompletedStage[] = [
  "PENDING",
  "IMPLEMENTING",
  "VERIFYING",
  "PUBLISHING",
  "IN_REVIEW",
];

const hasReferences = (references: readonly string[]): boolean =>
  references.length > 0 && references.every((reference) => reference.trim().length > 0);

/** Validate current-stage evidence; invalidated records are retained only as history. */
function stateConsistencyError(state: TaskState): string | null {
  const currentStage = state.status === "BLOCKED"
    ? state.blockHistory.at(-1)?.lastValidStage
    : state.status;
  if (!currentStage) return "Blocked task has no recorded last valid stage";

  const completedCount = currentStage === "VERIFIED"
    ? completedStageOrder.length
    : completedStageOrder.indexOf(currentStage);
  if (completedCount < 0 || state.completedStages.length !== completedCount) {
    return "Completed stages do not match the current task stage";
  }
  for (const [index, completion] of state.completedStages.entries()) {
    const expectedStage = completedStageOrder[index];
    if (
      !expectedStage ||
      completion.stage !== expectedStage ||
      completion.decision !== requiredDecision[expectedStage] ||
      !hasReferences(completion.evidenceReferences)
    ) {
      return "Completed stage history is out of order or lacks trusted evidence";
    }
  }
  return null;
}

export function createPendingTask(): TaskState {
  return {
    status: "PENDING",
    completedStages: [],
    invalidatedStages: [],
    blockHistory: [],
    recoveryHistory: [],
  };
}

/** Evaluate the transition without changing the task or consulting external systems. */
export function evaluateTaskTransition(
  state: TaskState,
  event: TaskEvent,
): TransitionEvaluation {
  const consistencyError = stateConsistencyError(state);
  if (consistencyError) return { permitted: false, reason: consistencyError };

  if (event.type === "ADVANCE") {
    if (state.status === "BLOCKED" || state.status === "VERIFIED") {
      return { permitted: false, reason: "Task cannot advance from this status" };
    }
    if (event.to !== nextStage[state.status]) {
      return { permitted: false, reason: "Transition skips or repeats a mandatory stage" };
    }
    if (event.decision.kind !== requiredDecision[state.status]) {
      return { permitted: false, reason: "Required trusted gate decision is missing" };
    }
    if (!hasReferences(event.decision.evidenceReferences)) {
      return { permitted: false, reason: "Gate decision requires evidence references" };
    }
    return { permitted: true, nextStatus: event.to };
  }

  if (event.type === "BLOCK") {
    if (state.status === "BLOCKED" || state.status === "VERIFIED") {
      return { permitted: false, reason: "Task cannot be blocked from this status" };
    }
    if (!event.reason.detail.trim() || !event.authorizedNextAction.trim()) {
      return { permitted: false, reason: "Block requires a reason and recovery action" };
    }
    if (!hasReferences(event.evidenceReferences)) {
      return { permitted: false, reason: "Block requires evidence references" };
    }
    return { permitted: true, nextStatus: "BLOCKED" };
  }

  if (state.status !== "BLOCKED") {
    return { permitted: false, reason: "Only a blocked task can resume" };
  }
  const block = state.blockHistory.at(-1);
  if (!block) return { permitted: false, reason: "Blocked task has no recorded block" };
  const decision = event.decision;
  if (
    !decision.blockerResolved ||
    !decision.requirementsValid ||
    !decision.repositoryValid ||
    !decision.dependenciesValid ||
    !decision.environmentAuthorized
  ) {
    return { permitted: false, reason: "Recovery prerequisites have not been revalidated" };
  }
  if (!hasReferences(decision.evidenceReferences)) {
    return { permitted: false, reason: "Recovery requires evidence references" };
  }
  if (decision.stageRevalidations.length !== state.completedStages.length) {
    return { permitted: false, reason: "Recovery must revalidate every completed stage" };
  }
  for (const [index, completion] of state.completedStages.entries()) {
    const revalidation = decision.stageRevalidations[index];
    if (
      !revalidation ||
      revalidation.stage !== completion.stage ||
      typeof revalidation.valid !== "boolean" ||
      !hasReferences(revalidation.evidenceReferences)
    ) {
      return { permitted: false, reason: "Recovery stage revalidation is incomplete or out of order" };
    }
  }
  const invalidateFrom = decision.stageRevalidations.findIndex((item) => !item.valid);
  return invalidateFrom < 0
    ? { permitted: true, nextStatus: block.lastValidStage }
    : {
        permitted: true,
        nextStatus: state.completedStages[invalidateFrom]!.stage,
        invalidateFrom,
      };
}

/** Apply only a permitted event; rejected events leave the input state untouched. */
export function applyTaskTransition(state: TaskState, event: TaskEvent): TransitionResult {
  const evaluation = evaluateTaskTransition(state, event);
  if (!evaluation.permitted) return { applied: false, reason: evaluation.reason };

  if (event.type === "ADVANCE") {
    const stage = state.status as CompletedStage;
    return {
      applied: true,
      state: {
        ...state,
        status: evaluation.nextStatus,
        completedStages: [
          ...state.completedStages,
          {
            stage,
            decision: event.decision.kind,
            evidenceReferences: [...event.decision.evidenceReferences],
          },
        ],
      },
    };
  }
  if (event.type === "BLOCK") {
    return {
      applied: true,
      state: {
        ...state,
        status: "BLOCKED",
        blockHistory: [
          ...state.blockHistory,
          {
            lastValidStage: state.status as Exclude<TaskStage, "VERIFIED">,
            reason: { ...event.reason },
            evidenceReferences: [...event.evidenceReferences],
            authorizedNextAction: event.authorizedNextAction,
          },
        ],
      },
    };
  }

  const invalidateFrom = evaluation.invalidateFrom ?? state.completedStages.length;
  return {
    applied: true,
    state: {
      ...state,
      status: evaluation.nextStatus,
      completedStages: state.completedStages.slice(0, invalidateFrom),
      invalidatedStages: [
        ...state.invalidatedStages,
        ...state.completedStages.slice(invalidateFrom),
      ],
      recoveryHistory: [
        ...state.recoveryHistory,
        {
          resumedStage: evaluation.nextStatus as Exclude<TaskStage, "VERIFIED">,
          evidenceReferences: [...event.decision.evidenceReferences],
          stageRevalidations: event.decision.stageRevalidations.map((item) => ({
            ...item,
            evidenceReferences: [...item.evidenceReferences],
          })),
        },
      ],
    },
  };
}
