import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { FileCheckpointStore } from "../../src/orchestration/checkpoint-store.js";
import { validateRunCheckpoint, type RunCheckpoint } from "../../src/orchestration/checkpoint.js";
import { evaluateDispatchEligibility } from "../../src/orchestration/policy.js";
import {
  applyTaskTransition,
  createPendingTask,
  type StageDecisionKind,
  type TaskStage,
  type TaskState,
} from "../../src/orchestration/state.js";

const sha = "a".repeat(40);
const task = { taskId: "task-a", dependencies: [], fileScope: ["src/a.ts"], risk: "LOW" as const };
const plannerIdentity = {
  schemaVersion: 1 as const,
  runId: "run-1",
  taskId: "planner-invocation",
  attemptId: "plan-1",
  requirementsVersion: "requirements-v1",
};

async function tempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "relay-checkpoint-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function checkpoint(state: TaskState = createPendingTask(), revision = 1): RunCheckpoint {
  return {
    schemaVersion: 1,
    revision,
    runId: "run-1",
    repository: { repositoryId: "example/repository", branch: "feature/example", observedHeadSha: sha },
    workItemId: "work-item-24",
    authorizedRequirementsVersion: "requirements-v1",
    authorizationEvidenceReferences: ["approval-record-1"],
    taskGraph: [task],
    taskRecords: [{ taskId: task.taskId, state, ...(state.status === "PENDING" || state.status === "IMPLEMENTING"
      ? {} : { recordedCommitSha: sha }) }],
    executionRecords: [{
      recordId: "execution-plan-1",
      role: "planner",
      identity: plannerIdentity,
      evidenceReferences: ["plan-record-1"],
    }],
  };
}

function advance(state: TaskState, to: TaskStage, kind: StageDecisionKind): TaskState {
  const transition = applyTaskTransition(state, {
    type: "ADVANCE",
    to,
    decision: { kind, evidenceReferences: [`trusted:${kind}`] },
  });
  if (!transition.applied) throw new Error(transition.reason);
  return transition.state;
}

function verifiedState(): TaskState {
  let state = createPendingTask();
  state = advance(state, "IMPLEMENTING", "DISPATCH_APPROVED");
  state = advance(state, "VERIFYING", "IMPLEMENTATION_CONFIRMED");
  state = advance(state, "PUBLISHING", "VERIFICATION_PASSED");
  state = advance(state, "IN_REVIEW", "PUBLICATION_CONFIRMED");
  return advance(state, "VERIFIED", "REVIEW_PASSED");
}

function verifiedCheckpoint(): RunCheckpoint {
  const base = checkpoint(verifiedState());
  return {
    ...base,
    executionRecords: [
      ...base.executionRecords,
      {
        recordId: "execution-impl-1",
        role: "implementer",
        identity: { ...plannerIdentity, taskId: task.taskId, attemptId: "impl-1" },
        commitSha: sha,
        evidenceReferences: ["commit-check-1"],
      },
      {
        recordId: "execution-review-1",
        role: "reviewer",
        identity: { ...plannerIdentity, taskId: task.taskId, attemptId: "review-1" },
        commitSha: sha,
        evidenceReferences: ["review-check-1"],
      },
    ],
  };
}

async function writeUnchecked(directory: string, value: unknown): Promise<void> {
  await writeFile(join(directory, "run-1.json"), JSON.stringify(value));
}

test("saves and restores a checkpoint using a fresh store instance", async (t) => {
  const directory = await tempDirectory(t);
  const saved = await new FileCheckpointStore(directory).save(checkpoint());
  assert.deepEqual(saved, { status: "SAVED", revision: 1 });
  const restored = await new FileCheckpointStore(directory).load("run-1");
  assert.equal(restored.status, "RESTORED");
  if (restored.status === "RESTORED") {
    assert.equal(restored.requiresReconciliation, true);
    assert.deepEqual(restored.checkpoint, checkpoint());
  }
});

test("preserves completed-stage history, execution identities, commits, and evidence", async (t) => {
  const directory = await tempDirectory(t);
  const original = verifiedCheckpoint();
  assert.equal((await new FileCheckpointStore(directory).save(original)).status, "SAVED");
  const restored = await new FileCheckpointStore(directory).load("run-1");
  assert.equal(restored.status, "RESTORED");
  if (restored.status === "RESTORED") {
    assert.deepEqual(restored.checkpoint.taskRecords[0]?.state.completedStages, original.taskRecords[0]?.state.completedStages);
    assert.deepEqual(restored.checkpoint.executionRecords, original.executionRecords);
    assert.equal(restored.checkpoint.taskRecords[0]?.recordedCommitSha, sha);
  }
});

