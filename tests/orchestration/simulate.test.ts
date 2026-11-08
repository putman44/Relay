import assert from "node:assert/strict";
import test from "node:test";
import {
  simulateOrchestration,
  type SimulatedTaskInput,
  type SimulationInput,
  type SimulationTrace,
} from "../../src/orchestration/simulate.js";
import type { ExecutionIdentity } from "../../src/orchestration/contracts.js";
import { validateRunCheckpoint } from "../../src/orchestration/checkpoint.js";
import { taskGraphSnapshot, type TaskProposal, type TrustedAuthorizationContext, type TrustedIndependenceAssessment } from "../../src/orchestration/policy.js";
import type { StageDecisionKind } from "../../src/orchestration/state.js";

const plannerIdentity: ExecutionIdentity = {
  schemaVersion: 1,
  runId: "run-1",
  taskId: "planner-invocation",
  attemptId: "plan-1",
  requirementsVersion: "requirements-v1",
};
const commitSha = (id: string): string => id.repeat(40);
const taskIdentity = (id: string, role: "impl" | "review"): ExecutionIdentity => ({
  ...plannerIdentity,
  taskId: id,
  attemptId: `${role}-${id}`,
});
const evidence = (identity: ExecutionIdentity, referenceId: string, commit?: string) => ({
  ...identity,
  referenceId,
  kind: "REPOSITORY" as const,
  locator: `evidence/${referenceId}`,
  ...(commit === undefined ? {} : { commitSha: commit }),
});
const check = (identity: ExecutionIdentity, commit: string) => ({
  ...evidence(identity, "check", commit),
  kind: "CHECK" as const,
  check: "focused tests",
  result: "PASSED" as const,
  environment: "simulated-local",
  configuration: "focused",
});

const proposedTask = (id: string, dependencies: string[] = []): TaskProposal & {
  summary: string;
  complexity: "LOW";
  verificationRequirements: string[];
} => ({
  taskId: id,
  summary: `Implement ${id}`,
  dependencies,
  fileScope: [`src/${id}.ts`],
  complexity: "LOW",
  risk: "LOW",
  verificationRequirements: ["focused tests"],
});

function taskInput(id: string): SimulatedTaskInput {
  const impl = taskIdentity(id, "impl");
  const review = taskIdentity(id, "review");
  const sha = commitSha(id);
  const gate = (kind: StageDecisionKind, identity: ExecutionIdentity, withCommit = true) => ({
    identity,
    kind,
    evidenceReferences: [`trusted:${id}:${kind}`],
    ...(withCommit ? { commitSha: sha } : {}),
  });
  return {
    implementer: {
      attemptId: impl.attemptId,
      value: {
        ...impl,
        role: "implementer",
        status: "COMPLETED",
        commitSha: sha,
        changedFiles: [`src/${id}.ts`],
        verificationEvidence: [check(impl, sha)],
      },
    },
    reviewer: {
      attemptId: review.attemptId,
      value: {
        ...review,
        role: "reviewer",
        status: "PASSED",
        commitSha: sha,
        coverage: {
          filesExamined: [`src/${id}.ts`],
          requirementsEvaluated: ["requirements-v1"],
          behaviorsEvaluated: [`behavior-${id}`],
          verificationChecks: [check(review, sha)],
          limitations: [],
        },
        evidenceReferences: [evidence(review, "review", sha)],
      },
    },
    commit: {
      identity: impl,
      commitSha: sha,
      changedFiles: [`src/${id}.ts`],
      evidenceReferences: [`trusted-commit:${id}`],
    },
    gates: {
      DISPATCH_APPROVED: gate("DISPATCH_APPROVED", impl, false),
      IMPLEMENTATION_CONFIRMED: gate("IMPLEMENTATION_CONFIRMED", impl),
      VERIFICATION_PASSED: gate("VERIFICATION_PASSED", impl),
      PUBLICATION_CONFIRMED: gate("PUBLICATION_CONFIRMED", impl),
      REVIEW_PASSED: gate("REVIEW_PASSED", review),
    },
    verifiedTaskEvidence: {
      identity: review,
      commitSha: sha,
      requirementsVersion: "requirements-v1",
      evidenceReferences: [`trusted-review:${id}`],
    },
  };
}

