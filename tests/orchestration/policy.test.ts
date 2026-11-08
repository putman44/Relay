import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateDispatchEligibility,
  taskGraphSnapshot,
  validateTaskGraph,
  type DenialReason,
  type DispatchInput,
  type TaskProposal,
  type TrustedAuthorizationContext,
  type TrustedVerificationEvidence,
} from "../../src/orchestration/policy.js";
import {
  applyTaskTransition,
  createPendingTask,
  type StageDecisionKind,
  type TaskStage,
  type TaskState,
} from "../../src/orchestration/state.js";
import type { ExecutionIdentity } from "../../src/orchestration/contracts.js";

const task = (taskId: string, dependencies: string[] = []): TaskProposal => ({
  taskId,
  dependencies,
  fileScope: [`src/${taskId}.ts`],
  risk: "LOW",
});
const commitSha = (id: string): string => id.repeat(40);
const verifiedIdentity = (taskId: string): ExecutionIdentity => ({
  schemaVersion: 1,
  runId: "run-1",
  taskId,
  attemptId: `review-${taskId}`,
  requirementsVersion: "requirements-v1",
});

function advance(state: TaskState, to: TaskStage, kind: StageDecisionKind): TaskState {
  const result = applyTaskTransition(state, {
    type: "ADVANCE",
    to,
    decision: { kind, evidenceReferences: [`verified:${kind}`] },
  });
  if (!result.applied) throw new Error(result.reason);
  return result.state;
}

function verifiedTask(): TaskState {
  let state = createPendingTask();
  state = advance(state, "IMPLEMENTING", "DISPATCH_APPROVED");
  state = advance(state, "VERIFYING", "IMPLEMENTATION_CONFIRMED");
  state = advance(state, "PUBLISHING", "VERIFICATION_PASSED");
  state = advance(state, "IN_REVIEW", "PUBLICATION_CONFIRMED");
  return advance(state, "VERIFIED", "REVIEW_PASSED");
}

function blockedTask(): TaskState {
  const result = applyTaskTransition(createPendingTask(), {
    type: "BLOCK",
    reason: { code: "EVIDENCE", detail: "Task-local question remains" },
    evidenceReferences: ["blocker-evidence"],
    authorizedNextAction: "Investigate",
  });
  if (!result.applied) throw new Error(result.reason);
  return result.state;
}

function authorization(tasks: readonly TaskProposal[]): TrustedAuthorizationContext {
  return {
    authorizedRequirementsVersion: "requirements-v1",
    currentRequirementsVersion: "requirements-v1",
    authorizedTaskIds: tasks.map((item) => item.taskId),
    approvedDependenciesByTask: Object.fromEntries(tasks.map((item) => [item.taskId, item.dependencies])),
    approvedFileScopeByTask: Object.fromEntries(tasks.map((item) =>
      [item.taskId, [`src/${item.taskId}.ts`]])),
    approvedFileScope: tasks.map((item) => `src/${item.taskId}.ts`),
    maxAuthorizedRisk: "MEDIUM",
    assessedRiskByTask: Object.fromEntries(tasks.map((item) => [item.taskId, "LOW"])),
    environmentAuthorized: true,
    authorizationEvidenceReferences: ["approval-1"],
    verifiedTaskEvidence: {},
    expectedVerifiedCommitByTask: {},
    expectedVerifiedIdentityByTask: {},
    independenceAssessments: [],
  };
}

function input(tasks: TaskProposal[], taskId: string): DispatchInput {
  return {
    tasks,
    taskId,
    proposedRequirementsVersion: "requirements-v1",
    states: Object.fromEntries(tasks.map((item) => [item.taskId, createPendingTask()])),
    authorization: authorization(tasks),
  };
}

const codes = (reasons: DenialReason[]): string[] => reasons.map((reason) => reason.code);
const deniedFor = (request: DispatchInput, code: DenialReason["code"]): void => {
  const result = evaluateDispatchEligibility(request);
  assert.equal(result.eligible, false);
  if (!result.eligible) assert.ok(codes(result.reasons).includes(code), JSON.stringify(result.reasons));
};

