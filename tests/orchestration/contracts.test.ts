import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentResponseSchema,
  validateResponseContext,
  type AgentResponse,
  type TrustedResponseContext,
} from "../../src/orchestration/contracts.js";

const commitSha = "a".repeat(40);
const otherCommitSha = "b".repeat(40);
const identity = {
  schemaVersion: 1 as const,
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  requirementsVersion: "issue-17-v1",
};
const trusted = (
  expectedRole: AgentResponse["role"],
  expectedCommitSha?: string,
): TrustedResponseContext => ({
  ...identity,
  expectedRole,
  ...(expectedCommitSha === undefined ? {} : { expectedCommitSha }),
});
const evidence = (referenceId: string, withCommit = false) => ({
  ...identity,
  referenceId,
  kind: "REPOSITORY" as const,
  locator: "docs/architecture/relay-orchestrator-v2-design.md",
  ...(withCommit ? { commitSha } : {}),
});
const plannerEvidence = (referenceId: string) => ({
  ...evidence(referenceId),
  kind: "REQUIREMENTS" as const,
  locator: "https://github.com/putman44/Relay/issues/17",
});
const check = () => ({
  ...evidence("check-1", true),
  kind: "CHECK" as const,
  check: "typecheck",
  result: "PASSED" as const,
  environment: "local",
  configuration: "npm run typecheck",
});

const plannerReady = () => ({
  ...identity,
  role: "planner" as const,
  status: "READY" as const,
  plan: {
    summary: "Implement contracts",
    tasks: [
      {
        taskId: "task-1",
        summary: "Define responses",
        dependencies: [],
        fileScope: ["src/orchestration/contracts.ts"],
        complexity: "LOW" as const,
        risk: "LOW" as const,
        verificationRequirements: ["typecheck"],
      },
    ],
  },
  evidenceReferences: [plannerEvidence("requirements-1")],
});
const implementerCompleted = () => ({
  ...identity,
  role: "implementer" as const,
  status: "COMPLETED" as const,
  commitSha,
  changedFiles: ["src/orchestration/contracts.ts"],
  verificationEvidence: [check()],
});
const reviewerPassed = () => ({
  ...identity,
  role: "reviewer" as const,
  status: "PASSED" as const,
  commitSha,
  coverage: {
    filesExamined: ["src/orchestration/contracts.ts"],
    requirementsEvaluated: ["REL-046"],
    behaviorsEvaluated: ["reject stale attempts"],
    verificationChecks: [check()],
    limitations: [],
  },
  evidenceReferences: [evidence("review-1", true)],
});
const reviewerBlocked = () => ({
  ...identity,
  role: "reviewer" as const,
  status: "BLOCKED" as const,
  commitSha,
  coverage: {
    filesExamined: [],
    requirementsEvaluated: ["REL-041"],
    behaviorsEvaluated: [],
    verificationChecks: [],
    limitations: ["The required integration check could not be completed"],
  },
  reasons: ["INCOMPLETE_VERIFICATION" as const],
  findings: [
    {
      findingId: "finding-1",
      classification: "UNVERIFIED_TECHNICAL_CONCERN" as const,
      severity: "HIGH" as const,
      summary: "Coverage is incomplete",
      technicalEvidence: [evidence("finding-evidence-1", true)],
      recommendedAction: "Run the missing check",
    },
  ],
  evidenceReferences: [evidence("review-1", true)],
  recommendedNextActions: ["Investigate the missing check"],
});

test("accepts each role and status with required structure", () => {
  const responses = [
    plannerReady(),
    {
      ...identity,
      role: "planner",
      status: "BLOCKED",
      reason: "Requirements missing",
      evidenceReferences: [plannerEvidence("block-1")],
      recommendedNextAction: "Clarify scope",
    },
    implementerCompleted(),
    {
      ...identity,
      role: "implementer",
      status: "BLOCKED",
      reason: "Scope conflict",
      evidenceReferences: [evidence("block-2")],
      recommendedNextAction: "Replan",
    },
    reviewerPassed(),
    reviewerBlocked(),
  ];
  for (const response of responses)
    assert.equal(AgentResponseSchema.safeParse(response).success, true);
});

test("rejects missing fields, invalid status, malformed SHA, and extra authority claims", () => {
  const invalid = [
    { ...plannerReady(), plan: { summary: "No tasks" } },
    { ...plannerReady(), status: "APPROVED" },
    { ...implementerCompleted(), commitSha: "abc123" },
    { ...reviewerPassed(), status: "MERGE" },
    { ...reviewerPassed(), canMerge: true },
    { ...plannerReady(), schemaVersion: 2 },
    { ...reviewerBlocked(), findings: [] },
    { ...reviewerBlocked(), coverage: { ...reviewerBlocked().coverage, limitations: [] } },
    { ...reviewerBlocked(), coverage: undefined },
    {
      ...reviewerBlocked(),
      findings: [{ ...reviewerBlocked().findings[0], classification: "STYLE" }],
    },
    {
      ...reviewerBlocked(),
      findings: [{ ...reviewerBlocked().findings[0], technicalEvidence: [] }],
    },
    {
      ...implementerCompleted(),
      verificationEvidence: [{ ...check(), result: "UNKNOWN" }],
    },
    {
      ...implementerCompleted(),
      verificationEvidence: [{ ...check(), kind: "REPOSITORY" }],
    },
    {
      ...implementerCompleted(),
      verificationEvidence: [{ ...check(), locator: "" }],
    },
    {
      ...reviewerPassed(),
      coverage: { ...reviewerPassed().coverage, filesExamined: [] },
    },
  ];
  for (const response of invalid)
    assert.equal(AgentResponseSchema.safeParse(response).success, false);
});

