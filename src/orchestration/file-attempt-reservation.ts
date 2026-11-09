import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, statfs, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, sep } from "node:path";
import type { PlannerAttemptIdentity, TrustedAttemptReservation } from "./planner-handoff.js";
import { validatePolicyBinding, type PolicyBinding } from "./policy-coordination.js";

const fields = ["canonicalHost", "canonicalRepository", "issueNumber", "runId", "taskId", "attemptId"] as const;
const token = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value && !/[\x00-\x1f]/.test(value);

export function canonicalAttempt(identity: Readonly<PlannerAttemptIdentity>): string {
  if (!identity || typeof identity !== "object" || Object.keys(identity).sort().join() !== [...fields].sort().join() ||
      typeof identity.canonicalHost !== "string" || !/^[A-Za-z0-9.-]+$/.test(identity.canonicalHost) ||
      typeof identity.canonicalRepository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.canonicalRepository) ||
      !Number.isSafeInteger(identity.issueNumber) || identity.issueNumber <= 0 ||
      !token(identity.runId) || !token(identity.taskId) || !token(identity.attemptId)) {
    throw new TypeError("Invalid attempt identity");
  }
  return JSON.stringify(fields.map((field) => identity[field]));
}

export function attemptDigest(identity: Readonly<PlannerAttemptIdentity>): string {
  return createHash("sha256").update(canonicalAttempt(identity)).digest("hex");
}

export interface ReservationIO {
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
}
const defaultIO: ReservationIO = { open };

/** Exclusive, retained local reservation. No method releases or retries an attempt. */
export class FileAttemptReservation implements TrustedAttemptReservation {
  constructor(readonly directory: string, private readonly io: ReservationIO = defaultIO) {
    if (typeof directory !== "string" || !isAbsolute(directory) ||
        directory.split(sep).some((part) => part === "." || part === "..") ||
        directory !== parse(directory).root && directory.endsWith(sep)) {
      throw new TypeError("Reservation directory must be a canonical absolute path");
    }
  }

  async verifyDirectory(): Promise<void> {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Filesystem ownership cannot be verified");
    const root = parse(this.directory).root;
    let path = root;
    for (const part of this.directory.slice(root.length).split(sep).filter(Boolean)) {
      path = join(path, part);
      const state = await lstat(path);
      if (!state.isDirectory() || state.isSymbolicLink() ||
          (state.uid !== 0 && state.uid !== uid) ||
          ((state.mode & 0o022) !== 0 && !((state.mode & 0o1000) !== 0 && state.uid === 0))) {
        throw new Error("Unsafe reservation directory path");
      }
    }
    const state = await lstat(this.directory);
    if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== uid ||
        (state.mode & 0o077) !== 0) throw new Error("Reservation directory must be private and owned by the current user");
    const filesystem = await statfs(this.directory);
    // APFS on macOS; ext4, XFS and Btrfs on Linux. Other or remote filesystems are unproven.
    const allowed = process.platform === "darwin" ? [26] : process.platform === "linux" ? [0xef53, 0x58465342, 0x9123683e] : [];
    if (!allowed.includes(filesystem.type)) throw new Error("Reservation filesystem semantics are unproven");
  }

  async readReservation(digest: string): Promise<{ version: number; digest: string; identity: unknown; policy: unknown }> {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Invalid reservation digest");
    await this.verifyDirectory();
    const handle = await this.io.open(join(this.directory, `${digest}.reservation.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const state = await handle.stat();
      if (!state.isFile() || state.nlink !== 1 || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) {
        throw new Error("Reservation record is unsafe");
      }
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Reservation record is corrupt");
      const record = parsed as Record<string, unknown>;
      if (Object.keys(record).sort().join() !== "digest,identity,policy,version" || record.version !== 2 || record.digest !== digest ||
          !Array.isArray(record.identity) || record.identity.length !== fields.length) throw new Error("Reservation record is legacy or corrupt");
      const candidate = Object.fromEntries(fields.map((field, index) => [field, (record.identity as unknown[])[index]])) as PlannerAttemptIdentity;
      if (attemptDigest(candidate) !== digest) throw new Error("Reservation identity mismatch");
      validatePolicyBinding(record.policy);
      return record as { version: number; digest: string; identity: unknown; policy: unknown };
    } finally { await handle.close(); }
  }

  async reserveAttempt(identity: Readonly<PlannerAttemptIdentity>, policy: Readonly<PolicyBinding>): Promise<"RESERVED" | "ALREADY_RESERVED"> {
    const encoded = canonicalAttempt(identity);
    validatePolicyBinding(policy);
    const digest = attemptDigest(identity);
    const path = join(this.directory, `${digest}.reservation.json`);
    const record = JSON.stringify({ version: 2, digest, identity: JSON.parse(encoded), policy }) + "\n";
    await this.verifyDirectory();
    let handle: FileHandle;
    try {
      handle = await this.io.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await this.verifyDirectory();
      const existing = await this.io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: string;
      try {
        const state = await existing.stat();
        if (!state.isFile() || state.nlink !== 1 || state.uid !== process.getuid?.() ||
            (state.mode & 0o077) !== 0 || state.size !== Buffer.byteLength(record)) {
          throw new Error("Reservation record is unsafe or incomplete");
        }
        content = await existing.readFile("utf8");
      } finally {
        await existing.close();
      }
      // An old, partial, or changed claim remains a hold, never a replacement.
      if (content !== record) throw new Error("Reservation record is legacy, corrupt, or mismatched");
      return "ALREADY_RESERVED";
    }
    // A failed write, file sync, close, or directory sync is ambiguous. Keep the file.
    try {
      await handle.writeFile(record, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    await handle.close();
    const directory = await this.io.open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await this.verifyDirectory();
    return "RESERVED";
  }
}
