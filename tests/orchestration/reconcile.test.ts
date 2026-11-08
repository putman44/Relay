import assert from "node:assert/strict";
import test from "node:test";
import { reconcileCheckpoint, type TrustedCurrentObservations } from "../../src/orchestration/reconcile.js";
import { validateRunCheckpoint, type RunCheckpoint } from "../../src/orchestration/checkpoint.js";
import { applyTaskTransition, createPendingTask, type TaskState } from "../../src/orchestration/state.js";

const head = "a".repeat(40);
const otherHead = "b".repeat(40);
const taskId = "task-a";
// Current identifiers are supplied by orchestrator context, independently of restored history.
const currentRunId = "run-1";
const currentWorkItemId = "work-8";
const identity = (id: string, attemptId: string) => ({
  schemaVersion: 1 as const, runId: "run-1", taskId: id, attemptId, requirementsVersion: "requirements-v1",
});

function verifiedState(): TaskState {
  let state = createPendingTask();
  for (const [to, kind] of [
    ["IMPLEMENTING", "DISPATCH_APPROVED"],
    ["VERIFYING", "IMPLEMENTATION_CONFIRMED"],
    ["PUBLISHING", "VERIFICATION_PASSED"],
    ["IN_REVIEW", "PUBLICATION_CONFIRMED"],
    ["VERIFIED", "REVIEW_PASSED"],
  ] as const) {
    const result = applyTaskTransition(state, { type: "ADVANCE", to, decision: { kind, evidenceReferences: [`recorded:${kind}`] } });
    if (!result.applied) throw new Error(result.reason);
    state = result.state;
  }
  return state;
}

function checkpoint(ids: readonly string[] = [taskId], states?: Readonly<Record<string, TaskState>>): RunCheckpoint {
  return {
    schemaVersion: 1,
    revision: 1,
    runId: "run-1",
    repository: { repositoryId: "example/repository", branch: "feature/example", observedHeadSha: head },
    workItemId: "work-8",
    authorizedRequirementsVersion: "requirements-v1",
    authorizationEvidenceReferences: ["recorded-approval"],
    taskGraph: ids.map((id) => ({ taskId: id, dependencies: [], fileScope: [`src/${id}.ts`], risk: "LOW" })),
    taskRecords: ids.map((id) => {
      const state = states?.[id] ?? verifiedState();
      return { taskId: id, state, ...(state.completedStages.length > 1 ? { recordedCommitSha: head } : {}) };
    }),
    executionRecords: ids.flatMap((id) => [
      { recordId: `impl-${id}`, role: "implementer" as const, identity: identity(id, "impl-1"), commitSha: head, evidenceReferences: [`recorded-impl-${id}`] },
      { recordId: `review-${id}`, role: "reviewer" as const, identity: identity(id, "review-1"), commitSha: head, evidenceReferences: [`recorded-review-${id}`] },
    ]),
  };
}

function observations(saved: RunCheckpoint): TrustedCurrentObservations {
  return {
    runId: currentRunId,
    workItemId: currentWorkItemId,
    repository: { repositoryId: "example/repository", branch: "feature/example", observedHeadSha: head },
    authorizedRequirementsVersion: "requirements-v1",
    authorizationEvidenceReferences: ["current-approval"],
    tasks: Object.fromEntries(saved.taskRecords.map((record) => {
      const id = record.taskId;
      return [id, {
        dependenciesValid: true,
        environmentAuthorized: true,
        blockerResolved: false,
        verifiedCommitEvidence: record.recordedCommitSha ? {
          executionRecordId: `impl-${id}`,
          identity: identity(id, "impl-1"),
          commitSha: head,
          evidenceReferences: [`current-commit-${id}`],
        } : undefined,
        completedStageEvidence: record.state.completedStages.map((completion) => {
          const review = completion.stage === "IN_REVIEW";
          return {
            stage: completion.stage,
            decision: completion.decision,
            valid: true,
            recordedEvidenceReferences: [...completion.evidenceReferences],
            evidenceReferences: [`current-${id}-${completion.stage}`],
            executionRecordId: `${review ? "review" : "impl"}-${id}`,
            identity: identity(id, review ? "review-1" : "impl-1"),
            ...(completion.stage === "PENDING" ? {} : { commitSha: head }),
          };
        }),
      }];
    })),
  };
}