function fixture(tasks = [proposedTask("a")]): SimulationInput {
  const authorization: TrustedAuthorizationContext = {
    authorizedRequirementsVersion: "requirements-v1",
    currentRequirementsVersion: "requirements-v1",
    authorizedTaskIds: tasks.map((item) => item.taskId),
    approvedDependenciesByTask: Object.fromEntries(tasks.map((item) => [item.taskId, item.dependencies])),
    approvedFileScopeByTask: Object.fromEntries(tasks.map((item) => [item.taskId, [`src/${item.taskId}.ts`]])),
    approvedFileScope: tasks.map((item) => `src/${item.taskId}.ts`),
    maxAuthorizedRisk: "MEDIUM",
    assessedRiskByTask: Object.fromEntries(tasks.map((item) => [item.taskId, "LOW"])),
    environmentAuthorized: true,
    authorizationEvidenceReferences: ["trusted-authorization"],
    verifiedTaskEvidence: {},
    expectedVerifiedCommitByTask: {},
    expectedVerifiedIdentityByTask: {},
    independenceAssessments: [],
  };
  return {
    planner: {
      context: { ...plannerIdentity, expectedRole: "planner" },
      value: {
        ...plannerIdentity,
        role: "planner",
        status: "READY",
        plan: { summary: "Simulated implementation", tasks },
        evidenceReferences: [evidence(plannerIdentity, "requirements")],
      },
    },
    tasks: Object.fromEntries(tasks.map((item) => [item.taskId, taskInput(item.taskId)])),
    authorization,
  };
}

const taskInputs = (input: SimulationInput, id: string): SimulatedTaskInput => input.tasks[id]!;
const stateTrace = (trace: readonly SimulationTrace[]): string[] => trace
  .filter((item): item is Extract<SimulationTrace, { type: "STATE" }> => item.type === "STATE")
  .map((item) => `${item.taskId}:${item.status}`);

test("simulates one task through VERIFIED using separate trusted gates", () => {
  const input = fixture();
  const result = simulateOrchestration(input);
  assert.equal(result.status, "ALL_TASKS_VERIFIED");
  assert.equal(result.states.a?.status, "VERIFIED");
  assert.deepEqual(stateTrace(result.trace), [
    "a:IMPLEMENTING", "a:VERIFYING", "a:PUBLISHING", "a:IN_REVIEW", "a:VERIFIED",
  ]);
  assert.deepEqual(input.authorization.verifiedTaskEvidence, {});
  assert.deepEqual(input.authorization.expectedVerifiedCommitByTask, {});
  assert.deepEqual(input.authorization.expectedVerifiedIdentityByTask, {});
});

test("rejects malformed and stale planner responses before creating task state", () => {
  const malformed = fixture();
  malformed.planner.value = { ...plannerIdentity, role: "planner", status: "READY" };
  const malformedResult = simulateOrchestration(malformed);
  assert.equal(malformedResult.failure?.code, "PLANNER_SCHEMA_INVALID");
  assert.deepEqual(Object.keys(malformedResult.states), []);

  const stale = fixture();
  stale.planner.context = { ...stale.planner.context, attemptId: "plan-2" };
  const staleResult = simulateOrchestration(stale);
  assert.equal(staleResult.failure?.code, "PLANNER_CONTEXT_MISMATCH");
  assert.deepEqual(Object.keys(staleResult.states), []);
});

test("policy denies unauthorized task dispatch without changing pending state", () => {
  const input = fixture();
  input.authorization.approvedFileScopeByTask = { a: ["src/other.ts"] };
  const result = simulateOrchestration(input);
  assert.equal(result.failure?.code, "POLICY_DENIED");
  assert.equal(result.states.a?.status, "PENDING");
  assert.ok(result.trace.some((item) => item.type === "DISPATCH_DENIED" &&
    item.reasons.some((reason) => reason.code === "FILE_SCOPE_UNAUTHORIZED")));
});

test("missing trusted verification gate stops even when agents claim success", () => {
  const input = fixture();
  delete taskInputs(input, "a").gates.VERIFICATION_PASSED;
  const result = simulateOrchestration(input);
  assert.equal(result.failure?.code, "TRUSTED_GATE_MISSING");
  assert.equal(result.states.a?.status, "VERIFYING");
});

test("a trusted gate bound to a different commit cannot advance", () => {
  const input = fixture();
  const task = taskInputs(input, "a");
  task.gates.VERIFICATION_PASSED = {
    ...task.gates.VERIFICATION_PASSED!,
    commitSha: commitSha("b"),
  };
  const result = simulateOrchestration(input);
  assert.equal(result.failure?.code, "TRUSTED_GATE_MISMATCH");
  assert.equal(result.states.a?.status, "VERIFYING");
});

test("implementer commit claim must match the trusted simulated commit", () => {
  const input = fixture();
  const impl = taskInputs(input, "a").implementer.value as Record<string, unknown>;
  taskInputs(input, "a").implementer.value = { ...impl, commitSha: commitSha("b") };
  const result = simulateOrchestration(input);
  assert.equal(result.failure?.code, "COMMIT_EVIDENCE_MISMATCH");
  assert.equal(result.states.a?.status, "IMPLEMENTING");
});