test("validates a directed acyclic planner task graph", () => {
  const tasks = [task("a"), task("b", ["a"]), task("c", ["a", "b"])];
  assert.deepEqual(validateTaskGraph(tasks), { valid: true, issues: [] });
});

test("validates a large acyclic graph without recursive traversal", () => {
  const tasks = Array.from({ length: 3000 }, (_, index) =>
    task(`task-${index}`, index === 0 ? [] : [`task-${index - 1}`]));
  assert.deepEqual(validateTaskGraph(tasks), { valid: true, issues: [] });
});

test("rejects duplicate IDs, unknown references, self-dependencies and cycles", () => {
  const cases: [TaskProposal[], string][] = [
    [[task("")], "INVALID_TASK_ID"],
    [[task(" a")], "INVALID_TASK_ID"],
    [[task("a"), task("a")], "DUPLICATE_TASK_ID"],
    [[task("a"), task("b", ["a", "a"])], "DUPLICATE_DEPENDENCY"],
    [[task("a", ["missing"])], "UNKNOWN_DEPENDENCY"],
    [[task("a", ["a"])], "SELF_DEPENDENCY"],
    [[task("a", ["b"]), task("b", ["c"]), task("c", ["a"])], "CYCLE"],
  ];
  for (const [tasks, expectedCode] of cases) {
    const result = validateTaskGraph(tasks);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.code === expectedCode));
    deniedFor(input(tasks, tasks[0]!.taskId), "INVALID_GRAPH");
  }
});

test("allows a pending authorized task when no predecessor or blocker prevents it", () => {
  const request = input([task("a")], "a");
  assert.deepEqual(evaluateDispatchEligibility(request), { eligible: true, reasons: [] });
  assert.equal(request.states.a?.status, "PENDING");
});

test("requires all direct and transitive predecessors to be verified with current evidence", () => {
  const tasks = [task("a"), task("b", ["a"]), task("c", ["b"])];
  const request = input(tasks, "c");
  deniedFor(request, "DEPENDENCY_NOT_VERIFIED");

  const auth = request.authorization as TrustedAuthorizationContext;
  auth.currentRunId = "run-1";
  const withVerifiedB = { ...request, states: { ...request.states, b: verifiedTask() } };
  deniedFor(withVerifiedB, "DEPENDENCY_NOT_VERIFIED");
  const withBothVerified = { ...withVerifiedB, states: { ...withVerifiedB.states, a: verifiedTask() } };
  deniedFor(withBothVerified, "DEPENDENCY_EVIDENCE_MISSING");

  auth.verifiedTaskEvidence = {
    a: { identity: verifiedIdentity("a"), requirementsVersion: "requirements-v1", commitSha: commitSha("a"), evidenceReferences: ["review-a"] },
    b: { identity: verifiedIdentity("b"), requirementsVersion: "requirements-v1", commitSha: commitSha("b"), evidenceReferences: ["review-b"] },
  };
  auth.expectedVerifiedCommitByTask = { a: commitSha("a"), b: commitSha("b") };
  auth.expectedVerifiedIdentityByTask = { a: verifiedIdentity("a"), b: verifiedIdentity("b") };
  assert.deepEqual(evaluateDispatchEligibility(withBothVerified), { eligible: true, reasons: [] });
  auth.verifiedTaskEvidence = {
    ...auth.verifiedTaskEvidence,
    a: { identity: verifiedIdentity("a"), requirementsVersion: "requirements-v0", commitSha: commitSha("a"), evidenceReferences: ["old-review"] },
  };
  deniedFor(withBothVerified, "DEPENDENCY_EVIDENCE_MISSING");
});

