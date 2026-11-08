import assert from "node:assert/strict";
import test from "node:test";
import { recoverTask, type TrustedTaskRecoveryEvidence } from "../../src/orchestration/recovery.js";
import type { RunCheckpoint } from "../../src/orchestration/checkpoint.js";
import type { TrustedCurrentObservations } from "../../src/orchestration/reconcile.js";
import { applyTaskTransition, createPendingTask, type StageDecisionKind, type TaskStage, type TaskState } from "../../src/orchestration/state.js";

const head = "a".repeat(40);
const other = "b".repeat(40);
const identity = (taskId: string, attemptId = "attempt-1") => ({
  schemaVersion: 1 as const, runId: "run-1", taskId, attemptId, requirementsVersion: "requirements-v1",
});

function state(status: "PENDING" | "IN_REVIEW" | "VERIFIED" | "BLOCKED"): TaskState {
  let current = createPendingTask();
  if (status === "PENDING") return current;
  const steps: readonly (readonly [TaskStage, StageDecisionKind])[] = [
    ["IMPLEMENTING", "DISPATCH_APPROVED"], ["VERIFYING", "IMPLEMENTATION_CONFIRMED"],
    ["PUBLISHING", "VERIFICATION_PASSED"], ["IN_REVIEW", "PUBLICATION_CONFIRMED"],
    ...(status === "VERIFIED" ? [["VERIFIED", "REVIEW_PASSED"] as const] : []),
  ];
  for (const [to, kind] of steps) {
    const next = applyTaskTransition(current, { type: "ADVANCE", to, decision: { kind, evidenceReferences: [`recorded-${kind}`] } });
    if (!next.applied) throw new Error(next.reason);
    current = next.state;
  }
  if (status === "BLOCKED") {
    const blocked = applyTaskTransition(current, { type: "BLOCK",
      reason: { code: "REVIEW", detail: "Review interrupted" },
      evidenceReferences: ["recorded-block"], authorizedNextAction: "Investigate review",
    });
    if (!blocked.applied) throw new Error(blocked.reason);
    return blocked.state;
  }
  return current;
}

function fixture(status: "PENDING" | "IN_REVIEW" | "VERIFIED" | "BLOCKED" = "BLOCKED", ids = ["task-a"]) {
  const checkpoint: RunCheckpoint = {
    schemaVersion: 1, revision: 1, runId: "run-1", workItemId: "work-9",
    repository: { repositoryId: "owner/repo", branch: "feature/recovery", observedHeadSha: head },
    authorizedRequirementsVersion: "requirements-v1", authorizationEvidenceReferences: ["recorded-approval"],
    taskGraph: ids.map((taskId) => ({ taskId, dependencies: [], fileScope: [`src/${taskId}.ts`], risk: "LOW" as const })),
    taskRecords: ids.map((taskId) => ({ taskId, state: state(status), ...(status === "PENDING" ? {} : { recordedCommitSha: head }) })),
    executionRecords: ids.flatMap((taskId) => [
      { recordId: `impl-${taskId}`, role: "implementer" as const, identity: identity(taskId), commitSha: head, evidenceReferences: ["recorded-execution"] },
      { recordId: `review-${taskId}`, role: "reviewer" as const, identity: identity(taskId, "review-1"), commitSha: head, evidenceReferences: ["recorded-review"] },
    ]),
  };
  const observations: TrustedCurrentObservations = {
    runId: "run-1", workItemId: "work-9",
    repository: { repositoryId: "owner/repo", branch: "feature/recovery", observedHeadSha: head },
    authorizedRequirementsVersion: "requirements-v1", authorizationEvidenceReferences: ["current-approval"],
    tasks: Object.fromEntries(checkpoint.taskRecords.map((record) => [record.taskId, {
      dependenciesValid: true, environmentAuthorized: true, blockerResolved: status === "BLOCKED",
      verifiedCommitEvidence: record.recordedCommitSha ? {
        executionRecordId: `impl-${record.taskId}`, identity: identity(record.taskId),
        commitSha: head, evidenceReferences: ["current-commit"],
      } : undefined,
      completedStageEvidence: record.state.completedStages.map((completion) => ({
        stage: completion.stage, decision: completion.decision, valid: true,
        recordedEvidenceReferences: [...completion.evidenceReferences],
        evidenceReferences: [`current-${record.taskId}-${completion.stage}`],
        executionRecordId: `${completion.stage === "IN_REVIEW" ? "review" : "impl"}-${record.taskId}`,
        identity: identity(record.taskId, completion.stage === "IN_REVIEW" ? "review-1" : "attempt-1"),
        ...(completion.stage === "PENDING" ? {} : { commitSha: head }),
      })),
    }])),
  };
  const record = checkpoint.taskRecords[0]!;
  const trusted: TrustedTaskRecoveryEvidence = {
    runId: "run-1", workItemId: "work-9", taskId: "task-a", repositoryId: "owner/repo",
    branch: "feature/recovery", headSha: head, requirementsVersion: "requirements-v1",
    executionRecordId: "impl-task-a", executionIdentity: identity("task-a"), commitSha: head,
    blockIndex: 0, recordedBlockEvidenceReferences: ["recorded-block"],
    blockerResolutionEvidenceReferences: ["current-resolution"],
    repositoryEvidenceReferences: ["current-repository"],
    requirementsEvidenceReferences: ["current-requirements"],
    dependencyEvidenceReferences: ["current-dependencies"],
    environmentEvidenceReferences: ["current-environment"],
    decision: {
      blockerResolved: true, repositoryValid: true, requirementsValid: true,
      dependenciesValid: true, environmentAuthorized: true,
      evidenceReferences: ["current-recovery-decision"],
      stageRevalidations: record.state.completedStages.map((completion) => ({
        stage: completion.stage, valid: true,
        evidenceReferences: [`current-task-a-${completion.stage}`],
      })),
    },
  };
  return { checkpoint, observations, trusted };
}