test("preserves blocked and recovery history without resuming the task", async (t) => {
  const directory = await tempDirectory(t);
  let state = advance(createPendingTask(), "IMPLEMENTING", "DISPATCH_APPROVED");
  state = advance(state, "VERIFYING", "IMPLEMENTATION_CONFIRMED");
  const firstBlock = applyTaskTransition(state, {
    type: "BLOCK",
    reason: { code: "EVIDENCE", detail: "Verification interrupted" },
    evidenceReferences: ["block-1"],
    authorizedNextAction: "Reconcile verification",
  });
  assert.equal(firstBlock.applied, true);
  if (!firstBlock.applied) return;
  const resumed = applyTaskTransition(firstBlock.state, {
    type: "RESUME",
    decision: {
      blockerResolved: true,
      requirementsValid: true,
      repositoryValid: true,
      dependenciesValid: true,
      environmentAuthorized: true,
      evidenceReferences: ["recovery-1"],
      stageRevalidations: firstBlock.state.completedStages.map((item) => ({
        stage: item.stage, valid: true, evidenceReferences: [`revalidated:${item.stage}`],
      })),
    },
  });
  assert.equal(resumed.applied, true);
  if (!resumed.applied) return;
  const secondBlock = applyTaskTransition(resumed.state, {
    type: "BLOCK",
    reason: { code: "REVIEW", detail: "Further evidence required" },
    evidenceReferences: ["block-2"],
    authorizedNextAction: "Investigate",
  });
  assert.equal(secondBlock.applied, true);
  if (!secondBlock.applied) return;
  const original = checkpoint(secondBlock.state);
  assert.equal((await new FileCheckpointStore(directory).save(original)).status, "SAVED");
  const restored = await new FileCheckpointStore(directory).load("run-1");
  assert.equal(restored.status, "RESTORED");
  if (restored.status === "RESTORED") {
    assert.equal(restored.checkpoint.taskRecords[0]?.state.status, "BLOCKED");
    assert.deepEqual(restored.checkpoint.taskRecords[0]?.state.blockHistory, secondBlock.state.blockHistory);
    assert.deepEqual(restored.checkpoint.taskRecords[0]?.state.recoveryHistory, secondBlock.state.recoveryHistory);
  }
});

test("reports missing, malformed, and unsupported checkpoint files", async (t) => {
  const directory = await tempDirectory(t);
  const store = new FileCheckpointStore(directory);
  const missing = await store.load("run-1");
  assert.equal(missing.status, "ERROR");
  if (missing.status === "ERROR") assert.equal(missing.error.code, "MISSING");

  await writeFile(join(directory, "run-1.json"), "{incomplete");
  const malformed = await store.load("run-1");
  assert.equal(malformed.status, "ERROR");
  if (malformed.status === "ERROR") assert.equal(malformed.error.code, "CORRUPT");

  await writeUnchecked(directory, { ...checkpoint(), schemaVersion: 2 });
  const unsupported = await store.load("run-1");
  assert.equal(unsupported.status, "ERROR");
  if (unsupported.status === "ERROR") assert.equal(unsupported.error.code, "UNSUPPORTED_VERSION");
});

test("rejects inconsistent stage history, missing task state, and invalid task graphs", async (t) => {
  const directory = await tempDirectory(t);
  const store = new FileCheckpointStore(directory);
  const inconsistent = checkpoint();
  await writeUnchecked(directory, {
    ...inconsistent,
    taskRecords: [{ taskId: task.taskId, state: { ...createPendingTask(), status: "VERIFIED" }, recordedCommitSha: sha }],
  });
  const badState = await store.load("run-1");
  assert.equal(badState.status, "ERROR");
  if (badState.status === "ERROR") assert.match(badState.error.detail, /stage history/);

  await writeUnchecked(directory, { ...checkpoint(), taskRecords: [] });
  const missingState = await store.load("run-1");
  assert.equal(missingState.status, "ERROR");
  if (missingState.status === "ERROR") assert.equal(missingState.error.code, "CORRUPT");

  await writeUnchecked(directory, { ...checkpoint(), taskGraph: [{ ...task, dependencies: ["missing-task"] }] });
  const badGraph = await store.load("run-1");
  assert.equal(badGraph.status, "ERROR");
  if (badGraph.status === "ERROR") assert.match(badGraph.error.detail, /Invalid task graph/);
});