test("predecessor proof must match an independently expected verified commit", () => {
  const request = input([task("a"), task("b", ["a"])], "b");
  request.states = { ...request.states, a: verifiedTask() };
  const auth = request.authorization as TrustedAuthorizationContext;
  auth.currentRunId = "run-1";
  const matchingProof = {
    identity: verifiedIdentity("a"),
    requirementsVersion: "requirements-v1",
    commitSha: commitSha("a"),
    evidenceReferences: ["independent-review-a"],
  };
  auth.verifiedTaskEvidence = { a: matchingProof };
  auth.expectedVerifiedCommitByTask = { a: commitSha("a") };
  auth.expectedVerifiedIdentityByTask = { a: verifiedIdentity("a") };
  assert.deepEqual(evaluateDispatchEligibility(request), { eligible: true, reasons: [] });

  auth.verifiedTaskEvidence = { a: { ...matchingProof, commitSha: commitSha("b") } };
  deniedFor(request, "DEPENDENCY_COMMIT_MISMATCH");
  auth.verifiedTaskEvidence = { a: { ...matchingProof, commitSha: undefined as unknown as string } };
  deniedFor(request, "DEPENDENCY_EVIDENCE_MISSING");
  auth.verifiedTaskEvidence = { a: { ...matchingProof, commitSha: "not-a-sha" } };
  deniedFor(request, "DEPENDENCY_EVIDENCE_MISSING");
  auth.verifiedTaskEvidence = { a: { ...matchingProof, requirementsVersion: "requirements-v0" } };
  deniedFor(request, "DEPENDENCY_EVIDENCE_MISSING");
  auth.verifiedTaskEvidence = { a: matchingProof };
  auth.expectedVerifiedCommitByTask = { a: commitSha("b") };
  deniedFor(request, "DEPENDENCY_COMMIT_MISMATCH");
  auth.expectedVerifiedCommitByTask = {};
  deniedFor(request, "DEPENDENCY_EXPECTED_COMMIT_MISSING");
  auth.expectedVerifiedCommitByTask = { a: "invalid" };
  deniedFor(request, "DEPENDENCY_EXPECTED_COMMIT_MISSING");
});

test("same-commit predecessor proof must match its independently expected execution", () => {
  const request = input([task("a"), task("b", ["a"])], "b");
  request.states = { ...request.states, a: verifiedTask() };
  const auth = request.authorization as TrustedAuthorizationContext;
  auth.currentRunId = "run-1";
  const expected = verifiedIdentity("a");
  const proof: TrustedVerificationEvidence = {
    identity: expected,
    requirementsVersion: "requirements-v1",
    commitSha: commitSha("a"),
    evidenceReferences: ["independent-review-a"],
  };
  auth.verifiedTaskEvidence = { a: proof };
  auth.expectedVerifiedCommitByTask = { a: commitSha("a") };
  auth.expectedVerifiedIdentityByTask = { a: expected };
  assert.deepEqual(evaluateDispatchEligibility(request), { eligible: true, reasons: [] });

  for (const identity of [
    { ...expected, runId: "old-run" },
    { ...expected, taskId: "other-task" },
    { ...expected, attemptId: "old-review-attempt" },
    { ...expected, requirementsVersion: "requirements-v0" },
  ]) {
    auth.verifiedTaskEvidence = { a: { ...proof, identity } };
    deniedFor(request, "DEPENDENCY_IDENTITY_MISMATCH");
  }

  const missingIdentity: Partial<TrustedVerificationEvidence> = { ...proof };
  delete missingIdentity.identity;
  auth.verifiedTaskEvidence = { a: missingIdentity as TrustedVerificationEvidence };
  deniedFor(request, "DEPENDENCY_IDENTITY_MISSING");
  auth.verifiedTaskEvidence = { a: { ...proof, identity: { ...expected, attemptId: " " } } };
  deniedFor(request, "DEPENDENCY_IDENTITY_MISSING");
  auth.verifiedTaskEvidence = { a: { ...proof, identity: { ...expected, claimedAuthority: true } as ExecutionIdentity } };
  deniedFor(request, "DEPENDENCY_IDENTITY_MISSING");

  auth.verifiedTaskEvidence = { a: proof };
  auth.expectedVerifiedIdentityByTask = {};
  deniedFor(request, "DEPENDENCY_EXPECTED_IDENTITY_MISSING");
  auth.expectedVerifiedIdentityByTask = { a: { ...expected, attemptId: "" } };
  deniedFor(request, "DEPENDENCY_EXPECTED_IDENTITY_MISSING");
});

