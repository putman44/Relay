import { AGENT_RESPONSE_SCHEMA_VERSION, type ExecutionIdentity, type PlannerResponse } from "./contracts.js";
import { evaluateTaskTransition, taskStateConsistencyError, type TaskState } from "./state.js";

type ReadyPlan = Extract<PlannerResponse, { status: "READY" }>;
type PlannedTask = ReadyPlan["plan"]["tasks"][number];
export type TaskProposal = Pick<PlannedTask, "taskId" | "dependencies" | "fileScope" | "risk">;
export type RiskLevel = PlannedTask["risk"];

export interface GraphIssue {
  code: "EMPTY_GRAPH" | "INVALID_TASK_ID" | "DUPLICATE_TASK_ID" | "DUPLICATE_DEPENDENCY" |
    "UNKNOWN_DEPENDENCY" | "SELF_DEPENDENCY" | "CYCLE";
  taskId?: string;
  dependencyId?: string;
}

export type GraphValidation =
  | { valid: true; issues: [] }
  | { valid: false; issues: GraphIssue[] };

/** Validate the planner's proposed graph before any dispatch decision uses it. */
export function validateTaskGraph(tasks: readonly TaskProposal[]): GraphValidation {
  const issues: GraphIssue[] = [];
  if (tasks.length === 0) issues.push({ code: "EMPTY_GRAPH" });

  const byId = new Map<string, TaskProposal>();
  for (const task of tasks) {
    if (!task.taskId.trim() || task.taskId.trim() !== task.taskId) {
      issues.push({ code: "INVALID_TASK_ID", taskId: task.taskId });
    }
    if (byId.has(task.taskId)) issues.push({ code: "DUPLICATE_TASK_ID", taskId: task.taskId });
    else byId.set(task.taskId, task);
  }
  for (const task of tasks) {
    const seen = new Set<string>();
    for (const dependencyId of task.dependencies) {
      if (seen.has(dependencyId)) {
        issues.push({ code: "DUPLICATE_DEPENDENCY", taskId: task.taskId, dependencyId });
      }
      seen.add(dependencyId);
      if (dependencyId === task.taskId) {
        issues.push({ code: "SELF_DEPENDENCY", taskId: task.taskId, dependencyId });
      } else if (!byId.has(dependencyId)) {
        issues.push({ code: "UNKNOWN_DEPENDENCY", taskId: task.taskId, dependencyId });
      }
    }
  }

  // Duplicate IDs make graph traversal ambiguous; the other issues still provide feedback.
  if (!issues.some((issue) => issue.code === "DUPLICATE_TASK_ID")) {
    const remaining = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const task of tasks) {
      const knownDependencies = task.dependencies.filter((id) => byId.has(id));
      remaining.set(task.taskId, knownDependencies.length);
      for (const dependencyId of knownDependencies) {
        const waiting = dependents.get(dependencyId) ?? [];
        waiting.push(task.taskId);
        dependents.set(dependencyId, waiting);
      }
    }
    const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
    let processed = 0;
    for (let index = 0; index < ready.length; index += 1) {
      const taskId = ready[index]!;
      processed += 1;
      for (const dependentId of dependents.get(taskId) ?? []) {
        const count = remaining.get(dependentId)! - 1;
        remaining.set(dependentId, count);
        if (count === 0) ready.push(dependentId);
      }
    }
    if (processed !== byId.size) {
      const taskId = [...remaining].find(([, count]) => count > 0)?.[0];
      issues.push({ code: "CYCLE", ...(taskId === undefined ? {} : { taskId }) });
    }
  }
  return issues.length === 0 ? { valid: true, issues: [] } : { valid: false, issues };
}

export interface TrustedVerificationEvidence {
  identity: ExecutionIdentity;
  requirementsVersion: string;
  commitSha: string;
  evidenceReferences: readonly string[];
}

