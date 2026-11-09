import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FileAttemptReservation } from "./file-attempt-reservation.js";

const policyPath = ".agents/relay-orchestration-policy.json";
const commitPattern = /^[0-9a-f]{40}$/;
const token = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value && !/[\x00-\x1f]/.test(value);
const roles = ["planner", "implementer", "reviewer"] as const;
type RoleSettings = Readonly<Record<typeof roles[number], Readonly<{ model: string; reasoningEffort: string }>>>;
export interface CanonicalRepository { readonly canonicalHost: string; readonly canonicalRepository: string }

function repositoryIdentity(repository: string): CanonicalRepository {
  const cwd = resolve(repository);
  const configured = (...args: string[]) => {
    const result = spawnSync("git", ["config", ...args], { cwd, encoding: "utf8" });
    if (result.status !== 0 && result.status !== 1) throw new Error("Git upstream configuration unavailable");
    return result.status === 0 ? result.stdout.trim().split("\n") : [];
  };
  const remote = configured("--get-all", "branch.main.remote");
  const merge = configured("--get-all", "branch.main.merge");
  if (remote.length !== 1 || !/^[A-Za-z0-9_.-]+$/.test(remote[0]!) || remote[0] === "." ||
      merge.length !== 1 || merge[0] !== "refs/heads/main") throw new Error("Configured main upstream is unavailable");
  const fetch = configured("--get-all", `remote.${remote[0]}.url`);
  const pushConfigured = configured("--get-all", `remote.${remote[0]}.pushurl`);
  const push = pushConfigured.length ? pushConfigured : fetch;
  if (fetch.length !== 1 || push.length !== 1) throw new Error("Ambiguous upstream URLs");
  const parse = (url: string): CanonicalRepository => {
    const match = /^(?:https:\/\/([A-Za-z0-9.-]+)\/|ssh:\/\/git@([A-Za-z0-9.-]+)\/|git@([A-Za-z0-9.-]+):)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
    if (!match) throw new Error("Unsupported GitHub upstream URL");
    return { canonicalHost: (match[1] || match[2] || match[3])!.toLowerCase(), canonicalRepository: match[4]! };
  };
  const identity = parse(fetch[0]!);
  const pushIdentity = parse(push[0]!);
  if (identity.canonicalHost !== pushIdentity.canonicalHost || identity.canonicalRepository !== pushIdentity.canonicalRepository ||
      execFileSync("git", ["remote", "get-url", "--all", remote[0]!], { cwd, encoding: "utf8" }).trim() !== fetch[0] ||
      execFileSync("git", ["remote", "get-url", "--push", "--all", remote[0]!], { cwd, encoding: "utf8" }).trim() !== push[0])
    throw new Error("Conflicting upstream identity or URL rewrite");
  return Object.freeze(identity);
}

export interface PolicyIdentity {
  encodingVersion: 1;
  policyDigest: string;
  sourceCommit: string;
  roles: RoleSettings;
}

export interface PolicyBinding {
  policyDigest: string;
  sourceCommit: string;
  requirementsVersion: string;
}

function exactPolicy(value: unknown): RoleSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed role policy");
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).sort().join() !== "roles,schemaVersion" || policy.schemaVersion !== 1 ||
      !policy.roles || typeof policy.roles !== "object" || Array.isArray(policy.roles)) throw new Error("Malformed role policy");
  const configured = policy.roles as Record<string, unknown>;
  if (Object.keys(configured).sort().join() !== [...roles].sort().join()) throw new Error("Malformed role policy");
  const settings = {} as Record<typeof roles[number], Readonly<{ model: string; reasoningEffort: string }>>;
  for (const role of roles) {
    const setting = configured[role];
    if (!setting || typeof setting !== "object" || Array.isArray(setting) ||
        Object.keys(setting).sort().join() !== "model,reasoningEffort" ||
        !token((setting as Record<string, unknown>).model) ||
        !token((setting as Record<string, unknown>).reasoningEffort)) {
      throw new Error("Malformed role policy settings");
    }
    const value = setting as { model: string; reasoningEffort: string };
    settings[role] = Object.freeze({ model: value.model, reasoningEffort: value.reasoningEffort });
  }
  return Object.freeze(settings);
}

const encoding = (settings: RoleSettings) => JSON.stringify([1, 1, ...roles.map((role) =>
  [role, settings[role].model, settings[role].reasoningEffort])]);