function blockedImplementerInput(input: SimulationInput, id = "a"): SimulatedTaskInput {
  const task = taskInputs(input, id);
  const identity = taskIdentity(id, "impl");
  task.implementer.value = {
    ...identity,
    role: "implementer",
    status: "BLOCKED",
    reason: "Approved scope is insufficient",
    evidenceReferences: [evidence(identity, "scope-block")],
    recommendedNextAction: "Replan",
  };
  delete task.commit;
  return task;
}

function authorizedImplementerBlock(input: SimulationInput): void {
  blockedImplementerInput(input).implementerBlock = {
    identity: taskIdentity("a", "impl"),
    reason: { code: "REQUIREMENTS", detail: "Approved file scope needs reassessment" },
    evidenceReferences: ["trusted:scope-assessment"],
    authorizedNextAction: "Request planner reassessment",
  };
}

test("an authorized implementer block preserves trusted recovery context and validates as a checkpoint", () => {
  const input = fixture([proposedTask("a"), proposedTask("b")]);
  const task = blockedImplementerInput(input);
  const identity = taskIdentity("a", "impl");
  task.implementerBlock = {
    identity,
    reason: { code: "REQUIREMENTS", detail: "Approved file scope needs reassessment" },
    evidenceReferences: ["trusted:scope-assessment"],
    authorizedNextAction: "Request planner reassessment",
  };
  const result = simulateOrchestration(input);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.states.a?.status, "BLOCKED");
  assert.deepEqual(result.states.a?.completedStages, [{
    stage: "PENDING", decision: "DISPATCH_APPROVED", evidenceReferences: ["trusted:a:DISPATCH_APPROVED"],
  }]);
  assert.deepEqual(result.states.a?.blockHistory, [{
    lastValidStage: "IMPLEMENTING",
    reason: { code: "REQUIREMENTS", detail: "Approved file scope needs reassessment" },
    evidenceReferences: ["trusted:scope-assessment"],
    authorizedNextAction: "Request planner reassessment",
  }]);
  assert.deepEqual(result.states.a?.recoveryHistory, []);
  assert.equal(result.states.b?.status, "PENDING");
  assert.deepEqual(stateTrace(result.trace), ["a:IMPLEMENTING", "a:BLOCKED"]);
  const checkpoint = validateRunCheckpoint({
    schemaVersion: 1,
    revision: 1,
    runId: plannerIdentity.runId,
    repository: { repositoryId: "relay", branch: "feature/relay-v2-phase-2" },
    workItemId: "issue-24",
    authorizedRequirementsVersion: plannerIdentity.requirementsVersion,
    authorizationEvidenceReferences: ["trusted-authorization"],
    taskGraph: ["a", "b"].map((id) => ({
      taskId: id, dependencies: [], fileScope: [`src/${id}.ts`], risk: "LOW",
    })),
    taskRecords: ["a", "b"].map((id) => ({ taskId: id, state: result.states[id] })),
    executionRecords: [{
      recordId: "impl-a", role: "implementer", identity,
      evidenceReferences: ["trusted:scope-assessment"],
    }],
  });
  assert.equal(checkpoint.valid, true);
});

test("an implementer report alone cannot block a task or dispatch another task", () => {
  const input = fixture([proposedTask("a"), proposedTask("b")]);
  blockedImplementerInput(input);
  const result = simulateOrchestration(input);
  assert.equal(result.failure?.code, "IMPLEMENTER_BLOCK_DECISION_MISSING");
  assert.equal(result.states.a?.status, "IMPLEMENTING");
  assert.deepEqual(result.states.a?.blockHistory, []);
  assert.equal(result.states.b?.status, "PENDING");
  assert.deepEqual(stateTrace(result.trace), ["a:IMPLEMENTING"]);
});

test("invalid trusted implementer block decisions fail closed", () => {
  const identity = taskIdentity("a", "impl");
  const validBlock = {
    identity,
    reason: { code: "REQUIREMENTS" as const, detail: "Approved scope needs reassessment" },
    evidenceReferences: ["trusted:scope-assessment"],
    authorizedNextAction: "Request planner reassessment",
  };
  for (const block of [
    { ...validBlock, identity: { ...identity, attemptId: "stale-attempt" } },
    { ...validBlock, reason: { code: "UNKNOWN", detail: "Unclassified" } },
    { ...validBlock, reason: { ...validBlock.reason, untrusted: "extra field" } },
    { ...validBlock, evidenceReferences: [] },
    { ...validBlock, authorizedNextAction: " " },
  ]) {
    const input = fixture();
    blockedImplementerInput(input).implementerBlock = block as NonNullable<SimulatedTaskInput["implementerBlock"]>;
    const result = simulateOrchestration(input);
    assert.equal(result.failure?.code, "IMPLEMENTER_BLOCK_DECISION_MISMATCH");
    assert.equal(result.states.a?.status, "IMPLEMENTING");
    assert.deepEqual(result.states.a?.blockHistory, []);
    assert.deepEqual(stateTrace(result.trace), ["a:IMPLEMENTING"]);
  }
});