/** An orchestrator-owned assessment of one blocked task's impact on a candidate. */
export interface TrustedIndependenceAssessment {
  candidateTaskId: string;
  blockedTaskId: string;
  requirementsVersion: string;
  blockerEvidenceReference: string;
  impact: "INDEPENDENT" | "AFFECTED" | "UNCERTAIN";
  blockerScope: "TASK_LOCAL" | "SHARED" | "UNKNOWN";
  assessedAreas: readonly ("CODE" | "DATA_CONTRACT" | "BEHAVIOR")[];
  evidenceReferences: readonly string[];
}

/** All fields are supplied from trusted orchestrator state, never a planner reply. */
export interface TrustedAuthorizationContext {
  authorizedRequirementsVersion: string;
  currentRequirementsVersion: string;
  authorizedTaskIds: readonly string[];
  approvedDependenciesByTask: Readonly<Record<string, readonly string[]>>;
  /** Exact files independently approved for each internal task. */
  approvedFileScopeByTask: Readonly<Record<string, readonly string[]>>;
  approvedFileScope: readonly string[];
  maxAuthorizedRisk: RiskLevel;
  assessedRiskByTask: Readonly<Record<string, RiskLevel>>;
  environmentAuthorized: boolean;
  authorizationEvidenceReferences: readonly string[];
  verifiedTaskEvidence: Readonly<Record<string, TrustedVerificationEvidence>>;
  /** Exact verified commits established independently from repository state, never agent claims. */
  expectedVerifiedCommitByTask: Readonly<Record<string, string>>;
  /** Expected reviewer executions established by the orchestrator, not agent responses. */
  expectedVerifiedIdentityByTask: Readonly<Record<string, ExecutionIdentity>>;
  independenceAssessments: readonly TrustedIndependenceAssessment[];
}

export interface DispatchInput {
  tasks: readonly TaskProposal[];
  taskId: string;
  proposedRequirementsVersion?: string;
  states: Readonly<Record<string, TaskState | undefined>>;
  authorization?: Partial<TrustedAuthorizationContext> | undefined;
}

export interface DenialReason {
  code:
    | "INVALID_GRAPH"
    | "UNKNOWN_TASK"
    | "MISSING_TASK_STATE"
    | "TASK_NOT_PENDING"
    | "STATE_INCONSISTENT"
    | "CONCURRENT_IMPLEMENTATION"
    | "DEPENDENCY_NOT_VERIFIED"
    | "DEPENDENCY_EVIDENCE_MISSING"
    | "DEPENDENCY_EXPECTED_COMMIT_MISSING"
    | "DEPENDENCY_COMMIT_MISMATCH"
    | "DEPENDENCY_IDENTITY_MISSING"
    | "DEPENDENCY_EXPECTED_IDENTITY_MISSING"
    | "DEPENDENCY_IDENTITY_MISMATCH"
    | "AUTHORIZATION_MISSING"
    | "REQUIREMENTS_MISMATCH"
    | "TASK_NOT_AUTHORIZED"
    | "DEPENDENCIES_NOT_AUTHORIZED"
    | "TASK_FILE_SCOPE_MISSING"
    | "FILE_SCOPE_UNAUTHORIZED"
    | "RISK_ASSESSMENT_MISSING"
    | "RISK_LIMIT_EXCEEDED"
    | "ENVIRONMENT_UNAUTHORIZED"
    | "INDEPENDENCE_UNPROVEN"
    | "BLOCKER_IMPACT_UNRESOLVED";
  taskId?: string;
  detail: string;
}

export type DispatchEligibility =
  | { eligible: true; reasons: [] }
  | { eligible: false; reasons: DenialReason[] };

const riskRank = (risk: RiskLevel | undefined): number | undefined => {
  switch (risk) {
    case "LOW": return 0;
    case "MEDIUM": return 1;
    case "HIGH": return 2;
    default: return undefined;
  }
};

const ownValue = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;
const hasReferences = (references: readonly string[] | undefined): references is readonly string[] =>
  Array.isArray(references) && references.length > 0 &&
  references.every((reference) => typeof reference === "string" && reference.trim().length > 0);