test("fully valid checkpoint preserves every completed stage without repeating it", () => {
  const saved = checkpoint();
  const result = reconcileCheckpoint(saved, observations(saved));
  assert.equal(result.status, "RECONCILED");
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.tasks[0]?.reusableStages, ["PENDING", "IMPLEMENTING", "VERIFYING", "PUBLISHING", "IN_REVIEW"]);
  assert.equal(result.tasks[0]?.earliestStage, null);
  assert.equal(result.tasks[0]?.disposition, "RECORDED_COMPLETE");
  assert.equal(result.authorizesDispatch, false);
});

test("different current run ID stops every task before reusing recorded stages", () => {
  const saved = checkpoint([taskId, "task-b"]);
  const current = observations(saved);
  current.runId = "run-2";
  const result = reconcileCheckpoint(saved, current);
  assert.equal(result.status, "RECONCILED");
  assert.ok(result.reasons.some((reason) => reason.code === "RUN_ID_MISMATCH"));
  for (const task of result.tasks) {
    assert.equal(task.disposition, "STOP");
    assert.equal(task.earliestStage, "PENDING");
    assert.deepEqual(task.reusableStages, []);
  }
});

test("different current work-item ID stops every task before reusing recorded stages", () => {
  const saved = checkpoint([taskId, "task-b"]);
  const current = observations(saved);
  current.workItemId = "work-9";
  const result = reconcileCheckpoint(saved, current);
  assert.equal(result.status, "RECONCILED");
  assert.ok(result.reasons.some((reason) => reason.code === "WORK_ITEM_ID_MISMATCH"));
  for (const task of result.tasks) {
    assert.equal(task.disposition, "STOP");
    assert.equal(task.earliestStage, "PENDING");
    assert.deepEqual(task.reusableStages, []);
  }
});

test("missing or malformed current run and work-item identities fail closed", () => {
  const saved = checkpoint();
  for (const [field, value] of [
    ["runId", undefined], ["runId", "../run-1"], ["runId", ""],
    ["workItemId", undefined], ["workItemId", " work-8"], ["workItemId", "   "],
  ] as const) {
    const current: Record<string, unknown> = { ...observations(saved), [field]: value };
    const result = reconcileCheckpoint(saved, current);
    assert.equal(result.status, "INVALID_OBSERVATIONS", `${field}: ${String(value)}`);
    assert.deepEqual(result.tasks, []);
    assert.equal(result.authorizesDispatch, false);
    assert.ok(result.reasons.some((reason) => reason.code === "INVALID_OBSERVATIONS"));
  }
});

test("changed repository commit stops reuse until impact is assessed", () => {
  const saved = checkpoint();
  const current = observations(saved);
  current.repository.observedHeadSha = otherHead;
  const result = reconcileCheckpoint(saved, current);
  assert.equal(result.tasks[0]?.disposition, "STOP");
  assert.equal(result.tasks[0]?.earliestStage, "PENDING");
  assert.deepEqual(result.tasks[0]?.reusableStages, []);
  assert.ok(result.reasons.some((reason) => reason.code === "REPOSITORY_COMMIT_MISMATCH"));
});

test("changed requirements version stops reuse", () => {
  const saved = checkpoint();
  const current = observations(saved);
  current.authorizedRequirementsVersion = "requirements-v2";
  const result = reconcileCheckpoint(saved, current);
  assert.equal(result.tasks[0]?.disposition, "STOP");
  assert.ok(result.reasons.some((reason) => reason.code === "REQUIREMENTS_MISMATCH"));
});