test("rejects mismatched and stale execution identity against trusted state", () => {
  const mismatches = [
    [plannerReady(), { ...trusted("planner"), runId: "other-run" }],
    [plannerReady(), { ...trusted("planner"), taskId: "other-task" }],
    [plannerReady(), { ...trusted("planner"), attemptId: "attempt-2" }],
    [
      plannerReady(),
      { ...trusted("planner"), requirementsVersion: "issue-17-v2" },
    ],
    [plannerReady(), trusted("reviewer")],
  ] as const;
  for (const [response, context] of mismatches) {
    const parsed = AgentResponseSchema.parse(response);
    assert.equal(validateResponseContext(parsed, context).valid, false);
  }
});

test("rejects evidence from another execution or commit", () => {
  const stalePlanner = {
    ...plannerReady(),
    evidenceReferences: [{ ...plannerEvidence("old"), attemptId: "attempt-0" }],
  };
  const wrongImplementerCommit = {
    ...implementerCompleted(),
    verificationEvidence: [{ ...check(), commitSha: otherCommitSha }],
  };
  const wrongReviewFinding = {
    ...reviewerBlocked(),
    findings: [
      {
        ...reviewerBlocked().findings[0],
        technicalEvidence: [
          { ...evidence("old", true), requirementsVersion: "issue-17-v0" },
        ],
      },
    ],
  };
  for (const [response, context] of [
    [stalePlanner, trusted("planner")],
    [wrongImplementerCommit, trusted("implementer")],
    [wrongReviewFinding, trusted("reviewer", commitSha)],
  ] as const) {
    assert.equal(
      validateResponseContext(AgentResponseSchema.parse(response), context)
        .valid,
      false,
    );
  }
});

test("requires trusted reviewer commit and rejects a different reviewed commit", () => {
  const parsed = AgentResponseSchema.parse(reviewerPassed());
  assert.equal(
    validateResponseContext(parsed, trusted("reviewer")).valid,
    false,
  );
  assert.equal(
    validateResponseContext(parsed, trusted("reviewer", otherCommitSha)).valid,
    false,
  );
  assert.deepEqual(
    validateResponseContext(parsed, trusted("reviewer", commitSha)),
    { valid: true },
  );
});

test("accepts blocked review with explicit incomplete coverage", () => {
  const parsed = AgentResponseSchema.parse(reviewerBlocked());
  assert.equal(parsed.role, "reviewer");
  assert.deepEqual(validateResponseContext(parsed, trusted("reviewer", commitSha)), {
    valid: true,
  });
});

test("rejects mismatched commit in blocked reviewer coverage evidence", () => {
  const response = {
    ...reviewerBlocked(),
    coverage: {
      ...reviewerBlocked().coverage,
      verificationChecks: [{ ...check(), commitSha: otherCommitSha }],
    },
  };
  const result = validateResponseContext(
    AgentResponseSchema.parse(response),
    trusted("reviewer", commitSha),
  );
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.errors.join(" "), /evidence\[0\]\.commitSha/);
});

test("rejects implementer commit mismatch against trusted expected commit", () => {
  const result = validateResponseContext(
    AgentResponseSchema.parse(implementerCompleted()),
    trusted("implementer", otherCommitSha),
  );
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.errors.join(" "), /response\.commitSha/);
});

test("planner invocation identity can differ from generated internal task IDs", () => {
  const base = plannerReady();
  const task = base.plan.tasks[0]!;
  const response = {
    ...base,
    plan: {
      ...base.plan,
      tasks: [
        { ...task, taskId: "implementation-a" },
        { ...task, taskId: "implementation-b", dependencies: ["implementation-a"] },
      ],
    },
  };
  const parsed = AgentResponseSchema.parse(response);
  assert.equal(parsed.taskId, "task-1");
  assert.deepEqual(parsed.status === "READY" && parsed.role === "planner"
    ? parsed.plan.tasks.map((task) => task.taskId)
    : [], ["implementation-a", "implementation-b"]);
  assert.deepEqual(validateResponseContext(parsed, trusted("planner")), { valid: true });
});

test("accepts matching execution context without asserting authorization", () => {
  const cases = [
    [plannerReady(), trusted("planner")],
    [implementerCompleted(), trusted("implementer", commitSha)],
    [reviewerBlocked(), trusted("reviewer", commitSha)],
  ] as const;
  for (const [response, context] of cases) {
    assert.deepEqual(
      validateResponseContext(AgentResponseSchema.parse(response), context),
      { valid: true },
    );
  }
});