test("rejects verified progress without matching review metadata or a matching run identity", async (t) => {
  const directory = await tempDirectory(t);
  const store = new FileCheckpointStore(directory);
  await writeUnchecked(directory, checkpoint(verifiedState()));
  const missingReview = await store.load("run-1");
  assert.equal(missingReview.status, "ERROR");
  if (missingReview.status === "ERROR") assert.match(missingReview.error.detail, /matching recorded review execution/);

  const original = verifiedCheckpoint();
  await writeUnchecked(directory, {
    ...original,
    executionRecords: original.executionRecords.map((record) => ({
      ...record,
      identity: { ...record.identity, runId: "different-run" },
    })),
  });
  const wrongRun = await store.load("run-1");
  assert.equal(wrongRun.status, "ERROR");
  if (wrongRun.status === "ERROR") assert.match(wrongRun.error.detail, /Execution identity/);
});

test("rejects run IDs that could escape the configured directory", async (t) => {
  const directory = await tempDirectory(t);
  const store = new FileCheckpointStore(directory);
  const loaded = await store.load("../escape");
  assert.equal(loaded.status, "ERROR");
  if (loaded.status === "ERROR") assert.equal(loaded.error.code, "INVALID_RUN_ID");
  const saved = await store.save({ ...checkpoint(), runId: "../escape" });
  assert.equal(saved.status, "ERROR");
  if (saved.status === "ERROR") assert.equal(saved.error.code, "INVALID_RUN_ID");
  assert.deepEqual(await readdir(directory), []);
});

test("failed replacement and leftover partial files preserve the last valid revision", async (t) => {
  const directory = await tempDirectory(t);
  const store = new FileCheckpointStore(directory);
  assert.equal((await store.save(checkpoint())).status, "SAVED");
  const failingStore = new FileCheckpointStore(directory, async () => { throw new Error("injected replacement failure"); });
  const failed = await failingStore.save(checkpoint(createPendingTask(), 2));
  assert.equal(failed.status, "ERROR");
  if (failed.status === "ERROR") assert.equal(failed.error.code, "IO_ERROR");
  await writeFile(join(directory, ".run-1.abandoned.tmp"), "{partial");
  const restored = await new FileCheckpointStore(directory).load("run-1");
  assert.equal(restored.status, "RESTORED");
  if (restored.status === "RESTORED") assert.equal(restored.checkpoint.revision, 1);
  assert.deepEqual((await readdir(directory)).sort(), [".run-1.abandoned.tmp", "run-1.json"]);
  assert.equal(JSON.parse(await readFile(join(directory, "run-1.json"), "utf8")).revision, 1);
});

test("revision conflicts cannot overwrite an existing checkpoint", async (t) => {
  const directory = await tempDirectory(t);
  const store = new FileCheckpointStore(directory);
  assert.equal((await store.save(checkpoint())).status, "SAVED");
  const updated = {
    ...checkpoint(advance(createPendingTask(), "IMPLEMENTING", "DISPATCH_APPROVED"), 2),
    authorizedRequirementsVersion: "requirements-v2",
  };
  assert.deepEqual(await store.save(updated), { status: "SAVED", revision: 2 });
  const conflict = await store.save(checkpoint(createPendingTask(), 2));
  assert.equal(conflict.status, "ERROR");
  if (conflict.status === "ERROR") assert.equal(conflict.error.code, "REVISION_CONFLICT");
  const restored = await store.load("run-1");
  assert.equal(restored.status, "RESTORED");
  if (restored.status === "RESTORED") {
    assert.equal(restored.checkpoint.revision, 2);
    assert.equal(restored.checkpoint.authorizedRequirementsVersion, "requirements-v2");
    assert.equal(restored.checkpoint.taskRecords[0]?.state.status, "IMPLEMENTING");
  }
});

