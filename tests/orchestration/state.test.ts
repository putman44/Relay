import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTaskTransition,
  createPendingTask,
  evaluateTaskTransition,
  type StageDecisionKind,
  type TaskStage,
  type TaskState,
  type TrustedRecoveryDecision,
} from "../../src/orchestration/state.js";

const gate = (kind: StageDecisionKind) => ({
  kind,
  evidenceReferences: [`orchestrator:${kind}`],
});

function advance(state: TaskState, to: TaskStage, kind: StageDecisionKind): TaskState {
  const result = applyTaskTransition(state, { type: "ADVANCE", to, decision: gate(kind) });
  if (!result.applied) throw new Error(result.reason);
  assert.equal(result.applied, true);
  return result.state;
}

function throughPublishing(): TaskState {
  let state = createPendingTask();
  state = advance(state, "IMPLEMENTING", "DISPATCH_APPROVED");
  state = advance(state, "VERIFYING", "IMPLEMENTATION_CONFIRMED");
  return advance(state, "PUBLISHING", "VERIFICATION_PASSED");
}

function block(state: TaskState): TaskState {
  const result = applyTaskTransition(state, {
    type: "BLOCK",
    reason: { code: "EXTERNAL_ACTION", detail: "Publication outcome is unknown" },
    evidenceReferences: ["remote-check-1"],
    authorizedNextAction: "Reconcile the remote branch",
  });
  if (!result.applied) throw new Error(result.reason);
  assert.equal(result.applied, true);
  return result.state;
}

function recovery(state: TaskState): TrustedRecoveryDecision {
  return {
    blockerResolved: true,
    requirementsValid: true,
    repositoryValid: true,
    dependenciesValid: true,
    environmentAuthorized: true,
    evidenceReferences: ["recovery-check-1"],
    stageRevalidations: state.completedStages.map((record) => ({
      stage: record.stage,
      valid: true,
      evidenceReferences: [`revalidated:${record.stage}`],
    })),
  };
}

test("advances through every mandatory stage using the matching trusted decision", () => {
  let state = throughPublishing();
  state = advance(state, "IN_REVIEW", "PUBLICATION_CONFIRMED");
  state = advance(state, "VERIFIED", "REVIEW_PASSED");
  assert.equal(state.status, "VERIFIED");
  assert.deepEqual(
    state.completedStages.map((record) => record.stage),
    ["PENDING", "IMPLEMENTING", "VERIFYING", "PUBLISHING", "IN_REVIEW"],
  );
  assert.deepEqual(
    state.completedStages.map((record) => record.evidenceReferences[0]),
    [
      "orchestrator:DISPATCH_APPROVED",
      "orchestrator:IMPLEMENTATION_CONFIRMED",
      "orchestrator:VERIFICATION_PASSED",
      "orchestrator:PUBLICATION_CONFIRMED",
      "orchestrator:REVIEW_PASSED",
    ],
  );
});

test("rejects inconsistent active-stage histories before advancing", () => {
  const validReview = advance(throughPublishing(), "IN_REVIEW", "PUBLICATION_CONFIRMED");
  const inconsistentStates: TaskState[] = [
    { ...validReview, completedStages: [] },
    { ...validReview, completedStages: validReview.completedStages.slice(0, -1) },
    { ...validReview, completedStages: [
      ...validReview.completedStages.slice(0, -1),
      validReview.completedStages[1]!,
    ] },
    { ...validReview, completedStages: validReview.completedStages.map((record, index) =>
      index === 2 ? { ...record, decision: "REVIEW_PASSED" } : record) },
  ];
  const event = { type: "ADVANCE" as const, to: "VERIFIED" as const, decision: gate("REVIEW_PASSED") };
  for (const state of inconsistentStates) {
    assert.equal(evaluateTaskTransition(state, event).permitted, false);
    assert.equal(applyTaskTransition(state, event).applied, false);
  }
  assert.equal(advance(validReview, "VERIFIED", "REVIEW_PASSED").status, "VERIFIED");
});

test("rejects skipped stages and missing or incorrect gate decisions", () => {
  const state = createPendingTask();
  const events = [
    { type: "ADVANCE" as const, to: "VERIFYING" as const, decision: gate("DISPATCH_APPROVED") },
    { type: "ADVANCE" as const, to: "IMPLEMENTING" as const, decision: gate("REVIEW_PASSED") },
    { type: "ADVANCE" as const, to: "IMPLEMENTING" as const, decision: { kind: "DISPATCH_APPROVED" as const, evidenceReferences: [] } },
  ];
  for (const event of events) {
    assert.equal(evaluateTaskTransition(state, event).permitted, false);
    assert.equal(applyTaskTransition(state, event).applied, false);
  }
  assert.deepEqual(state, createPendingTask());
});

test("blocking preserves the last stage, completed evidence, reason and recovery action", () => {
  const before = throughPublishing();
  const blocked = block(before);
  assert.equal(blocked.status, "BLOCKED");
  assert.deepEqual(blocked.completedStages, before.completedStages);
  assert.deepEqual(blocked.blockHistory.at(-1), {
    lastValidStage: "PUBLISHING",
    reason: { code: "EXTERNAL_ACTION", detail: "Publication outcome is unknown" },
    evidenceReferences: ["remote-check-1"],
    authorizedNextAction: "Reconcile the remote branch",
  });
  assert.equal(before.status, "PUBLISHING");
  assert.equal(applyTaskTransition(blocked, {
    type: "ADVANCE",
    to: "IN_REVIEW",
    decision: gate("PUBLICATION_CONFIRMED"),
  }).applied, false);
});