test("predecessor proof and expected identity must each belong to the trusted current run", () => {
  const request = input([task("a"), task("b", ["a"])], "b");
  request.states = { ...request.states, a: verifiedTask() };
  const auth = request.authorization as TrustedAuthorizationContext;
  const currentIdentity = verifiedIdentity("a");
  const oldIdentity = { ...currentIdentity, runId: "run-older" };
  const proof: TrustedVerificationEvidence = {
    identity: currentIdentity,
    requirementsVersion: "requirements-v1",
    commitSha: commitSha("a"),
    evidenceReferences: ["independent-review-a"],
  };
  auth.currentRunId = "run-1";
  auth.verifiedTaskEvidence = { a: proof };
  auth.expectedVerifiedCommitByTask = { a: commitSha("a") };
  auth.expectedVerifiedIdentityByTask = { a: currentIdentity };
  assert.deepEqual(evaluateDispatchEligibility(request), { eligible: true, reasons: [] });

  auth.verifiedTaskEvidence = { a: { ...proof, identity: oldIdentity } };
  auth.expectedVerifiedIdentityByTask = { a: oldIdentity };
  const stale = evaluateDispatchEligibility(request);
  assert.equal(stale.eligible, false);
  if (!stale.eligible) {
    assert.deepEqual(stale.reasons, [
      { code: "DEPENDENCY_EXPECTED_RUN_MISMATCH", taskId: "a", detail: "Expected predecessor execution belongs to a different run" },
      { code: "DEPENDENCY_PROOF_RUN_MISMATCH", taskId: "a", detail: "Predecessor verification evidence belongs to a different run" },
    ]);
  }

  auth.expectedVerifiedIdentityByTask = { a: currentIdentity };
  deniedFor(request, "DEPENDENCY_PROOF_RUN_MISMATCH");

  auth.verifiedTaskEvidence = { a: proof };
  auth.expectedVerifiedIdentityByTask = { a: oldIdentity };
  deniedFor(request, "DEPENDENCY_EXPECTED_RUN_MISMATCH");

  auth.expectedVerifiedIdentityByTask = { a: currentIdentity };
  for (const currentRunId of [undefined, "", " ", " run-1 "]) {
    if (currentRunId === undefined) delete auth.currentRunId;
    else auth.currentRunId = currentRunId;
    deniedFor(request, "DEPENDENCY_CURRENT_RUN_MISSING");
  }
});

test("a missing current run only guards tasks with verified predecessors", () => {
  const request = input([task("a"), task("b", ["a"])], "a");
  assert.deepEqual(evaluateDispatchEligibility(request), { eligible: true, reasons: [] });
});

test("a blocked predecessor cannot authorize dispatch", () => {
  const request = input([task("a"), task("b", ["a"])], "b");
  request.states = { ...request.states, a: blockedTask() };
  deniedFor(request, "DEPENDENCY_NOT_VERIFIED");
});

test("a claimed verified predecessor with inconsistent stage history cannot dispatch", () => {
  const request = input([task("a"), task("b", ["a"])], "b");
  request.states = { ...request.states, a: { ...createPendingTask(), status: "VERIFIED" } };
  (request.authorization as TrustedAuthorizationContext).verifiedTaskEvidence = {
    a: { identity: verifiedIdentity("a"), requirementsVersion: "requirements-v1", commitSha: commitSha("a"), evidenceReferences: ["review-a"] },
  };
  (request.authorization as TrustedAuthorizationContext).expectedVerifiedCommitByTask = { a: commitSha("a") };
  (request.authorization as TrustedAuthorizationContext).expectedVerifiedIdentityByTask = { a: verifiedIdentity("a") };
  deniedFor(request, "STATE_INCONSISTENT");
});