test("later revisions cannot change an existing run's repository, branch, or work item", async (t) => {
  const original = checkpoint();
  const changes: { field: string; next: RunCheckpoint }[] = [
    { field: "repository.repositoryId", next: {
      ...checkpoint(createPendingTask(), 2),
      repository: { ...original.repository, repositoryId: "different/repository" },
    } },
    { field: "repository.branch", next: {
      ...checkpoint(createPendingTask(), 2),
      repository: { ...original.repository, branch: "feature/different" },
    } },
    { field: "workItemId", next: {
      ...checkpoint(createPendingTask(), 2), workItemId: "different-work-item",
    } },
  ];
  for (const { field, next } of changes) {
    const directory = await tempDirectory(t);
    const store = new FileCheckpointStore(directory);
    assert.deepEqual(await store.save(original), { status: "SAVED", revision: 1 });
    const priorBytes = await readFile(join(directory, "run-1.json"), "utf8");
    const rejected = await store.save(next);
    assert.equal(rejected.status, "ERROR");
    if (rejected.status === "ERROR") {
      assert.equal(rejected.error.code, "RUN_IDENTITY_MISMATCH");
      assert.match(rejected.error.detail, new RegExp(field.replace(".", "\\.")));
    }
    assert.equal(await readFile(join(directory, "run-1.json"), "utf8"), priorBytes);
    const restored = await new FileCheckpointStore(directory).load("run-1");
    assert.equal(restored.status, "RESTORED");
    if (restored.status === "RESTORED") assert.deepEqual(restored.checkpoint, original);
  }
});

test("a restored VERIFIED state remains recorded history without dispatch authorization", async (t) => {
  const directory = await tempDirectory(t);
  assert.equal((await new FileCheckpointStore(directory).save(verifiedCheckpoint())).status, "SAVED");
  const restored = await new FileCheckpointStore(directory).load("run-1");
  assert.equal(restored.status, "RESTORED");
  if (restored.status !== "RESTORED") return;
  assert.equal(restored.requiresReconciliation, true);
  assert.equal(Object.hasOwn(restored.checkpoint, "authorization"), false);
  const dispatch = evaluateDispatchEligibility({
    tasks: restored.checkpoint.taskGraph,
    taskId: task.taskId,
    proposedRequirementsVersion: restored.checkpoint.authorizedRequirementsVersion,
    states: { [task.taskId]: restored.checkpoint.taskRecords[0]!.state },
  });
  assert.equal(dispatch.eligible, false);
  if (!dispatch.eligible) assert.ok(dispatch.reasons.some((reason) => reason.code === "AUTHORIZATION_MISSING"));
  assert.equal(validateRunCheckpoint(restored.checkpoint).valid, true);
});

test("rejects history loss and substitution before replacing a verified checkpoint", async (t) => {
  const directory = await tempDirectory(t);
  const store = new FileCheckpointStore(directory);
  const original = verifiedCheckpoint();
  assert.equal((await store.save(original)).status, "SAVED");
  const path = join(directory, "run-1.json");
  const bytes = await readFile(path, "utf8");
  const record = original.taskRecords[0]!;
  const cases: [string, RunCheckpoint][] = [
    ["VERIFIED regression", { ...original, revision: 2, taskRecords: [{ ...record, state: createPendingTask() }] }],
    ["execution loss", { ...original, revision: 2, executionRecords: original.executionRecords.filter((item) => item.role !== "implementer") }],
    ["review rewrite", { ...original, revision: 2, executionRecords: original.executionRecords.map((item) => item.role === "reviewer" ? { ...item, evidenceReferences: ["replacement"] } : item) }],
    ["completed evidence rewrite", { ...original, revision: 2, taskRecords: [{ ...record, state: { ...record.state, completedStages: record.state.completedStages.map((item, index) => index ? item : { ...item, evidenceReferences: ["replacement"] }) } }] }],
    ["commit substitution", { ...original, revision: 2, taskRecords: [{ ...record, recordedCommitSha: "b".repeat(40) }],
      executionRecords: original.executionRecords.map((item) => item.role === "reviewer" ? { ...item, commitSha: "b".repeat(40) } : item) }],
  ];
  for (const [name, next] of cases) {
    const result = await store.save(next);
    assert.equal(result.status, "ERROR", name);
    if (result.status === "ERROR") assert.equal(result.error.code, "CONTINUITY_VIOLATION", name);
    assert.equal(await readFile(path, "utf8"), bytes, name);
    const loaded = await store.load("run-1");
    assert.equal(loaded.status, "RESTORED", name);
    if (loaded.status === "RESTORED") assert.deepEqual(loaded.checkpoint, original, name);
  }
});