test("a stale implementer BLOCKED report cannot use a trusted block decision", () => {
  const input = fixture();
  const task = blockedImplementerInput(input);
  const identity = taskIdentity("a", "impl");
  task.implementer.value = { ...(task.implementer.value as Record<string, unknown>), attemptId: "stale-attempt" };
  task.implementerBlock = {
    identity,
    reason: { code: "REQUIREMENTS", detail: "Approved scope needs reassessment" },
    evidenceReferences: ["trusted:scope-assessment"],
    authorizedNextAction: "Request planner reassessment",
  };
  const result = simulateOrchestration(input);
  assert.equal(result.failure?.code, "IMPLEMENTER_CONTEXT_MISMATCH");
  assert.equal(result.states.a?.status, "IMPLEMENTING");
  assert.deepEqual(result.states.a?.blockHistory, []);
});

test("a PASSED reviewer cannot verify without its trusted review gate", () => {
  const input = fixture();
  delete taskInputs(input, "a").gates.REVIEW_PASSED;
  const result = simulateOrchestration(input);
  assert.equal(result.failure?.code, "TRUSTED_GATE_MISSING");
  assert.equal(result.states.a?.status, "IN_REVIEW");
});

test("a PASSED reviewer reporting an incomplete check cannot verify", () => {
  const input = fixture();
  const reviewer = taskInputs(input, "a").reviewer.value as Record<string, unknown>;
  const coverage = reviewer.coverage as Record<string, unknown>;
  const checks = coverage.verificationChecks as Record<string, unknown>[];
  taskInputs(input, "a").reviewer.value = {
    ...reviewer,
    coverage: { ...coverage, verificationChecks: [{ ...checks[0], result: "INCOMPLETE" }] },
  };
  const result = simulateOrchestration(input);
  assert.equal(result.failure?.code, "REVIEWER_REPORTED_INCOMPLETE");
  assert.equal(result.states.a?.status, "IN_REVIEW");
});

test("a BLOCKED reviewer produces a blocked task only with a trusted block decision", () => {
  const input = fixture();
  const review = taskIdentity("a", "review");
  const sha = commitSha("a");
  taskInputs(input, "a").reviewer.value = {
    ...review,
    role: "reviewer",
    status: "BLOCKED",
    commitSha: sha,
    coverage: {
      filesExamined: [],
      requirementsEvaluated: ["requirements-v1"],
      behaviorsEvaluated: [],
      verificationChecks: [],
      limitations: ["Review interrupted"],
    },
    reasons: ["INCOMPLETE_VERIFICATION"],
    findings: [{
      findingId: "finding-1",
      classification: "UNVERIFIED_TECHNICAL_CONCERN",
      severity: "HIGH",
      summary: "Review is incomplete",
      technicalEvidence: [evidence(review, "finding", sha)],
      recommendedAction: "Repeat review",
    }],
    evidenceReferences: [evidence(review, "review-block", sha)],
    recommendedNextActions: ["Repeat review"],
  };
  const withoutBlock = simulateOrchestration(input);
  assert.equal(withoutBlock.failure?.code, "REVIEW_BLOCK_DECISION_MISSING");
  assert.equal(withoutBlock.states.a?.status, "IN_REVIEW");

  taskInputs(input, "a").reviewBlock = {
    identity: review,
    commitSha: sha,
    reason: { code: "REVIEW", detail: "Independent review incomplete" },
    evidenceReferences: ["trusted-review-block"],
    authorizedNextAction: "Repeat independent review",
  };
  const result = simulateOrchestration(input);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.states.a?.status, "BLOCKED");
  assert.equal(result.states.a?.blockHistory.at(-1)?.lastValidStage, "IN_REVIEW");
  assert.ok(!stateTrace(result.trace).includes("a:VERIFIED"));
});

function blockedReviewerInput(input: SimulationInput, id = "a"): void {
  const review = taskIdentity(id, "review");
  const sha = commitSha(id);
  const task = taskInputs(input, id);
  task.reviewer.value = {
    ...review,
    role: "reviewer",
    status: "BLOCKED",
    commitSha: sha,
    coverage: {
      filesExamined: [`src/${id}.ts`], requirementsEvaluated: ["requirements-v1"],
      behaviorsEvaluated: [], verificationChecks: [], limitations: ["Unresolved task-local concern"],
    },
    reasons: ["UNVERIFIED_TECHNICAL_CONCERN"],
    findings: [{
      findingId: `finding-${id}`, classification: "UNVERIFIED_TECHNICAL_CONCERN", severity: "HIGH",
      summary: "Task-local concern", technicalEvidence: [evidence(review, "finding", sha)],
      recommendedAction: "Investigate",
    }],
    evidenceReferences: [evidence(review, "review-block", sha)],
    recommendedNextActions: ["Investigate"],
  };
  task.reviewBlock = {
    identity: review, commitSha: sha,
    reason: { code: "REVIEW", detail: "Task-local concern remains" },
    evidenceReferences: [`trusted-review-block:${id}`],
    authorizedNextAction: "Investigate task-local concern",
  };
}