test("fails closed on missing or stale authorization and changed approved dependencies", () => {
  const request = input([task("a")], "a");
  const missingExpectedCommits = { ...request.authorization };
  delete missingExpectedCommits.expectedVerifiedCommitByTask;
  const missingExpectedIdentities = { ...request.authorization };
  delete missingExpectedIdentities.expectedVerifiedIdentityByTask;
  deniedFor({ ...request, authorization: undefined }, "AUTHORIZATION_MISSING");
  deniedFor({ ...request, authorization: { ...request.authorization, authorizationEvidenceReferences: [] } }, "AUTHORIZATION_MISSING");
  deniedFor({ ...request, authorization: missingExpectedCommits }, "AUTHORIZATION_MISSING");
  deniedFor({ ...request, authorization: missingExpectedIdentities }, "AUTHORIZATION_MISSING");
  deniedFor({ ...request, authorization: { ...request.authorization, authorizedRequirementsVersion: "  " } }, "AUTHORIZATION_MISSING");
  deniedFor({ ...request, proposedRequirementsVersion: "requirements-v0" }, "REQUIREMENTS_MISMATCH");
  deniedFor({ ...request, authorization: { ...request.authorization, currentRequirementsVersion: "requirements-v2" } }, "REQUIREMENTS_MISMATCH");
  deniedFor({ ...request, authorization: { ...request.authorization, environmentAuthorized: false } }, "ENVIRONMENT_UNAUTHORIZED");
  deniedFor({ ...request, authorization: { ...request.authorization, authorizedTaskIds: [] } }, "TASK_NOT_AUTHORIZED");
  deniedFor({ ...request, authorization: { ...request.authorization, approvedDependenciesByTask: {} } }, "DEPENDENCIES_NOT_AUTHORIZED");
});

test("enforces exact approved file scope and rejects ambiguous paths", () => {
  const request = input([task("a")], "a");
  assert.deepEqual(evaluateDispatchEligibility(request), { eligible: true, reasons: [] });
  deniedFor({ ...request, authorization: { ...request.authorization, approvedFileScope: ["src/other.ts"] } }, "FILE_SCOPE_UNAUTHORIZED");
  deniedFor({ ...request, tasks: [{ ...task("a"), fileScope: ["src/../secret.ts"] }] }, "FILE_SCOPE_UNAUTHORIZED");
  deniedFor({ ...request, tasks: [{ ...task("a"), fileScope: ["src/*.ts"] }] }, "FILE_SCOPE_UNAUTHORIZED");
});

test("task-specific approval cannot be borrowed from another task's issue-level scope", () => {
  const request = input([task("a"), task("b")], "a");
  assert.deepEqual(evaluateDispatchEligibility(request), { eligible: true, reasons: [] });
  deniedFor({ ...request, tasks: [{ ...task("a"), fileScope: ["src/b.ts"] }, task("b")] }, "FILE_SCOPE_UNAUTHORIZED");
});

test("missing, malformed, or insufficient task-specific file approval denies dispatch", () => {
  const request = input([task("a"), task("b")], "a");
  const missingApproval = { ...request.authorization };
  delete missingApproval.approvedFileScopeByTask;
  deniedFor({ ...request, authorization: missingApproval }, "TASK_FILE_SCOPE_MISSING");
  deniedFor({ ...request, authorization: { ...request.authorization, approvedFileScopeByTask: { b: ["src/b.ts"] } } }, "TASK_FILE_SCOPE_MISSING");
  deniedFor({ ...request, authorization: { ...request.authorization, approvedFileScopeByTask: { a: [] } } }, "TASK_FILE_SCOPE_MISSING");
  deniedFor({ ...request, authorization: { ...request.authorization, approvedFileScopeByTask: { a: "src/a.ts" as unknown as string[] } } }, "TASK_FILE_SCOPE_MISSING");
  deniedFor({ ...request, authorization: { ...request.authorization, approvedFileScopeByTask: { a: ["src/../a.ts"] } } }, "TASK_FILE_SCOPE_MISSING");
  deniedFor({ ...request, authorization: { ...request.authorization, approvedFileScopeByTask: { a: ["src/b.ts"] } } }, "FILE_SCOPE_UNAUTHORIZED");
});