test("execution records retain their positions and accept only appended records", async (t) => {
  const directory = await tempDirectory(t);
  const store = new FileCheckpointStore(directory);
  const original = verifiedCheckpoint();
  assert.deepEqual(await store.save(original), { status: "SAVED", revision: 1 });
  const path = join(directory, "run-1.json");
  const bytes = await readFile(path);
  const added = {
    recordId: "execution-plan-2",
    role: "planner" as const,
    identity: { ...plannerIdentity, attemptId: "plan-2" },
    evidenceReferences: ["plan-record-2"],
  };
  const [plan, implementer, reviewer] = original.executionRecords;
  assert.ok(plan && implementer && reviewer);
  const cases = [
    ["swapped implementer and reviewer", [plan, reviewer, implementer]],
    ["inserted before existing records", [added, ...original.executionRecords]],
    ["inserted between existing records", [plan, implementer, added, reviewer]],
    ["removed an existing record", [plan, reviewer]],
    ["rewrote an existing record", [plan, implementer, { ...reviewer, evidenceReferences: ["replacement"] }]],
  ] as const;
  for (const [name, executionRecords] of cases) {
    const result = await store.save({ ...original, revision: 2, executionRecords });
    assert.equal(result.status, "ERROR", name);
    if (result.status === "ERROR") {
      assert.equal(result.error.code, "CONTINUITY_VIOLATION", name);
      assert.match(result.error.detail, /executionRecords.*append|executionRecords.*position/i, name);
    }
    assert.deepEqual(await readFile(path), bytes, name);
    const restored = await store.load(original.runId);
    assert.equal(restored.status, "RESTORED", name);
    if (restored.status === "RESTORED") assert.deepEqual(restored.checkpoint, original, name);
  }

  const appended = { ...original, revision: 2, executionRecords: [...original.executionRecords, added] };
  assert.deepEqual(await store.save(appended), { status: "SAVED", revision: 2 });
  const restored = await store.load(original.runId);
  assert.equal(restored.status, "RESTORED");
  if (restored.status === "RESTORED") assert.deepEqual(restored.checkpoint, appended);
});

test("preserves block and recovery history while permitting structurally valid recovery", async (t) => {
  const store = new FileCheckpointStore(await tempDirectory(t));
  let state = advance(createPendingTask(), "IMPLEMENTING", "DISPATCH_APPROVED");
  state = advance(state, "VERIFYING", "IMPLEMENTATION_CONFIRMED");
  const blocked = applyTaskTransition(state, { type: "BLOCK", reason: { code: "EVIDENCE", detail: "Review needed" },
    evidenceReferences: ["block-1"], authorizedNextAction: "Revalidate" });
  assert.equal(blocked.applied, true);
  if (!blocked.applied) return;
  const original = checkpoint(blocked.state);
  assert.equal((await store.save(original)).status, "SAVED");
  const erased = checkpoint({ ...blocked.state, blockHistory: [{ ...blocked.state.blockHistory[0]!, evidenceReferences: ["replaced"] }] }, 2);
  const rejected = await store.save(erased);
  assert.equal(rejected.status, "ERROR");
  if (rejected.status === "ERROR") assert.equal(rejected.error.code, "CONTINUITY_VIOLATION");
  const resumed = applyTaskTransition(blocked.state, { type: "RESUME", decision: {
    blockerResolved: true, requirementsValid: true, repositoryValid: true, dependenciesValid: true, environmentAuthorized: true,
    evidenceReferences: ["recovery-1"], stageRevalidations: blocked.state.completedStages.map((item, index) =>
      ({ stage: item.stage, valid: index === 0, evidenceReferences: [`revalidation-${index}`] })),
  } });
  assert.equal(resumed.applied, true);
  if (!resumed.applied) return;
  assert.deepEqual(await store.save({ ...checkpoint(resumed.state, 2),
    taskRecords: [{ taskId: task.taskId, state: resumed.state, recordedCommitSha: sha }],
    authorizedRequirementsVersion: "requirements-v2" }),
    { status: "SAVED", revision: 2 });
  const truncated = { ...checkpoint(createPendingTask(), 3), taskRecords: [{ taskId: task.taskId,
    state: createPendingTask(), recordedCommitSha: sha }] };
  const result = await store.save(truncated);
  assert.equal(result.status, "ERROR");
  if (result.status === "ERROR") assert.equal(result.error.code, "CONTINUITY_VIOLATION");
});
