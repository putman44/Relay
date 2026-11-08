import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
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
