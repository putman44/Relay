import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { applyTaskTransition, type TaskState } from "./state.js";
import {
  CheckpointRunIdSchema,
  validateRunCheckpoint,
  type CheckpointError,
  type RunCheckpoint,
} from "./checkpoint.js";

export type SaveCheckpointResult =
  | { status: "SAVED"; revision: number }
  | { status: "ERROR"; error: CheckpointError };
export type RestoreCheckpointResult =
  | { status: "RESTORED"; checkpoint: RunCheckpoint; requiresReconciliation: true }
  | { status: "ERROR"; error: CheckpointError };

export interface CheckpointStore {
  save(checkpoint: RunCheckpoint): Promise<SaveCheckpointResult>;
  load(runId: string): Promise<RestoreCheckpointResult>;
}

type ReplaceFile = (temporaryPath: string, checkpointPath: string) => Promise<void>;
const ioError = (detail: string): CheckpointError => ({ code: "IO_ERROR", detail });
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const prefix = <T>(before: readonly T[], after: readonly T[]): boolean =>
  after.length >= before.length && before.every((item, index) => same(item, after[index]));
const continuityError = (detail: string): CheckpointError => ({ code: "CONTINUITY_VIOLATION", detail });

/** Check only the recorded shape of one transition; this does not authorize it. */
function stateContinuity(before: TaskState, after: TaskState): boolean {
  if (same(before, after)) return true;
  if (!prefix(before.blockHistory, after.blockHistory) ||
      !prefix(before.recoveryHistory, after.recoveryHistory) ||
      !prefix(before.invalidatedStages, after.invalidatedStages)) return false;
  if (before.status === "VERIFIED") return false;
  if (before.status === "BLOCKED") {
    if (after.blockHistory.length !== before.blockHistory.length ||
        after.recoveryHistory.length !== before.recoveryHistory.length + 1) return false;
    const recovery = after.recoveryHistory.at(-1)!;
    const revalidations = recovery.stageRevalidations;
    if (revalidations.length !== before.completedStages.length ||
        revalidations.some((item, index) => item.stage !== before.completedStages[index]?.stage)) return false;
    const invalidFrom = revalidations.findIndex((item) => !item.valid);
    const retained = invalidFrom < 0 ? before.completedStages : before.completedStages.slice(0, invalidFrom);
    const invalidated = invalidFrom < 0 ? [] : before.completedStages.slice(invalidFrom);
    return after.status === recovery.resumedStage &&
      after.status === (invalidFrom < 0 ? before.blockHistory.at(-1)!.lastValidStage : before.completedStages[invalidFrom]!.stage) &&
      same(after.completedStages, retained) &&
      same(after.invalidatedStages, [...before.invalidatedStages, ...invalidated]);
  }
  if (after.recoveryHistory.length !== before.recoveryHistory.length) return false;
  if (after.status === "BLOCKED") {
    if (after.blockHistory.length !== before.blockHistory.length + 1) return false;
    const block = after.blockHistory.at(-1)!;
    const result = applyTaskTransition(before, { type: "BLOCK", reason: block.reason,
      evidenceReferences: block.evidenceReferences, authorizedNextAction: block.authorizedNextAction });
    return result.applied && same(result.state, after);
  }
  if (after.blockHistory.length !== before.blockHistory.length ||
      after.completedStages.length !== before.completedStages.length + 1) return false;
  const completion = after.completedStages.at(-1)!;
  const result = applyTaskTransition(before, { type: "ADVANCE", to: after.status,
    decision: { kind: completion.decision, evidenceReferences: completion.evidenceReferences } });
  return result.applied && same(result.state, after);
}

function checkpointContinuity(before: RunCheckpoint, after: RunCheckpoint): CheckpointError | null {
  if (!same(before.taskGraph, after.taskGraph)) return continuityError("taskGraph changed; this store cannot authorize graph replacement");
  if (!prefix(before.authorizationEvidenceReferences, after.authorizationEvidenceReferences))
    return continuityError("authorizationEvidenceReferences removed or rewritten");
  const oldExecutions = new Map(before.executionRecords.map((record) => [record.recordId, record]));
  for (const [id, record] of oldExecutions) {
    if (!same(record, after.executionRecords.find((item) => item.recordId === id)))
      return continuityError(`executionRecords[${id}] removed or rewritten`);
  }
  for (const oldRecord of before.taskRecords) {
    const next = after.taskRecords.find((item) => item.taskId === oldRecord.taskId);
    if (!next) return continuityError(`taskRecords[${oldRecord.taskId}] removed`);
    if (oldRecord.recordedCommitSha && oldRecord.recordedCommitSha !== next.recordedCommitSha)
      return continuityError(`taskRecords[${oldRecord.taskId}].recordedCommitSha changed`);
    if (!stateContinuity(oldRecord.state, next.state))
      return continuityError(`taskRecords[${oldRecord.taskId}].state has unsupported transition or rewritten history`);
  }
  return null;
}

