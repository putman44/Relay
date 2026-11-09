import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FileAttemptReservation } from "./file-attempt-reservation.js";

const policyPath = ".agents/relay-orchestration-policy.json";
const commitPattern = /^[0-9a-f]{40}$/;
const token = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value && !/[\x00-\x1f]/.test(value);
const roles = ["planner", "implementer", "reviewer"] as const;
const requiredSettings = {
  planner: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
  implementer: { model: "gpt-6.1-sol", reasoningEffort: "high" },
  reviewer: { model: "gpt-6.1-sol", reasoningEffort: "high" },
} as const;

export interface PolicyIdentity {
  encodingVersion: 1;
  policyDigest: string;
  sourceCommit: string;
  roles: typeof requiredSettings;
}

export interface PolicyBinding {
  policyDigest: string;
  sourceCommit: string;
  requirementsVersion: string;
}

function exactPolicy(value: unknown): typeof requiredSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed role policy");
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).sort().join() !== "roles,schemaVersion" || policy.schemaVersion !== 1 ||
      !policy.roles || typeof policy.roles !== "object" || Array.isArray(policy.roles)) throw new Error("Malformed role policy");
  const configured = policy.roles as Record<string, unknown>;
  if (Object.keys(configured).sort().join() !== [...roles].sort().join()) throw new Error("Malformed role policy");
  for (const role of roles) {
    const setting = configured[role];
    if (!setting || typeof setting !== "object" || Array.isArray(setting) ||
        Object.keys(setting).sort().join() !== "model,reasoningEffort" ||
        (setting as Record<string, unknown>).model !== requiredSettings[role].model ||
        (setting as Record<string, unknown>).reasoningEffort !== requiredSettings[role].reasoningEffort) {
      throw new Error("Role policy does not match the approved exact settings");
    }
  }
  return requiredSettings;
}

const encoding = (settings: typeof requiredSettings) => JSON.stringify([1, 1, ...roles.map((role) =>
  [role, settings[role].model, settings[role].reasoningEffort])]);

/** Read only a full, verified commit object from the trusted checkout. */
export function policyFromCommit(repository: string, sourceCommit: string): PolicyIdentity {
  if (!commitPattern.test(sourceCommit)) throw new Error("A full approved policy commit is required");
  const cwd = resolve(repository);
  const resolved = execFileSync("git", ["rev-parse", "--verify", `${sourceCommit}^{commit}`], { cwd, encoding: "utf8" }).trim();
  if (resolved !== sourceCommit) throw new Error("Policy source is not the verified commit");
  const source = execFileSync("git", ["show", `${sourceCommit}:${policyPath}`], { cwd, encoding: "utf8" });
  const settings = exactPolicy(JSON.parse(source));
  return Object.freeze({ encodingVersion: 1, policyDigest: createHash("sha256").update(encoding(settings)).digest("hex"),
    sourceCommit, roles: requiredSettings });
}

export function validatePolicyBinding(value: unknown): asserts value is PolicyBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Policy binding missing");
  const binding = value as Record<string, unknown>;
  if (Object.keys(binding).sort().join() !== "policyDigest,requirementsVersion,sourceCommit" ||
      typeof binding.policyDigest !== "string" || !/^[0-9a-f]{64}$/.test(binding.policyDigest) ||
      typeof binding.sourceCommit !== "string" || !commitPattern.test(binding.sourceCommit) ||
      !token(binding.requirementsVersion)) throw new Error("Policy binding malformed");
}

export interface PolicyGate {
  readonly policy: PolicyIdentity;
  assertCurrent(): Promise<void>;
  complete(outcome: "NO_DISPATCH" | "VALIDATED_RESPONSE", reservationDigest: string): Promise<void>;
  releaseWithoutClaim(): Promise<void>;
}

export interface PolicyCoordinator {
  beginAttempt(approvedCommit: string, approvalEvidence: string): Promise<PolicyGate>;
}

/** One local gate serializes policy promotion with reservation, capability checks and dispatch. */
export class PolicyCoordination implements PolicyCoordinator {
  constructor(private readonly repository: string, private readonly reservation: FileAttemptReservation) {}

  private get directory() { return this.reservation.directory; }
  private get gatePath() { return join(this.directory, ".policy-gate.json"); }
  private get activePath() { return join(this.directory, ".active-policy.json"); }

  private async syncDirectory() {
    const handle = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async readPrivate(path: string): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const state = await handle.stat();
      if (!state.isFile() || state.nlink !== 1 || state.uid !== process.getuid?.() ||
          (state.mode & 0o077) !== 0) throw new Error("Unsafe policy coordination evidence");
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  }