function independence(input: SimulationInput, candidateTaskId: string, overrides: Partial<TrustedIndependenceAssessment> = {}): TrustedIndependenceAssessment {
  const tasks = (input.planner.value as { plan: { tasks: TaskProposal[] } }).plan.tasks;
  return {
    candidateTaskId, blockedTaskId: "a", blockIndex: 0, runId: plannerIdentity.runId,
    taskGraphSnapshot: taskGraphSnapshot(tasks), requirementsVersion: plannerIdentity.requirementsVersion,
    repositoryCommitSha: commitSha("a"), blockerEvidenceReference: "trusted-review-block:a",
    impact: "INDEPENDENT", blockerScope: "TASK_LOCAL",
    assessedAreas: ["CODE", "DATA_CONTRACT", "BEHAVIOR", "SHARED_FILES", "INTERFACES", "INTEGRATION"],
    evidenceReferences: [`trusted-impact:${candidateTaskId}`], ...overrides,
  };
}

function implementerIndependence(
  input: SimulationInput,
  candidateTaskId: string,
  repositoryCommitSha: string,
  overrides: Partial<TrustedIndependenceAssessment> = {},
): TrustedIndependenceAssessment {
  return independence(input, candidateTaskId, {
    repositoryCommitSha,
    blockerEvidenceReference: "trusted:scope-assessment",
    ...overrides,
  });
}

const dispatchDenials = (trace: readonly SimulationTrace[], id: string): string[] => trace
  .filter((item): item is Extract<SimulationTrace, { type: "DISPATCH_DENIED" }> =>
    item.type === "DISPATCH_DENIED" && item.taskId === id)
  .flatMap((item) => item.reasons.map((reason) => reason.code));

test("independent task continues after authorized implementer block without task commit evidence", () => {
  const input = fixture([proposedTask("a"), proposedTask("b", ["a"]), proposedTask("c", ["b"]), proposedTask("d")]);
  authorizedImplementerBlock(input);
  input.authorization.currentRepositoryCommitSha = commitSha("e");
  input.authorization.independenceAssessments = [implementerIndependence(input, "d", commitSha("e"))];
  const result = simulateOrchestration(input);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.failure, undefined);
  assert.equal(taskInputs(input, "a").commit, undefined);
  assert.equal(result.states.a?.status, "BLOCKED");
  assert.deepEqual(result.states.a?.blockHistory, [{
    lastValidStage: "IMPLEMENTING",
    reason: { code: "REQUIREMENTS", detail: "Approved file scope needs reassessment" },
    evidenceReferences: ["trusted:scope-assessment"],
    authorizedNextAction: "Request planner reassessment",
  }]);
  assert.equal(result.states.a?.completedStages.length, 1);
  assert.equal(result.states.b?.status, "PENDING");
  assert.equal(result.states.c?.status, "PENDING");
  assert.equal(result.states.d?.status, "VERIFIED");
  assert.ok(dispatchDenials(result.trace, "b").includes("DEPENDENCY_NOT_VERIFIED"));
  assert.ok(dispatchDenials(result.trace, "c").includes("DEPENDENCY_NOT_VERIFIED"));
  assert.ok(stateTrace(result.trace).indexOf("a:BLOCKED") < stateTrace(result.trace).indexOf("d:IMPLEMENTING"));
});