/** One local JSON file per run. Concurrent writers require a separate coordination layer. */
export class FileCheckpointStore implements CheckpointStore {
  constructor(
    private readonly directory: string,
    private readonly replaceFile: ReplaceFile = rename,
  ) {
    if (!isAbsolute(directory)) throw new TypeError("Checkpoint directory must be an explicit absolute path");
  }

  private pathFor(runId: string): string {
    return join(this.directory, `${runId}.json`);
  }

  async load(runId: string): Promise<RestoreCheckpointResult> {
    if (!CheckpointRunIdSchema.safeParse(runId).success) {
      return { status: "ERROR", error: { code: "INVALID_RUN_ID", detail: "Run ID is not safe for checkpoint storage" } };
    }
    const path = this.pathFor(runId);
    try {
      const stat = await lstat(path);
      if (!stat.isFile()) {
        return { status: "ERROR", error: { code: "CORRUPT", detail: "Checkpoint path is not a regular file" } };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "ERROR", error: { code: "MISSING", detail: "Checkpoint does not exist" } };
      }
      return { status: "ERROR", error: ioError("Could not inspect checkpoint") };
    }
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return { status: "ERROR", error: ioError("Could not read checkpoint") };
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return { status: "ERROR", error: { code: "CORRUPT", detail: "Checkpoint is not valid JSON" } };
    }
    const validation = validateRunCheckpoint(value);
    if (!validation.valid) return { status: "ERROR", error: validation.error };
    if (validation.checkpoint.runId !== runId) {
      return { status: "ERROR", error: { code: "CORRUPT", detail: "Checkpoint run ID does not match its filename" } };
    }
    return { status: "RESTORED", checkpoint: validation.checkpoint, requiresReconciliation: true };
  }

  async save(checkpoint: RunCheckpoint): Promise<SaveCheckpointResult> {
    if (!CheckpointRunIdSchema.safeParse(checkpoint?.runId).success) {
      return { status: "ERROR", error: { code: "INVALID_RUN_ID", detail: "Run ID is not safe for checkpoint storage" } };
    }
    const validation = validateRunCheckpoint(checkpoint);
    if (!validation.valid) return { status: "ERROR", error: validation.error };
    const snapshot = validation.checkpoint;
    const previous = await this.load(snapshot.runId);
    if (previous.status === "ERROR" && previous.error.code !== "MISSING") return previous;
    if (previous.status === "RESTORED") {
      const existing = previous.checkpoint;
      const immutableFields = [
        ["repository.repositoryId", existing.repository.repositoryId, snapshot.repository.repositoryId],
        ["repository.branch", existing.repository.branch, snapshot.repository.branch],
        ["workItemId", existing.workItemId, snapshot.workItemId],
      ] as const;
      const mismatch = immutableFields.find(([, before, after]) => before !== after);
      if (mismatch) {
        return { status: "ERROR", error: {
          code: "RUN_IDENTITY_MISMATCH",
          detail: `Existing run identity differs at ${mismatch[0]}`,
        } };
      }
    }
    const expectedRevision = previous.status === "RESTORED" ? previous.checkpoint.revision + 1 : 1;
    if (snapshot.revision !== expectedRevision) {
      return { status: "ERROR", error: {
        code: "REVISION_CONFLICT",
        detail: `Expected checkpoint revision ${expectedRevision}`,
      } };
    }
    if (previous.status === "RESTORED") {
      const error = checkpointContinuity(previous.checkpoint, snapshot);
      if (error) return { status: "ERROR", error };
    }

    const temporaryPath = join(this.directory, `.${snapshot.runId}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.replaceFile(temporaryPath, this.pathFor(snapshot.runId));
      return { status: "SAVED", revision: snapshot.revision };
    } catch {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      return { status: "ERROR", error: ioError("Checkpoint write or replacement failed") };
    }
  }
}