test("independent risk assessment overrides planner underestimation", () => {
  const request = input([task("a")], "a");
  deniedFor({ ...request, authorization: { ...request.authorization, assessedRiskByTask: {} } }, "RISK_ASSESSMENT_MISSING");
  deniedFor({ ...request, authorization: { ...request.authorization, assessedRiskByTask: { a: "HIGH" } } }, "RISK_LIMIT_EXCEEDED");
  deniedFor({ ...request, tasks: [{ ...task("a"), risk: "HIGH" }] }, "RISK_LIMIT_EXCEEDED");
  deniedFor({ ...request, tasks: [{ ...task("a"), risk: "UNKNOWN" as "LOW" }] }, "RISK_LIMIT_EXCEEDED");
});

test("blocked tasks require anchored, current technical independence evidence", () => {
  const request = input([task("blocked"), task("candidate")], "candidate");
  request.states = { ...request.states, blocked: blockedTask() };
  deniedFor(request, "INDEPENDENCE_UNPROVEN");

  const auth = request.authorization as TrustedAuthorizationContext;
  auth.independenceAssessments = [{
    candidateTaskId: "candidate",
    blockedTaskId: "blocked",
    blockIndex: 0,
    runId: "run-1",
    taskGraphSnapshot: taskGraphSnapshot(request.tasks),
    requirementsVersion: "requirements-v1",
    repositoryCommitSha: commitSha("b"),
    blockerEvidenceReference: "blocker-evidence",
    impact: "INDEPENDENT",
    blockerScope: "TASK_LOCAL",
    assessedAreas: ["CODE", "DATA_CONTRACT", "BEHAVIOR", "SHARED_FILES", "INTERFACES", "INTEGRATION"],
    evidenceReferences: ["shared-contract-analysis"],
  }];
  auth.currentRunId = "run-1";
  auth.currentRepositoryCommitSha = commitSha("b");
  assert.deepEqual(evaluateDispatchEligibility(request), { eligible: true, reasons: [] });
  const assessment = auth.independenceAssessments[0]!;
  auth.independenceAssessments = [{ ...assessment, blockerEvidenceReference: "stale-blocker" }];
  deniedFor(request, "INDEPENDENCE_UNPROVEN");
  auth.independenceAssessments = [{ ...assessment, impact: "UNCERTAIN" }];
  deniedFor(request, "BLOCKER_IMPACT_UNRESOLVED");
  auth.independenceAssessments = [{ ...assessment, blockerScope: "SHARED" }];
  deniedFor(request, "BLOCKER_IMPACT_UNRESOLVED");
  auth.independenceAssessments = [assessment, { ...assessment, impact: "AFFECTED" }];
  deniedFor(request, "INDEPENDENCE_UNPROVEN");
  auth.independenceAssessments = [{ ...assessment, runId: "old-run" }];
  deniedFor(request, "INDEPENDENCE_UNPROVEN");
  auth.independenceAssessments = [{ ...assessment, taskGraphSnapshot: "old-graph" }];
  deniedFor(request, "INDEPENDENCE_UNPROVEN");
  auth.independenceAssessments = [{ ...assessment, repositoryCommitSha: commitSha("a") }];
  deniedFor(request, "INDEPENDENCE_UNPROVEN");
  auth.independenceAssessments = [{ ...assessment, assessedAreas: ["CODE"] }];
  deniedFor(request, "INDEPENDENCE_UNPROVEN");
});