const hasText = (value: string | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;
const isCommitSha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const isExecutionIdentity = (value: unknown): value is ExecutionIdentity => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  const fields = ["schemaVersion", "runId", "taskId", "attemptId", "requirementsVersion"];
  return Object.keys(identity).length === fields.length &&
    fields.every((field) => Object.hasOwn(identity, field)) &&
    identity.schemaVersion === AGENT_RESPONSE_SCHEMA_VERSION &&
    [identity.runId, identity.taskId, identity.attemptId, identity.requirementsVersion]
      .every((field) => typeof field === "string" && field.trim().length > 0 && field.trim() === field);
};
const sameExecutionIdentity = (actual: ExecutionIdentity, expected: ExecutionIdentity): boolean =>
  actual.schemaVersion === expected.schemaVersion &&
  actual.runId === expected.runId &&
  actual.taskId === expected.taskId &&
  actual.attemptId === expected.attemptId &&
  actual.requirementsVersion === expected.requirementsVersion;

// Scope entries are exact repository-relative files; wildcard or path traversal is not authority.
const isExactRelativeFile = (file: string): boolean =>
  file.trim() === file && file.length > 0 && !file.startsWith("/") && !file.startsWith("~") &&
  !file.includes("\\") && !/[\*?\[\]:\x00-\x1f]/.test(file) &&
  file.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");

function allPredecessors(taskId: string, byId: Map<string, TaskProposal>): Set<string> {
  const predecessors = new Set<string>();
  const pending = [...(byId.get(taskId)?.dependencies ?? [])];
  while (pending.length > 0) {
    const dependencyId = pending.pop()!;
    if (predecessors.has(dependencyId)) continue;
    predecessors.add(dependencyId);
    pending.push(...(byId.get(dependencyId)?.dependencies ?? []));
  }
  return predecessors;
}