  private async acquire(): Promise<{ id: string; verify: () => Promise<void>; release: () => Promise<void> }> {
    await this.reservation.verifyDirectory();
    const id = randomUUID();
    const record = JSON.stringify({ version: 1, id }) + "\n";
    const handle = await open(this.gatePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(record); await handle.sync(); } finally { await handle.close(); }
    await this.syncDirectory();
    await this.reservation.verifyDirectory();
    const verify = async () => {
      await this.reservation.verifyDirectory();
      const current = await this.readPrivate(this.gatePath);
      if (current !== record) throw new Error("Coordination gate identity changed");
    };
    return { id, verify, release: async () => {
      await verify();
      await unlink(this.gatePath);
      await this.syncDirectory();
      await this.reservation.verifyDirectory();
    } };
  }

  private async active(): Promise<{ version: 1; policyDigest: string; sourceCommit: string; approvalEvidence: string }> {
    {
      const value: unknown = JSON.parse(await this.readPrivate(this.activePath));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Corrupt active policy reference");
      const record = value as Record<string, unknown>;
      if (Object.keys(record).sort().join() !== "approvalEvidence,policyDigest,sourceCommit,version" || record.version !== 1 ||
          typeof record.policyDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.policyDigest) ||
          typeof record.sourceCommit !== "string" || !commitPattern.test(record.sourceCommit) || !token(record.approvalEvidence)) {
        throw new Error("Corrupt active policy reference");
      }
      return record as { version: 1; policyDigest: string; sourceCommit: string; approvalEvidence: string };
    }
  }

  async promote(sourceCommit: string, approvalEvidence: string): Promise<PolicyIdentity> {
    if (!token(approvalEvidence)) throw new Error("Explicit policy promotion approval evidence is required");
    const policy = policyFromCommit(this.repository, sourceCommit);
    const working = await readFile(join(this.repository, policyPath), "utf8");
    const committed = execFileSync("git", ["show", `${sourceCommit}:${policyPath}`], { cwd: this.repository, encoding: "utf8" });
    if (working !== committed) throw new Error("Working policy differs from approved commit");
    const gate = await this.acquire();
    let mutationStarted = false;
    try {
      for (const name of await readdir(this.directory)) {
        if (!name.endsWith(".reservation.json")) continue;
        const digest = name.slice(0, -".reservation.json".length);
        const completion = join(this.directory, `${digest}.completion.json`);
        const reservation = await this.reservation.readReservation(digest);
        if (reservation.version !== 2) throw new Error("Legacy reservation requires reconciliation before promotion");
        const proof = JSON.parse(await this.readPrivate(completion)) as Record<string, unknown>;
        if (Object.keys(proof).sort().join() !== "digest,outcome,version" || proof.version !== 1 || proof.digest !== digest ||
            !["NO_DISPATCH", "VALIDATED_RESPONSE"].includes(String(proof.outcome))) throw new Error("Attempt completion is unproven");
      }
      const record = JSON.stringify({ version: 1, policyDigest: policy.policyDigest, sourceCommit, approvalEvidence }) + "\n";
      const temporary = join(this.directory, `.active-policy-${gate.id}.tmp`);
      mutationStarted = true;
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(record); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.activePath);
      await this.syncDirectory();
      await gate.release();
      return policy;
    } catch (error) {
      // Before the first write, validation failures are clean and may release the gate.
      if (!mutationStarted) await gate.release();
      // A failed write may have changed the active reference. Retain the gate for reconciliation.
      throw error;
    }
  }

  async beginAttempt(approvedCommit: string, approvalEvidence: string): Promise<PolicyGate> {
    if (!token(approvalEvidence)) throw new Error("Explicit policy approval evidence is required");
    const expected = policyFromCommit(this.repository, approvedCommit);
    const gate = await this.acquire();
    const assertCurrent = async () => {
      await gate.verify();
      await this.reservation.verifyDirectory();
      const active = await this.active();
      if (active.policyDigest !== expected.policyDigest || active.sourceCommit !== expected.sourceCommit ||
          active.approvalEvidence !== approvalEvidence) throw new Error("Active policy identity mismatch");
      const source = await readFile(join(this.repository, policyPath), "utf8");
      exactPolicy(JSON.parse(source));
      const committed = execFileSync("git", ["show", `${approvedCommit}:${policyPath}`], { cwd: this.repository, encoding: "utf8" });
      if (source !== committed) throw new Error("Working policy differs from approved commit");
    };
    try { await assertCurrent(); } catch (error) {
      await gate.release();
      throw error;
    }
    return {
      policy: expected,
      assertCurrent,
      releaseWithoutClaim: gate.release,
      complete: async (outcome, reservationDigest) => {
        await assertCurrent();
        const reserved = await this.reservation.readReservation(reservationDigest);
        const binding = reserved.policy as PolicyBinding;
        if (binding.policyDigest !== expected.policyDigest || binding.sourceCommit !== expected.sourceCommit) {
          throw new Error("Completion policy differs from reserved policy");
        }
        const completion = join(this.directory, `${reservationDigest}.completion.json`);
        const record = JSON.stringify({ version: 1, digest: reservationDigest, outcome }) + "\n";
        const handle = await open(completion, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(record); await handle.sync(); } finally { await handle.close(); }
        await this.syncDirectory();
        await gate.release();
      },
    };
  }
}