test("missing or mismatched verified commit evidence keeps only the dispatch stage", () => {
  const saved = checkpoint();
  for (const proof of [undefined, { ...observations(saved).tasks[taskId]!.verifiedCommitEvidence!, commitSha: otherHead }]) {
    const current = observations(saved);
    current.tasks[taskId]!.verifiedCommitEvidence = proof;
    const result = reconcileCheckpoint(saved, current);
    assert.deepEqual(result.tasks[0]?.reusableStages, ["PENDING"]);
    assert.equal(result.tasks[0]?.earliestStage, "IMPLEMENTING");
    assert.equal(result.tasks[0]?.disposition, "REVALIDATION_REQUIRED");
    assert.ok(result.tasks[0]?.reasons.some((reason) => reason.code === "COMMIT_EVIDENCE_MISSING" || reason.code === "COMMIT_EVIDENCE_MISMATCH"));
  }
});

test("wrong run or execution identity cannot validate recorded stages", () => {
  const saved = checkpoint();
  for (const changedIdentity of [
    { ...identity(taskId, "impl-1"), runId: "wrong-run" },
    { ...identity(taskId, "other-attempt") },
  ]) {
    const current = observations(saved);
    current.tasks[taskId]!.completedStageEvidence[0]!.identity = changedIdentity;
    const result = reconcileCheckpoint(saved, current);
    assert.deepEqual(result.tasks[0]?.reusableStages, []);
    assert.equal(result.tasks[0]?.earliestStage, "PENDING");
    assert.ok(result.tasks[0]?.reasons.some((reason) => reason.code === "EXECUTION_IDENTITY_MISMATCH"));
  }
});

test("commit proof cannot be combined with stages from another execution attempt", () => {
  const base = checkpoint();
  const saved = {
    ...base,
    executionRecords: [
      ...base.executionRecords,
      { recordId: "impl-task-a-second", role: "implementer" as const,
        identity: identity(taskId, "impl-2"), commitSha: head, evidenceReferences: ["recorded-second-attempt"] },
    ],
  };
  const current = observations(saved);
  current.tasks[taskId]!.verifiedCommitEvidence = {
    executionRecordId: "impl-task-a-second", identity: identity(taskId, "impl-2"),
    commitSha: head, evidenceReferences: ["current-second-attempt"],
  };
  const result = reconcileCheckpoint(saved, current);
  assert.deepEqual(result.tasks[0]?.reusableStages, ["PENDING"]);
  assert.equal(result.tasks[0]?.earliestStage, "IMPLEMENTING");
  assert.ok(result.tasks[0]?.reasons.some((reason) => reason.code === "EXECUTION_IDENTITY_MISMATCH"));
});

test("earlier completed stages remain reusable when later evidence is invalid", () => {
  const saved = checkpoint();
  const current = observations(saved);
  current.tasks[taskId]!.completedStageEvidence[3]!.valid = false;
  const result = reconcileCheckpoint(saved, current);
  assert.deepEqual(result.tasks[0]?.reusableStages, ["PENDING", "IMPLEMENTING", "VERIFYING"]);
  assert.equal(result.tasks[0]?.earliestStage, "PUBLISHING");
  assert.ok(result.tasks[0]?.reasons.some((reason) => reason.code === "STAGE_EVIDENCE_INVALID"));
});

test("BLOCKED task stays blocked even when the blocker is independently resolved", () => {
  const base = verifiedState();
  const state = { ...base, status: "IN_REVIEW" as const, completedStages: base.completedStages.slice(0, 4) };
  const block = applyTaskTransition(state, {
    type: "BLOCK", reason: { code: "REVIEW", detail: "Review interrupted" },
    evidenceReferences: ["block-1"], authorizedNextAction: "Reconcile review",
  });
  assert.equal(block.applied, true);
  if (!block.applied) return;
  const saved = checkpoint([taskId], { [taskId]: block.state });
  const current = observations(saved);
  const unresolved = reconcileCheckpoint(saved, current);
  assert.equal(unresolved.tasks[0]?.disposition, "BLOCKED");
  assert.ok(unresolved.tasks[0]?.reasons.some((reason) => reason.code === "BLOCKER_UNRESOLVED"));
  current.tasks[taskId]!.blockerResolved = true;
  const result = reconcileCheckpoint(saved, current);
  assert.equal(result.tasks[0]?.disposition, "BLOCKED");
  assert.equal(result.tasks[0]?.earliestStage, "IN_REVIEW");
  assert.ok(result.tasks[0]?.reasons.some((reason) => reason.code === "SEPARATE_RESUME_REQUIRED"));
  assert.equal(saved.taskRecords[0]?.state.status, "BLOCKED");
});