/** A positive result is a policy decision, not proof that dispatch has occurred. */
export function evaluateDispatchEligibility(input: DispatchInput): DispatchEligibility {
  const graph = validateTaskGraph(input.tasks);
  if (!graph.valid) {
    return {
      eligible: false,
      reasons: graph.issues.map((issue) => ({
        code: "INVALID_GRAPH",
        ...(issue.taskId === undefined ? {} : { taskId: issue.taskId }),
        detail: `${issue.code}${issue.dependencyId ? `: ${issue.dependencyId}` : ""}`,
      })),
    };
  }

  const reasons: DenialReason[] = [];
  const deny = (code: DenialReason["code"], detail: string, taskId?: string): void => {
    reasons.push({ code, detail, ...(taskId === undefined ? {} : { taskId }) });
  };
  const byId = new Map(input.tasks.map((task) => [task.taskId, task]));
  const candidate = byId.get(input.taskId);
  if (!candidate) deny("UNKNOWN_TASK", "Requested task is not in the validated graph", input.taskId);

  for (const task of input.tasks) {
    const state = ownValue(input.states, task.taskId);
    if (!state) deny("MISSING_TASK_STATE", "Task execution state is missing", task.taskId);
    else {
      const inconsistency = taskStateConsistencyError(state);
      if (inconsistency) deny("STATE_INCONSISTENT", inconsistency, task.taskId);
      if (task.taskId !== input.taskId && state.status === "IMPLEMENTING") {
        deny("CONCURRENT_IMPLEMENTATION", "Another implementation is active", task.taskId);
      }
    }
  }
  const ownState = ownValue(input.states, input.taskId);
  if (candidate && ownState && ownState.status !== "PENDING") {
    deny("TASK_NOT_PENDING", "Task must be pending before dispatch", input.taskId);
  }

  const auth = input.authorization;
  if (!auth || !hasReferences(auth.authorizationEvidenceReferences) ||
      !hasText(auth.authorizedRequirementsVersion) || !hasText(auth.currentRequirementsVersion) ||
      !Array.isArray(auth.authorizedTaskIds) || !auth.approvedDependenciesByTask ||
      !Array.isArray(auth.approvedFileScope) || !auth.maxAuthorizedRisk ||
      !auth.assessedRiskByTask || !auth.verifiedTaskEvidence ||
      !auth.expectedVerifiedCommitByTask ||
      typeof auth.expectedVerifiedCommitByTask !== "object" ||
      Array.isArray(auth.expectedVerifiedCommitByTask) ||
      !auth.expectedVerifiedIdentityByTask ||
      typeof auth.expectedVerifiedIdentityByTask !== "object" ||
      Array.isArray(auth.expectedVerifiedIdentityByTask) ||
      !Array.isArray(auth.independenceAssessments)) {
    deny("AUTHORIZATION_MISSING", "Required trusted authorization context is incomplete");
    return { eligible: false, reasons };
  }
  if (!hasText(input.proposedRequirementsVersion) ||
      input.proposedRequirementsVersion !== auth.authorizedRequirementsVersion ||
      auth.currentRequirementsVersion !== auth.authorizedRequirementsVersion) {
    deny("REQUIREMENTS_MISMATCH", "Proposal and authorization must match current requirements");
  }
  if (auth.environmentAuthorized !== true) {
    deny("ENVIRONMENT_UNAUTHORIZED", "Execution environment has not been authorized");
  }
  for (const task of input.tasks) {
    if (!auth.authorizedTaskIds.includes(task.taskId)) {
      deny("TASK_NOT_AUTHORIZED", "Proposed task is not authorized", task.taskId);
    }
    const approvedDependencies = ownValue(auth.approvedDependenciesByTask, task.taskId);
    if (!Array.isArray(approvedDependencies) || approvedDependencies.length !== task.dependencies.length ||
        !task.dependencies.every((id) => approvedDependencies.includes(id))) {
      deny("DEPENDENCIES_NOT_AUTHORIZED", "Proposed dependencies differ from approved graph", task.taskId);
    }
  }
  if (candidate) {
    const taskScope = auth.approvedFileScopeByTask &&
      typeof auth.approvedFileScopeByTask === "object" &&
      !Array.isArray(auth.approvedFileScopeByTask)
      ? ownValue(auth.approvedFileScopeByTask, candidate.taskId)
      : undefined;
    const validTaskScope = Array.isArray(taskScope) && taskScope.length > 0 &&
      taskScope.every((file) => typeof file === "string" && isExactRelativeFile(file));
    if (!validTaskScope) {
      deny("TASK_FILE_SCOPE_MISSING", "Exact task-specific file approval is missing or malformed", candidate.taskId);
    }
    const approvedFiles = new Set(auth.approvedFileScope);
    if (auth.approvedFileScope.length === 0 ||
        !auth.approvedFileScope.every((file) => typeof file === "string" && isExactRelativeFile(file)) ||
        candidate.fileScope.length === 0 ||
        candidate.fileScope.some((file) => typeof file !== "string" || !isExactRelativeFile(file) ||
          !approvedFiles.has(file) || (validTaskScope && !taskScope?.includes(file)))) {
      deny("FILE_SCOPE_UNAUTHORIZED", "Proposed files exceed issue or task-specific approved scope", candidate.taskId);
    }
    const assessedRisk = riskRank(ownValue(auth.assessedRiskByTask, candidate.taskId));
    const proposedRisk = riskRank(candidate.risk);
    const riskCeiling = riskRank(auth.maxAuthorizedRisk);
    if (assessedRisk === undefined) {
      deny("RISK_ASSESSMENT_MISSING", "Independent risk assessment is missing", candidate.taskId);
    } else if (proposedRisk === undefined || riskCeiling === undefined ||
               Math.max(assessedRisk, proposedRisk) > riskCeiling) {
      deny("RISK_LIMIT_EXCEEDED", "Planner or independently assessed risk exceeds authorization", candidate.taskId);
    }

    const predecessors = allPredecessors(candidate.taskId, byId);
    for (const predecessorId of predecessors) {
      if (ownValue(input.states, predecessorId)?.status !== "VERIFIED") {
        deny("DEPENDENCY_NOT_VERIFIED", "Required predecessor is not verified", predecessorId);
      }
      const proof = ownValue(auth.verifiedTaskEvidence, predecessorId);
      if (!proof || proof.requirementsVersion !== auth.currentRequirementsVersion ||
          !hasReferences(proof.evidenceReferences) || !isCommitSha(proof.commitSha)) {
        deny("DEPENDENCY_EVIDENCE_MISSING", "Current independent verification evidence is missing", predecessorId);
      }
      const expectedCommit = ownValue(auth.expectedVerifiedCommitByTask, predecessorId);
      if (!isCommitSha(expectedCommit)) {
        deny("DEPENDENCY_EXPECTED_COMMIT_MISSING", "Independently established verified commit is missing or invalid", predecessorId);
      } else if (proof && isCommitSha(proof.commitSha) && proof.commitSha !== expectedCommit) {
        deny("DEPENDENCY_COMMIT_MISMATCH", "Verification evidence is for a different commit", predecessorId);
      }
      const expectedIdentity = ownValue(auth.expectedVerifiedIdentityByTask, predecessorId);
      if (!isExecutionIdentity(expectedIdentity) || expectedIdentity.taskId !== predecessorId ||
          expectedIdentity.requirementsVersion !== auth.currentRequirementsVersion) {
        deny("DEPENDENCY_EXPECTED_IDENTITY_MISSING", "Current expected predecessor execution identity is missing or invalid", predecessorId);
      }
      if (!proof || !isExecutionIdentity(proof.identity)) {
        deny("DEPENDENCY_IDENTITY_MISSING", "Predecessor verification identity is missing or malformed", predecessorId);
      } else if (isExecutionIdentity(expectedIdentity) &&
                 (proof.identity.requirementsVersion !== proof.requirementsVersion ||
                  !sameExecutionIdentity(proof.identity, expectedIdentity))) {
        deny("DEPENDENCY_IDENTITY_MISMATCH", "Verification evidence belongs to a different execution", predecessorId);
      }
    }

    for (const task of input.tasks) {
      if (task.taskId === candidate.taskId || ownValue(input.states, task.taskId)?.status !== "BLOCKED") continue;
      if (predecessors.has(task.taskId)) continue; // Already denied as an unverified dependency.
      const blocker = ownValue(input.states, task.taskId)?.blockHistory.at(-1);
      const matchingAssessments = auth.independenceAssessments.filter((item) =>
        item.candidateTaskId === candidate.taskId && item.blockedTaskId === task.taskId);
      const assessment = matchingAssessments[0];
      if (matchingAssessments.length !== 1 || !assessment || !blocker ||
          assessment.requirementsVersion !== auth.currentRequirementsVersion ||
          !blocker.evidenceReferences.includes(assessment.blockerEvidenceReference) ||
          assessment.assessedAreas.length === 0 ||
          !hasReferences(assessment.evidenceReferences)) {
        deny("INDEPENDENCE_UNPROVEN", "Current evidence of independence from blocked task is missing", task.taskId);
      } else if (assessment.impact !== "INDEPENDENT" || assessment.blockerScope !== "TASK_LOCAL") {
        deny("BLOCKER_IMPACT_UNRESOLVED", "Blocked task may affect candidate or shared safety", task.taskId);
      }
    }

    if (ownState?.status === "PENDING") {
      const transition = evaluateTaskTransition(ownState, {
        type: "ADVANCE",
        to: "IMPLEMENTING",
        decision: { kind: "DISPATCH_APPROVED", evidenceReferences: auth.authorizationEvidenceReferences },
      });
      if (!transition.permitted) deny("STATE_INCONSISTENT", transition.reason, candidate.taskId);
    }
  }

  return reasons.length === 0 ? { eligible: true, reasons: [] } : { eligible: false, reasons };
}