/** Read only a full, verified commit object from the trusted checkout. */
export function policyFromCommit(repository: string, sourceCommit: string): PolicyIdentity {
  if (!commitPattern.test(sourceCommit)) throw new Error("A full approved policy commit is required");
  const cwd = resolve(repository);
  repositoryIdentity(cwd);
  const resolved = execFileSync("git", ["rev-parse", "--verify", `${sourceCommit}^{commit}`], { cwd, encoding: "utf8" }).trim();
  if (resolved !== sourceCommit) throw new Error("Policy source is not the verified commit");
  const source = execFileSync("git", ["show", `${sourceCommit}:${policyPath}`], { cwd, encoding: "utf8" });
  const settings = exactPolicy(JSON.parse(source));
  return Object.freeze({ encodingVersion: 1, policyDigest: createHash("sha256").update(encoding(settings)).digest("hex"),
    sourceCommit, roles: settings });
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
  beginAttempt(approvedCommit: string, approvalEvidence: string, identity: CanonicalRepository): Promise<PolicyGate>;
}

/** One local gate serializes policy promotion with reservation, capability checks and dispatch. */
export class PolicyCoordination implements PolicyCoordinator {
  constructor(private readonly repository: string, private readonly reservation: FileAttemptReservation,
    private readonly afterGateUnlink?: () => void) {}

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
      this.afterGateUnlink?.();
      await this.syncDirectory();
      await this.reservation.verifyDirectory();
    } };
  }

  private async active(): Promise<{ version: 1; policyDigest: string; sourceCommit: string; approvalEvidence: string } & CanonicalRepository> {
    {
      const value: unknown = JSON.parse(await this.readPrivate(this.activePath));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Corrupt active policy reference");
      const record = value as Record<string, unknown>;
      if (Object.keys(record).sort().join() !== "approvalEvidence,canonicalHost,canonicalRepository,policyDigest,sourceCommit,version" || record.version !== 1 ||
          typeof record.policyDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.policyDigest) ||
          typeof record.sourceCommit !== "string" || !commitPattern.test(record.sourceCommit) || !token(record.approvalEvidence) ||
          !token(record.canonicalHost) || !/^[A-Za-z0-9.-]+$/.test(record.canonicalHost) || !token(record.canonicalRepository) ||
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.canonicalRepository)) {
        throw new Error("Corrupt active policy reference");
      }
      return record as unknown as { version: 1; policyDigest: string; sourceCommit: string; approvalEvidence: string } & CanonicalRepository;
    }
  }

  async promote(sourceCommit: string, approvalEvidence: string): Promise<PolicyIdentity> {
    if (!token(approvalEvidence)) throw new Error("Explicit policy promotion approval evidence is required");
    const policy = policyFromCommit(this.repository, sourceCommit);
    const identity = repositoryIdentity(this.repository);
    const working = await readFile(join(this.repository, policyPath), "utf8");
    const committed = execFileSync("git", ["show", `${sourceCommit}:${policyPath}`], { cwd: this.repository, encoding: "utf8" });
    if (working !== committed) throw new Error("Working policy differs from approved commit");
    const gate = await this.acquire();
    let mutationStarted = false;
    try {
      try {
        const active = await this.active();
        if (active.canonicalHost !== identity.canonicalHost || active.canonicalRepository !== identity.canonicalRepository)
          throw new Error("Active policy belongs to another repository");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const name of await readdir(this.directory)) {
        if (name.endsWith(".reservation.json"))
          throw new Error("Retained attempt reservation requires explicit reconciliation before policy promotion");
      }
      const record = JSON.stringify({ version: 1, ...identity, policyDigest: policy.policyDigest, sourceCommit, approvalEvidence }) + "\n";
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

  async beginAttempt(approvedCommit: string, approvalEvidence: string, identity: CanonicalRepository): Promise<PolicyGate> {
    if (!token(approvalEvidence)) throw new Error("Explicit policy approval evidence is required");
    const expected = policyFromCommit(this.repository, approvedCommit);
    const repository = repositoryIdentity(this.repository);
    if (identity.canonicalHost !== repository.canonicalHost || identity.canonicalRepository !== repository.canonicalRepository)
      throw new Error("Attempt repository differs from canonical GitHub upstream");
    const gate = await this.acquire();
    const assertCurrent = async () => {
      await gate.verify();
      await this.reservation.verifyDirectory();
      const currentRepository = repositoryIdentity(this.repository);
      if (currentRepository.canonicalHost !== repository.canonicalHost ||
          currentRepository.canonicalRepository !== repository.canonicalRepository)
        throw new Error("Canonical GitHub upstream changed");
      const active = await this.active();
      if (active.canonicalHost !== repository.canonicalHost || active.canonicalRepository !== repository.canonicalRepository ||
          active.policyDigest !== expected.policyDigest || active.sourceCommit !== expected.sourceCommit ||
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