test("independence assessment is bound to the current block even when evidence and commit repeat", () => {
  const request = input([task("blocked"), task("candidate")], "candidate");
  request.states = { ...request.states, blocked: blockedTask() };
  const auth = request.authorization as TrustedAuthorizationContext;
  const assessment = {
    candidateTaskId: "candidate",
    blockedTaskId: "blocked",
    blockIndex: 0,
    runId: "run-1",
    taskGraphSnapshot: taskGraphSnapshot(request.tasks),
    requirementsVersion: "requirements-v1",
    repositoryCommitSha: commitSha("b"),
    blockerEvidenceReference: "blocker-evidence",
    impact: "INDEPENDENT" as const,
    blockerScope: "TASK_LOCAL" as const,
    assessedAreas: ["CODE", "DATA_CONTRACT", "BEHAVIOR", "SHARED_FILES", "INTERFACES", "INTEGRATION"] as const,
    evidenceReferences: ["shared-contract-analysis"],
  };
  auth.currentRunId = "run-1";
  auth.currentRepositoryCommitSha = commitSha("b");
  auth.independenceAssessments = [assessment];
  assert.deepEqual(evaluateDispatchEligibility(request), { eligible: true, reasons: [] });

  const resumed = applyTaskTransition(request.states.blocked!, {
    type: "RESUME",
    decision: {
      blockerResolved: true, requirementsValid: true, repositoryValid: true,
      dependenciesValid: true, environmentAuthorized: true,
      evidenceReferences: ["trusted-resume"], stageRevalidations: [],
    },
  });
  assert.equal(resumed.applied, true);
  if (!resumed.applied) return;
  const blockedAgain = applyTaskTransition(resumed.state, {
    type: "BLOCK",
    reason: { code: "EVIDENCE", detail: "Task-local question remains" },
    evidenceReferences: ["blocker-evidence"],
    authorizedNextAction: "Investigate",
  });
  assert.equal(blockedAgain.applied, true);
  if (!blockedAgain.applied) return;
  assert.equal(blockedAgain.state.blockHistory.length, 2);
  assert.equal(blockedAgain.state.recoveryHistory.length, 1);
  request.states = { ...request.states, blocked: blockedAgain.state };
  deniedFor(request, "INDEPENDENCE_UNPROVEN");

  auth.independenceAssessments = [{ ...assessment, blockIndex: 1 }];
  assert.deepEqual(evaluateDispatchEligibility(request), { eligible: true, reasons: [] });
  for (const blockIndex of [undefined, null, -1, 0.5, NaN, "1", 2]) {
    auth.independenceAssessments = [{ ...assessment, blockIndex: blockIndex as number }];
    deniedFor(request, "INDEPENDENCE_UNPROVEN");
  }
  const { blockIndex: _removed, ...missingIndex } = assessment;
  auth.independenceAssessments = [missingIndex as typeof assessment];
  deniedFor(request, "INDEPENDENCE_UNPROVEN");
});

test("rejects concurrent implementation and a candidate outside pending state", () => {
  const request = input([task("a"), task("b")], "b");
  request.states = { ...request.states, a: advance(createPendingTask(), "IMPLEMENTING", "DISPATCH_APPROVED") };
  deniedFor(request, "CONCURRENT_IMPLEMENTATION");
  request.states = { ...request.states, a: createPendingTask(), b: blockedTask() };
  deniedFor(request, "TASK_NOT_PENDING");
});

test("rejects an internally inconsistent pending state", () => {
  const request = input([task("a")], "a");
  request.states = {
    a: { ...createPendingTask(), completedStages: [{
      stage: "PENDING",
      decision: "DISPATCH_APPROVED",
      evidenceReferences: ["forged"],
    }] },
  };
  deniedFor(request, "STATE_INCONSISTENT");
});

test("does not read inherited object properties as task state or authorization", () => {
  const request = input([task("constructor")], "constructor");
  deniedFor({ ...request, states: {} }, "MISSING_TASK_STATE");
  deniedFor({ ...request, authorization: { ...request.authorization, approvedDependenciesByTask: {} } }, "DEPENDENCIES_NOT_AUTHORIZED");
});
