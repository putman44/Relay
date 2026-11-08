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