test("verified task needs no recovery; incomplete task identifies next stage without dispatch", () => {
  const verified = fixture("VERIFIED");
  assert.equal(recoverTask(verified.checkpoint, verified.observations, "task-a").decision, "NO_RECOVERY_NEEDED");
  const pending = fixture("PENDING");
  const result = recoverTask(pending.checkpoint, pending.observations, "task-a");
  assert.equal(result.decision, "CONTINUE_INCOMPLETE");
  assert.equal(result.nextStage, "PENDING");
  assert.equal(result.authorizesDispatch, false);
  assert.equal(result.state, undefined);
});

test("unresolved blocker stays blocked; missing separate resolution evidence prevents RESUME", () => {
  const { checkpoint, observations, trusted } = fixture();
  observations.tasks["task-a"]!.blockerResolved = false;
  assert.equal(recoverTask(checkpoint, observations, "task-a", trusted).decision, "BLOCKER_ACTIVE");
  observations.tasks["task-a"]!.blockerResolved = true;
  assert.equal(recoverTask(checkpoint, observations, "task-a").decision, "REVALIDATION_REQUIRED");
  const missing = { ...trusted, blockerResolutionEvidenceReferences: [] };
  assert.equal(recoverTask(checkpoint, observations, "task-a", missing).decision, "STOP");
});

test("resolved blocker with independently supplied evidence uses existing RESUME and preserves histories", () => {
  const { checkpoint, observations, trusted } = fixture();
  const before = structuredClone(checkpoint);
  const currentBefore = structuredClone(observations);
  const result = recoverTask(checkpoint, observations, "task-a", trusted);
  assert.equal(result.decision, "RESUME_ELIGIBLE");
  assert.equal(result.nextStage, "IN_REVIEW");
  assert.equal(result.authorizesDispatch, false);
  assert.equal(result.state?.status, "IN_REVIEW");
  assert.deepEqual(result.state?.completedStages, checkpoint.taskRecords[0]?.state.completedStages);
  assert.deepEqual(result.state?.blockHistory, checkpoint.taskRecords[0]?.state.blockHistory);
  assert.equal(result.state?.recoveryHistory.length, 1);
  assert.deepEqual(checkpoint, before);
  assert.deepEqual(observations, currentBefore);
  assert.equal(recoverTask(checkpoint, observations, "task-a", trusted).state?.recoveryHistory.length, 1);
  const updated = { ...checkpoint, taskRecords: [{ ...checkpoint.taskRecords[0]!, state: result.state! }] };
  assert.equal(recoverTask(updated, observations, "task-a", trusted).decision, "CONTINUE_INCOMPLETE");
});