test("resumes the blocked stage after revalidating every completed stage", () => {
  const blocked = block(throughPublishing());
  const result = applyTaskTransition(blocked, { type: "RESUME", decision: recovery(blocked) });
  assert.equal(result.applied, true);
  if (!result.applied) return;
  assert.equal(result.state.status, "PUBLISHING");
  assert.deepEqual(result.state.completedStages, blocked.completedStages);
  assert.deepEqual(result.state.blockHistory, blocked.blockHistory);
  assert.equal(result.state.recoveryHistory.length, 1);
  assert.equal(result.state.invalidatedStages.length, 0);
  assert.equal(blocked.status, "BLOCKED");
});

test("invalidated evidence moves to history and recovery resumes at earliest invalid stage", () => {
  const blocked = block(advance(throughPublishing(), "IN_REVIEW", "PUBLICATION_CONFIRMED"));
  const decision = recovery(blocked);
  decision.stageRevalidations = decision.stageRevalidations.map((item) => ({
    ...item,
    valid: item.stage !== "IMPLEMENTING",
  }));
  const result = applyTaskTransition(blocked, { type: "RESUME", decision });
  assert.equal(result.applied, true);
  if (!result.applied) return;
  assert.equal(result.state.status, "IMPLEMENTING");
  assert.deepEqual(result.state.completedStages.map((item) => item.stage), ["PENDING"]);
  assert.deepEqual(result.state.invalidatedStages.map((item) => item.stage), [
    "IMPLEMENTING", "VERIFYING", "PUBLISHING",
  ]);
  assert.deepEqual(result.state.invalidatedStages[0]?.evidenceReferences, [
    "orchestrator:IMPLEMENTATION_CONFIRMED",
  ]);
  assert.equal(blocked.completedStages.length, 4);
  assert.equal(result.state.recoveryHistory[0]?.resumedStage, "IMPLEMENTING");
});

test("recovered task with invalidated history passes the mandatory stages again", () => {
  const blocked = block(advance(throughPublishing(), "IN_REVIEW", "PUBLICATION_CONFIRMED"));
  const decision = recovery(blocked);
  decision.stageRevalidations = decision.stageRevalidations.map((item) => ({
    ...item,
    valid: item.stage !== "IMPLEMENTING",
  }));
  const resumed = applyTaskTransition(blocked, { type: "RESUME", decision });
  assert.equal(resumed.applied, true);
  if (!resumed.applied) return;
  let state = advance(resumed.state, "VERIFYING", "IMPLEMENTATION_CONFIRMED");
  state = advance(state, "PUBLISHING", "VERIFICATION_PASSED");
  state = advance(state, "IN_REVIEW", "PUBLICATION_CONFIRMED");
  state = advance(state, "VERIFIED", "REVIEW_PASSED");
  assert.equal(state.status, "VERIFIED");
  assert.deepEqual(state.completedStages.map((item) => item.stage), [
    "PENDING", "IMPLEMENTING", "VERIFYING", "PUBLISHING", "IN_REVIEW",
  ]);
  assert.deepEqual(state.invalidatedStages.map((item) => item.stage), [
    "IMPLEMENTING", "VERIFYING", "PUBLISHING",
  ]);
});

test("rejects recovery without resolved blocker or complete revalidation", () => {
  const blocked = block(throughPublishing());
  const base = recovery(blocked);
  const invalid = [
    { ...base, blockerResolved: false },
    { ...base, requirementsValid: false },
    { ...base, repositoryValid: false },
    { ...base, dependenciesValid: false },
    { ...base, environmentAuthorized: false },
    { ...base, evidenceReferences: [] },
    { ...base, stageRevalidations: base.stageRevalidations.slice(0, -1) },
    { ...base, stageRevalidations: [...base.stageRevalidations].reverse() },
    { ...base, stageRevalidations: base.stageRevalidations.map((item) => ({ ...item, evidenceReferences: [] })) },
  ];
  for (const decision of invalid) {
    assert.equal(applyTaskTransition(blocked, { type: "RESUME", decision }).applied, false);
  }
  assert.equal(applyTaskTransition(createPendingTask(), { type: "RESUME", decision: base }).applied, false);
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.recoveryHistory.length, 0);
});

test("rejects incomplete block records and terminal transitions", () => {
  const pending = createPendingTask();
  assert.equal(applyTaskTransition(pending, {
    type: "BLOCK",
    reason: { code: "EVIDENCE", detail: "" },
    evidenceReferences: ["proof"],
    authorizedNextAction: "Investigate",
  }).applied, false);
  assert.equal(applyTaskTransition(pending, {
    type: "BLOCK",
    reason: { code: "EVIDENCE", detail: "Missing check" },
    evidenceReferences: [],
    authorizedNextAction: "Investigate",
  }).applied, false);
  const verified = advance(advance(throughPublishing(), "IN_REVIEW", "PUBLICATION_CONFIRMED"), "VERIFIED", "REVIEW_PASSED");
  assert.equal(applyTaskTransition(verified, {
    type: "BLOCK",
    reason: { code: "REVIEW", detail: "Late concern" },
    evidenceReferences: ["late"],
    authorizedNextAction: "Investigate",
  }).applied, false);
});