test("implementer continuation requires current trusted HEAD and candidate-specific complete assessment", () => {
  const cases: [string, boolean, (input: SimulationInput) => TrustedIndependenceAssessment[]][] = [
    ["missing HEAD", false, (input) => [implementerIndependence(input, "b", commitSha("e"))]],
    ["invalid HEAD", true, (input) => [implementerIndependence(input, "b", commitSha("e"))]],
    ["missing assessment", false, () => []],
    ["wrong candidate", false, (input) => [implementerIndependence(input, "c", commitSha("e"))]],
    ["stale observation", true, (input) => [implementerIndependence(input, "b", commitSha("e"))]],
    ["stale run", false, (input) => [implementerIndependence(input, "b", commitSha("e"), { runId: "old-run" })]],
    ["stale graph", false, (input) => [implementerIndependence(input, "b", commitSha("e"), { taskGraphSnapshot: "old-graph" })]],
    ["stale requirements", false, (input) => [implementerIndependence(input, "b", commitSha("e"), { requirementsVersion: "old-requirements" })]],
    ["wrong occurrence", false, (input) => [implementerIndependence(input, "b", commitSha("e"), { blockIndex: 1 })]],
    ["wrong blocker evidence", false, (input) => [implementerIndependence(input, "b", commitSha("e"), { blockerEvidenceReference: "other" })]],
    ["incomplete technical areas", false, (input) => [implementerIndependence(input, "b", commitSha("e"), { assessedAreas: ["CODE"] })]],
    ["uncertain impact", false, (input) => [implementerIndependence(input, "b", commitSha("e"), { impact: "UNCERTAIN" })]],
    ["affected interface", false, (input) => [implementerIndependence(input, "b", commitSha("e"), { impact: "AFFECTED" })]],
    ["shared scope", false, (input) => [implementerIndependence(input, "b", commitSha("e"), { blockerScope: "SHARED" })]],
  ];
  for (const [name, setHead, assessments] of cases) {
    const input = fixture([proposedTask("a"), proposedTask("b"), proposedTask("c", ["a"])]);
    authorizedImplementerBlock(input);
    if (setHead) input.authorization.currentRepositoryCommitSha = name === "invalid HEAD" ? "not-a-sha" : commitSha("f");
    if (!setHead && name !== "missing HEAD") input.authorization.currentRepositoryCommitSha = commitSha("e");
    input.authorization.independenceAssessments = assessments(input);
    const result = simulateOrchestration(input);
    assert.equal(result.status, "BLOCKED", name);
    assert.equal(result.failure, undefined, name);
    assert.equal(result.states.a?.status, "BLOCKED", name);
    assert.equal(result.states.b?.status, "PENDING", name);
    assert.equal(result.states.c?.status, "PENDING", name);
    assert.ok(dispatchDenials(result.trace, "b").includes(
      ["uncertain impact", "affected interface", "shared scope"].includes(name)
        ? "BLOCKER_IMPACT_UNRESOLVED" : "INDEPENDENCE_UNPROVEN"), name);
  }
});

test("multiple independent tasks execute sequentially after implementer block", () => {
  const input = fixture([proposedTask("a"), proposedTask("c"), proposedTask("b")]);
  authorizedImplementerBlock(input);
  input.authorization.currentRepositoryCommitSha = commitSha("e");
  input.authorization.independenceAssessments = [
    implementerIndependence(input, "b", commitSha("e")),
    implementerIndependence(input, "c", commitSha("b")),
  ];
  const result = simulateOrchestration(input);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.failure, undefined);
  assert.equal(result.states.a?.status, "BLOCKED");
  assert.equal(result.states.b?.status, "VERIFIED");
  assert.equal(result.states.c?.status, "VERIFIED");
  assert.ok(dispatchDenials(result.trace, "c").includes("INDEPENDENCE_UNPROVEN"));
  const states = stateTrace(result.trace);
  assert.ok(states.indexOf("a:BLOCKED") < states.indexOf("b:IMPLEMENTING"));
  assert.ok(states.indexOf("b:VERIFIED") < states.indexOf("c:IMPLEMENTING"));
  assert.equal(states.filter((state) => state.endsWith(":IMPLEMENTING")).length, 3);
});

test("invalid implementer BLOCK authorization prevents otherwise eligible continuation", () => {
  const input = fixture([proposedTask("a"), proposedTask("b")]);
  authorizedImplementerBlock(input);
  taskInputs(input, "a").implementerBlock = {
    ...taskInputs(input, "a").implementerBlock!,
    identity: { ...taskIdentity("a", "impl"), attemptId: "stale-attempt" },
  };
  input.authorization.currentRepositoryCommitSha = commitSha("e");
  input.authorization.independenceAssessments = [implementerIndependence(input, "b", commitSha("e"))];
  const result = simulateOrchestration(input);
  assert.equal(result.failure?.code, "IMPLEMENTER_BLOCK_DECISION_MISMATCH");
  assert.equal(result.states.a?.status, "IMPLEMENTING");
  assert.equal(result.states.b?.status, "PENDING");
  assert.ok(!stateTrace(result.trace).includes("b:IMPLEMENTING"));
});