test("a pre-execution PENDING blocker resumes only with separate trusted evidence", () => {
  const base = fixture("PENDING");
  const blocked = applyTaskTransition(base.checkpoint.taskRecords[0]!.state, {
    type: "BLOCK", reason: { code: "ENVIRONMENT", detail: "Local service unavailable before dispatch" },
    evidenceReferences: ["recorded-block"], authorizedNextAction: "Revalidate environment",
  });
  assert.equal(blocked.applied, true);
  if (!blocked.applied) return;
  assert.equal(blocked.state.blockHistory[0]?.lastValidStage, "PENDING");
  const checkpoint: RunCheckpoint = {
    ...base.checkpoint, executionRecords: [],
    taskRecords: [{ taskId: "task-a", state: blocked.state }],
  };
  const observations = base.observations;
  observations.tasks["task-a"]!.blockerResolved = true;
  const trusted = { ...base.trusted };
  delete trusted.executionRecordId;
  delete trusted.executionIdentity;
  delete trusted.commitSha;
  const original = structuredClone(checkpoint);
  assert.equal(recoverTask(checkpoint, observations, "task-a").decision, "REVALIDATION_REQUIRED");
  const resumed = recoverTask(checkpoint, observations, "task-a", trusted);
  assert.equal(resumed.decision, "RESUME_ELIGIBLE");
  assert.equal(resumed.state?.status, "PENDING");
  assert.equal(resumed.state?.completedStages.length, 0);
  assert.equal(resumed.state?.recoveryHistory.length, 1);
  assert.equal(resumed.authorizesDispatch, false);
  assert.deepEqual(checkpoint, original);

  assert.equal(recoverTask(checkpoint, observations, "task-a", {
    ...trusted, blockerResolutionEvidenceReferences: [],
  }).decision, "STOP");
  assert.equal(recoverTask(checkpoint, observations, "task-a", {
    ...trusted, environmentEvidenceReferences: [],
  }).decision, "STOP");
  assert.equal(recoverTask(checkpoint, observations, "task-a", {
    ...trusted, decision: { ...trusted.decision, requirementsValid: false },
  }).decision, "REVALIDATION_REQUIRED");
  const unauthorized = structuredClone(observations);
  unauthorized.tasks["task-a"]!.environmentAuthorized = false;
  assert.equal(recoverTask(checkpoint, unauthorized, "task-a", trusted).decision, "STOP");
  assert.equal(recoverTask(checkpoint, observations, "task-a", {
    ...trusted, executionRecordId: "invented-execution",
  }).decision, "STOP");
  assert.equal(recoverTask(checkpoint, observations, "task-a", {
    ...trusted, commitSha: head,
  }).decision, "STOP");
  const withExecution = { ...checkpoint, executionRecords: base.checkpoint.executionRecords };
  assert.equal(recoverTask(withExecution, observations, "task-a", trusted).decision, "STOP");
});

test("stale repository or requirements evidence stops recovery", () => {
  for (const field of ["repository", "requirements"] as const) {
    const { checkpoint, observations, trusted } = fixture();
    if (field === "repository") observations.repository.observedHeadSha = other;
    else observations.authorizedRequirementsVersion = "requirements-v2";
    const result = recoverTask(checkpoint, observations, "task-a", trusted);
    assert.equal(result.decision, "STOP");
    assert.equal(result.state, undefined);
  }
});

test("invalidated completed stages never clear a blocker", () => {
  const { checkpoint, observations, trusted } = fixture();
  observations.tasks["task-a"]!.completedStageEvidence[2]!.valid = false;
  const result = recoverTask(checkpoint, observations, "task-a", trusted);
  assert.equal(result.decision, "REVALIDATION_REQUIRED");
  assert.equal(result.nextStage, "VERIFYING");
  assert.equal(result.state, undefined);
  assert.equal(checkpoint.taskRecords[0]?.state.status, "BLOCKED");
});

test("wrong task, run, work item, attempt, commit, and blocker proof are rejected", () => {
  const cases: ((value: TrustedTaskRecoveryEvidence) => TrustedTaskRecoveryEvidence)[] = [
    (value) => ({ ...value, taskId: "task-b" }),
    (value) => ({ ...value, runId: "run-2" }),
    (value) => ({ ...value, workItemId: "work-10" }),
    (value) => ({ ...value, executionIdentity: identity("task-a", "attempt-2") }),
    (value) => ({ ...value, commitSha: other }),
    (value) => ({ ...value, blockIndex: 1 }),
    (value) => ({ ...value, recordedBlockEvidenceReferences: ["old-block"] }),
  ];
  for (const change of cases) {
    const { checkpoint, observations, trusted } = fixture();
    assert.equal(recoverTask(checkpoint, observations, "task-a", change(trusted)).decision, "STOP");
  }
});

test("incomplete and conflicting proof cannot pass; another task is untouched", () => {
  const { checkpoint, observations, trusted } = fixture("BLOCKED", ["task-a", "task-b"]);
  const before = structuredClone(checkpoint.taskRecords[1]);
  const conflict = { ...trusted, decision: { ...trusted.decision,
    stageRevalidations: trusted.decision.stageRevalidations.map((item, index) =>
      index === 1 ? { ...item, evidenceReferences: ["unrelated-stage"] } : item),
  } };
  assert.equal(recoverTask(checkpoint, observations, "task-a", conflict).decision, "REVALIDATION_REQUIRED");
  const result = recoverTask(checkpoint, observations, "task-a", trusted);
  assert.equal(result.decision, "RESUME_ELIGIBLE");
  assert.deepEqual(checkpoint.taskRecords[1], before);
  assert.equal(recoverTask(checkpoint, observations, "task-b", trusted).decision, "STOP");
});