test("incomplete task identifies its next stage without granting dispatch authority", () => {
  const state = createPendingTask();
  const saved = checkpoint([taskId], { [taskId]: state });
  const result = reconcileCheckpoint(saved, observations(saved));
  assert.equal(result.tasks[0]?.disposition, "INCOMPLETE");
  assert.equal(result.tasks[0]?.earliestStage, "PENDING");
  assert.equal(result.authorizesDispatch, false);
});

test("missing environment authorization prevents safe resumption", () => {
  const saved = checkpoint();
  const current = observations(saved);
  current.tasks[taskId]!.environmentAuthorized = false;
  const result = reconcileCheckpoint(saved, current);
  assert.equal(result.tasks[0]?.disposition, "STOP");
  assert.ok(result.tasks[0]?.reasons.some((reason) => reason.code === "ENVIRONMENT_UNAUTHORIZED"));
});

test("multiple tasks reconcile independently without borrowing authorization", () => {
  const saved = checkpoint([taskId, "task-b"]);
  const current = observations(saved);
  current.tasks["task-b"]!.dependenciesValid = false;
  const result = reconcileCheckpoint(saved, current);
  assert.equal(result.tasks[0]?.disposition, "RECORDED_COMPLETE");
  assert.equal(result.tasks[1]?.disposition, "STOP");
  assert.ok(result.tasks[1]?.reasons.some((reason) => reason.code === "DEPENDENCIES_INVALID"));
  delete current.tasks["task-b"];
  const missing = reconcileCheckpoint(saved, current);
  assert.equal(missing.tasks[1]?.disposition, "STOP");
  assert.ok(missing.tasks[1]?.reasons.some((reason) => reason.code === "TASK_OBSERVATION_MISSING"));
});

test("one task's execution evidence cannot validate another task", () => {
  const saved = checkpoint([taskId, "task-b"]);
  const current = observations(saved);
  current.tasks["task-b"]!.completedStageEvidence[0]!.identity = identity(taskId, "impl-1");
  const result = reconcileCheckpoint(saved, current);
  assert.equal(result.tasks[0]?.disposition, "RECORDED_COMPLETE");
  assert.equal(result.tasks[1]?.earliestStage, "PENDING");
  assert.ok(result.tasks[1]?.reasons.some((reason) => reason.code === "EXECUTION_IDENTITY_MISMATCH"));
});

test("missing current authorization evidence and malformed history fail closed", () => {
  const saved = checkpoint();
  const current = observations(saved);
  current.authorizationEvidenceReferences = [];
  assert.equal(reconcileCheckpoint(saved, current).status, "INVALID_OBSERVATIONS");
  assert.equal(reconcileCheckpoint({ ...saved, taskRecords: [] }, observations(saved)).status, "INVALID_CHECKPOINT");
});

test("reconciliation is synchronous, read-only, and never advances task state", () => {
  const saved = checkpoint();
  const current = observations(saved);
  const before = JSON.stringify({ saved, current });
  assert.equal(validateRunCheckpoint(saved).valid, true);
  const result = reconcileCheckpoint(saved, current);
  assert.equal(result.authorizesDispatch, false);
  assert.equal(JSON.stringify({ saved, current }), before);
  assert.equal(saved.taskRecords[0]?.state.status, "VERIFIED");
});