test("all blocked tasks produce a deterministic terminal result", () => {
  const input = fixture([proposedTask("a"), proposedTask("b")]);
  authorizedImplementerBlock(input);
  const b = blockedImplementerInput(input, "b");
  b.implementerBlock = {
    identity: taskIdentity("b", "impl"),
    reason: { code: "EVIDENCE", detail: "Task-local evidence unavailable" },
    evidenceReferences: ["trusted:b:block"],
    authorizedNextAction: "Request evidence",
  };
  input.authorization.currentRepositoryCommitSha = commitSha("e");
  input.authorization.independenceAssessments = [implementerIndependence(input, "b", commitSha("e"))];
  const result = simulateOrchestration(input);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.failure, undefined);
  assert.equal(result.states.a?.status, "BLOCKED");
  assert.equal(result.states.b?.status, "BLOCKED");
  assert.deepEqual(stateTrace(result.trace), ["a:IMPLEMENTING", "a:BLOCKED", "b:IMPLEMENTING", "b:BLOCKED"]);
});

test("trusted task-local independence continues while blocked history and dependencies remain intact", () => {
  const input = fixture([
    proposedTask("a"), proposedTask("b", ["a"]), proposedTask("c", ["b"]), proposedTask("d"),
  ]);
  blockedReviewerInput(input);
  input.authorization.independenceAssessments = [
    independence(input, "b"), independence(input, "c"), independence(input, "d"),
  ];
  const result = simulateOrchestration(input);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.failure, undefined);
  assert.equal(result.states.a?.status, "BLOCKED");
  assert.deepEqual(result.states.a?.blockHistory, [{
    lastValidStage: "IN_REVIEW", reason: { code: "REVIEW", detail: "Task-local concern remains" },
    evidenceReferences: ["trusted-review-block:a"], authorizedNextAction: "Investigate task-local concern",
  }]);
  assert.equal(result.states.a?.completedStages.length, 4);
  assert.deepEqual(result.states.a?.recoveryHistory, []);
  assert.equal(result.states.b?.status, "PENDING");
  assert.equal(result.states.c?.status, "PENDING");
  assert.equal(result.states.d?.status, "VERIFIED");
  assert.ok(dispatchDenials(result.trace, "b").includes("DEPENDENCY_NOT_VERIFIED"));
  assert.ok(dispatchDenials(result.trace, "c").includes("DEPENDENCY_NOT_VERIFIED"));
  assert.ok(stateTrace(result.trace).indexOf("a:BLOCKED") < stateTrace(result.trace).indexOf("d:IMPLEMENTING"));
  assert.ok(!stateTrace(result.trace).includes("a:VERIFIED"));
});

test("missing, stale, mismatched, and uncertain assessments preserve pending tasks", () => {
  const cases: [string, (input: SimulationInput) => TrustedIndependenceAssessment[]][] = [
    ["missing", () => []],
    ["wrong candidate", (input) => [independence(input, "c")]],
    ["wrong run", (input) => [independence(input, "b", { runId: "old-run" })]],
    ["wrong graph", (input) => [independence(input, "b", { taskGraphSnapshot: "old-graph" })]],
    ["wrong requirements", (input) => [independence(input, "b", { requirementsVersion: "old-requirements" })]],
    ["stale repository", (input) => [independence(input, "b", { repositoryCommitSha: commitSha("z") })]],
    ["wrong blocker", (input) => [independence(input, "b", { blockerEvidenceReference: "other-blocker" })]],
    ["wrong block index", (input) => [independence(input, "b", { blockIndex: 1 })]],
    ["invalid block index", (input) => [independence(input, "b", { blockIndex: -1 })]],
    ["missing block index", (input) => {
      const assessment = independence(input, "b");
      delete (assessment as Partial<TrustedIndependenceAssessment>).blockIndex;
      return [assessment];
    }],
    ["incomplete coverage", (input) => [independence(input, "b", { assessedAreas: ["CODE"] })]],
    ["uncertain impact", (input) => [independence(input, "b", { impact: "UNCERTAIN" })]],
    ["shared impact", (input) => [independence(input, "b", { blockerScope: "SHARED" })]],
    ["affected interface", (input) => [independence(input, "b", { impact: "AFFECTED" })]],
    ["contradictory", (input) => [independence(input, "b"), independence(input, "b", { impact: "AFFECTED" })]],
  ];
  for (const [name, assessments] of cases) {
    const input = fixture([proposedTask("a"), proposedTask("b"), proposedTask("c", ["a"])]);
    blockedReviewerInput(input);
    input.authorization.independenceAssessments = assessments(input);
    const result = simulateOrchestration(input);
    assert.equal(result.status, "BLOCKED", name);
    assert.equal(result.failure, undefined, name);
    assert.equal(result.states.a?.status, "BLOCKED", name);
    assert.equal(result.states.b?.status, "PENDING", name);
    assert.equal(result.states.c?.status, "PENDING", name);
    assert.equal(stateTrace(result.trace).length, 5, name);
    assert.ok(dispatchDenials(result.trace, "b").includes(
      name === "uncertain impact" || name === "shared impact" || name === "affected interface"
        ? "BLOCKER_IMPACT_UNRESOLVED" : "INDEPENDENCE_UNPROVEN"), name);
  }
});

