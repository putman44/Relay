import assert from "node:assert/strict";
import test from "node:test";
import {
  simulateOrchestration,
  type SimulatedTaskInput,
  type SimulationInput,
  type SimulationTrace,
} from "../../src/orchestration/simulate.js";
import type { ExecutionIdentity } from "../../src/orchestration/contracts.js";
import type { TaskProposal, TrustedAuthorizationContext } from "../../src/orchestration/policy.js";
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

test("a blocked implementer needs no simulated commit snapshot", () => {
  const input = fixture();
  const task = taskInputs(input, "a");
  const identity = taskIdentity("a", "impl");
  task.implementer.value = {
    ...identity,
    role: "implementer",
    status: "BLOCKED",
    reason: "Approved scope is insufficient",
    evidenceReferences: [evidence(identity, "scope-block")],
    recommendedNextAction: "Replan",
  };
  delete task.commit;
  const result = simulateOrchestration(input);
  assert.equal(result.failure?.code, "IMPLEMENTER_BLOCKED");
  assert.equal(result.states.a?.status, "IMPLEMENTING");
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