test("multiple independent tasks continue sequentially with repository-fresh assessments", () => {
  const input = fixture([proposedTask("a"), proposedTask("c"), proposedTask("b")]);
  blockedReviewerInput(input);
  input.authorization.independenceAssessments = [
    independence(input, "b"),
    independence(input, "c", { repositoryCommitSha: commitSha("b") }),
  ];
  const result = simulateOrchestration(input);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.states.b?.status, "VERIFIED");
  assert.equal(result.states.c?.status, "VERIFIED");
  assert.ok(dispatchDenials(result.trace, "c").includes("INDEPENDENCE_UNPROVEN"));
  const states = stateTrace(result.trace);
  assert.ok(states.indexOf("b:VERIFIED") < states.indexOf("c:IMPLEMENTING"));
  assert.equal(states.filter((state) => state.endsWith(":IMPLEMENTING")).length, 3);
});

test("dependent task waits until predecessor is verified with trusted evidence", () => {
  const input = fixture([proposedTask("b", ["a"]), proposedTask("a")]);
  const result = simulateOrchestration(input);
  assert.equal(result.status, "ALL_TASKS_VERIFIED");
  assert.equal(result.states.a?.status, "VERIFIED");
  assert.equal(result.states.b?.status, "VERIFIED");
  const denied = result.trace.findIndex((item) => item.type === "DISPATCH_DENIED" && item.taskId === "b");
  const verifiedA = result.trace.findIndex((item) => item.type === "STATE" && item.taskId === "a" && item.status === "VERIFIED");
  const dispatchedB = result.trace.findIndex((item) => item.type === "STATE" && item.taskId === "b" && item.status === "IMPLEMENTING");
  assert.ok(denied >= 0 && denied < verifiedA && verifiedA < dispatchedB);
  assert.deepEqual(input.authorization.verifiedTaskEvidence, {});
  assert.deepEqual(input.authorization.expectedVerifiedCommitByTask, {});
  assert.deepEqual(input.authorization.expectedVerifiedIdentityByTask, {});
});

test("missing trusted task proof leaves the predecessor IN_REVIEW", () => {
  const input = fixture([proposedTask("b", ["a"]), proposedTask("a")]);
  delete taskInputs(input, "a").verifiedTaskEvidence;
  const result = simulateOrchestration(input);
  assert.equal(result.failure?.code, "VERIFIED_TASK_EVIDENCE_MISSING");
  assert.equal(result.states.a?.status, "IN_REVIEW");
  assert.equal(result.states.b?.status, "PENDING");
  assert.ok(!stateTrace(result.trace).includes("a:VERIFIED"));
});

test("mismatched trusted predecessor proof cannot release a dependent task", () => {
  const input = fixture([proposedTask("b", ["a"]), proposedTask("a")]);
  taskInputs(input, "a").verifiedTaskEvidence = {
    ...taskInputs(input, "a").verifiedTaskEvidence!,
    commitSha: commitSha("c"),
  };
  const result = simulateOrchestration(input);
  assert.equal(result.failure?.code, "VERIFIED_TASK_EVIDENCE_MISMATCH");
  assert.equal(result.states.a?.status, "IN_REVIEW");
  assert.equal(result.states.b?.status, "PENDING");
  assert.ok(!stateTrace(result.trace).includes("a:VERIFIED"));
});

test("invalid trusted predecessor commit proof cannot release a dependent task", () => {
  const input = fixture([proposedTask("b", ["a"]), proposedTask("a")]);
  taskInputs(input, "a").verifiedTaskEvidence = {
    ...taskInputs(input, "a").verifiedTaskEvidence!,
    commitSha: "not-a-sha",
  };
  const result = simulateOrchestration(input);
  assert.equal(result.failure?.code, "VERIFIED_TASK_EVIDENCE_MISMATCH");
  assert.equal(result.states.a?.status, "IN_REVIEW");
  assert.equal(result.states.b?.status, "PENDING");
});

test("missing or stale trusted predecessor execution proof cannot release a dependent task", () => {
  for (const identity of [undefined, { ...taskIdentity("a", "review"), runId: "old-run" }]) {
    const input = fixture([proposedTask("b", ["a"]), proposedTask("a")]);
    taskInputs(input, "a").verifiedTaskEvidence = {
      ...taskInputs(input, "a").verifiedTaskEvidence!,
      identity: identity as ExecutionIdentity,
    };
    const result = simulateOrchestration(input);
    assert.equal(result.failure?.code, "VERIFIED_TASK_EVIDENCE_MISMATCH");
    assert.equal(result.states.a?.status, "IN_REVIEW");
    assert.equal(result.states.b?.status, "PENDING");
  }
});
