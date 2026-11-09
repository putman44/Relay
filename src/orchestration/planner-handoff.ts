import { readFileSync } from "node:fs";
import { attemptDigest } from "./file-attempt-reservation.js";
import { type PolicyBinding, type PolicyCoordinator, type PolicyGate } from "./policy-coordination.js";
import { z } from "zod";
import {
  AGENT_RESPONSE_SCHEMA_VERSION,
  PlannerResponseSchema,
  validateResponseContext,
  type PlannerResponse,
} from "./contracts.js";

const Text = z.string().min(1).refine((value) => value.trim().length > 0);
const Token = Text.refine((value) => value.trim() === value);
const RoleSetting = z.strictObject({ model: Token, reasoningEffort: Token });
const RolePolicy = z.strictObject({
  schemaVersion: z.literal(1),
  roles: z.strictObject({
    planner: RoleSetting,
    implementer: RoleSetting,
    reviewer: RoleSetting,
  }),
});
type Role = keyof z.infer<typeof RolePolicy>["roles"];

const TrustedInput = z.strictObject({
  issueNumber: z.number().int().positive(),
  approvedIssueBody: Text,
  canonicalHost: z.string().regex(/^[A-Za-z0-9.-]+$/),
  canonicalRepository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  approvalEvidence: Token,
  runId: Token,
  taskId: Token,
  attemptId: Token,
  requirementsVersion: Token,
  approvedPolicyCommit: z.string().regex(/^[0-9a-f]{40}$/),
  approvedPolicyEvidence: Token,
});
export type PlannerHandoffContext = z.infer<typeof TrustedInput>;

export interface RoleCapabilityProof {
  role: Role;
  model: string;
  reasoningEffort: string;
  freshIndependentContext: true;
}

export interface PlannerDispatchRequest extends PlannerHandoffContext {
  role: "planner";
  model: string;
  reasoningEffort: string;
  freshIndependentContext: true;
  policyDigest: string;
  policySourceCommit: string;
}

export interface PlannerHost {
  checkCapability(role: Role, setting: Readonly<{ model: string; reasoningEffort: string }>): Promise<unknown>;
  dispatchPlanner(request: Readonly<PlannerDispatchRequest>): Promise<unknown>;
}

export type PlannerAttemptIdentity = Pick<PlannerHandoffContext,
  "canonicalHost" | "canonicalRepository" | "issueNumber" | "runId" | "taskId" | "attemptId">;

/** Inject only a trusted provider whose reservation is atomic and retained for reconciliation. */
export interface TrustedAttemptReservation {
  reserveAttempt(identity: Readonly<PlannerAttemptIdentity>, policy: Readonly<PolicyBinding>): Promise<unknown>;
}

const ResponseEnvelope = z.strictObject({
  issueNumber: TrustedInput.shape.issueNumber,
  canonicalHost: Text,
  canonicalRepository: Text,
  response: z.unknown(),
});

export type PlannerHandoffResult =
  | { status: "READY"; response: Extract<PlannerResponse, { status: "READY" }> }
  | { status: "BLOCKED"; response: Extract<PlannerResponse, { status: "BLOCKED" }> }
  | { status: "STOP"; code: "INVALID_TRUSTED_CONTEXT" | "MALFORMED_ROLE_POLICY" |
      "HOST_DISPATCH_UNAVAILABLE" | "CAPABILITY_UNPROVEN" | "DUPLICATE_ATTEMPT" |
      "RESERVATION_UNAVAILABLE" | "RESERVATION_OUTCOME_AMBIGUOUS" |
      "DISPATCH_OUTCOME_AMBIGUOUS" | "MALFORMED_RESPONSE" | "IDENTITY_MISMATCH" |
      "POLICY_COORDINATION_UNAVAILABLE" | "POLICY_IDENTITY_MISMATCH";
    detail: string };

const stop = (code: Extract<PlannerHandoffResult, { status: "STOP" }>["code"], detail: string): PlannerHandoffResult =>
  ({ status: "STOP", code, detail });

/** No production reservation or host adapter is supplied by this dry-run boundary. */
export function createPlannerHandoff(host?: PlannerHost, reservation?: TrustedAttemptReservation, coordination?: PolicyCoordinator) {
  const attempted = new Set<string>();
  return async (context: PlannerHandoffContext, policy: unknown): Promise<PlannerHandoffResult> => {
    const input = TrustedInput.safeParse(context);
    if (!input.success) return stop("INVALID_TRUSTED_CONTEXT", "Trusted issue or execution context is incomplete or malformed");
    const configured = RolePolicy.safeParse(policy);
    if (!configured.success) return stop("MALFORMED_ROLE_POLICY", "Complete exact role policy is required");
    let repositoryPolicy: unknown;
    try {
      repositoryPolicy = JSON.parse(readFileSync(new URL("../../.agents/relay-orchestration-policy.json", import.meta.url), "utf8"));
    } catch {
      return stop("MALFORMED_ROLE_POLICY", "Authoritative repository role policy is unavailable");
    }
    const authoritative = RolePolicy.safeParse(repositoryPolicy);
    if (!authoritative.success || JSON.stringify(configured.data) !== JSON.stringify(authoritative.data))
      return stop("MALFORMED_ROLE_POLICY", "Role policy does not match the authoritative repository policy");
    // Snapshot every configured value before a host callback can observe policy state.
    const expected = Object.freeze({
      planner: Object.freeze({ ...authoritative.data.roles.planner }),
      implementer: Object.freeze({ ...authoritative.data.roles.implementer }),
      reviewer: Object.freeze({ ...authoritative.data.roles.reviewer }),
    });
    if (!host || typeof host.checkCapability !== "function" || typeof host.dispatchPlanner !== "function")
      return stop("HOST_DISPATCH_UNAVAILABLE", "No verified host dispatcher is installed");
    if (!reservation || typeof reservation.reserveAttempt !== "function")
      return stop("RESERVATION_UNAVAILABLE", "No trusted atomic attempt reservation is installed");
    if (!coordination) return stop("POLICY_COORDINATION_UNAVAILABLE", "No durable local policy coordination gate is installed");

    const trusted = input.data;
    const attemptIdentity: PlannerAttemptIdentity = Object.freeze({
      canonicalHost: trusted.canonicalHost,
      canonicalRepository: trusted.canonicalRepository,
      issueNumber: trusted.issueNumber,
      runId: trusted.runId,
      taskId: trusted.taskId,
      attemptId: trusted.attemptId,
    });
    const key = JSON.stringify(attemptIdentity);
    if (attempted.has(key)) return stop("DUPLICATE_ATTEMPT", "This execution attempt was already invoked");
    // This local hold also prevents a second call after an uncertain reservation result.
    attempted.add(key);
    let gate: PolicyGate;
    try {
      gate = await coordination.beginAttempt(trusted.approvedPolicyCommit, trusted.approvedPolicyEvidence);
    } catch {
      return stop("POLICY_IDENTITY_MISMATCH", "Approved active policy or coordination gate is unavailable; reconcile any held gate");
    }
    try {
      if (JSON.stringify(configured.data.roles) !== JSON.stringify(gate.policy.roles))
        throw new Error("Configured policy differs from approved commit");
      await gate.assertCurrent();
    } catch {
      try { await gate.releaseWithoutClaim(); }
      catch { return stop("RESERVATION_OUTCOME_AMBIGUOUS", "Pre-reservation gate cleanup is uncertain"); }
      return stop("POLICY_IDENTITY_MISMATCH", "Configured policy differs from the approved active policy");
    }
    const binding: PolicyBinding = Object.freeze({ policyDigest: gate.policy.policyDigest,
      sourceCommit: gate.policy.sourceCommit, requirementsVersion: trusted.requirementsVersion });
    const cleanStop = async (code: Extract<PlannerHandoffResult, { status: "STOP" }>["code"], detail: string, claimed: boolean) => {
      try {
        if (claimed) await gate.complete("NO_DISPATCH", attemptDigest(attemptIdentity));
        else await gate.releaseWithoutClaim();
      } catch {
        return stop("RESERVATION_OUTCOME_AMBIGUOUS", "Coordination cleanup is uncertain and requires reconciliation");
      }
      return stop(code, detail);
    };
    // Reserve before the first host call. Unknown reservation outcomes remain held, never retried.
    let reserved: unknown;
    try {
      reserved = await reservation.reserveAttempt(attemptIdentity, binding);
    } catch {
      return stop("RESERVATION_OUTCOME_AMBIGUOUS", "Attempt reservation outcome requires reconciliation");
    }
    if (reserved === "ALREADY_RESERVED") return cleanStop("DUPLICATE_ATTEMPT", "This execution attempt was already reserved", false);
    if (reserved !== "RESERVED")
      return stop("RESERVATION_OUTCOME_AMBIGUOUS", "Attempt reservation outcome requires reconciliation");

    for (const role of ["planner", "implementer", "reviewer"] as const) {
      try { await gate.assertCurrent(); } catch { return stop("POLICY_IDENTITY_MISMATCH", "Policy changed during capability verification"); }
      const setting = expected[role];
      let mutationAttempted = false;
      const immutableSetting = new Proxy(setting, {
        set: () => { mutationAttempted = true; return false; },
        defineProperty: () => { mutationAttempted = true; return false; },
        deleteProperty: () => { mutationAttempted = true; return false; },
      });
      let proof: unknown;
      try {
        proof = await host.checkCapability(role, immutableSetting);
      } catch {
        return cleanStop("CAPABILITY_UNPROVEN", `Host capability proof failed for ${role}`, true);
      }
      try { await gate.assertCurrent(); } catch { return stop("POLICY_IDENTITY_MISMATCH", "Policy changed while capability check was pending"); }
      if (mutationAttempted) return cleanStop("CAPABILITY_UNPROVEN", `Host attempted to alter ${role} settings`, true);
      const parsed = z.strictObject({
        role: z.literal(role),
        model: z.literal(setting.model),
        reasoningEffort: z.literal(setting.reasoningEffort),
        freshIndependentContext: z.literal(true),
      }).safeParse(proof);
      if (!parsed.success) return cleanStop("CAPABILITY_UNPROVEN", `Exact model, effort, and fresh context are unproven for ${role}`, true);
    }

    const planner = expected.planner;
    const request: PlannerDispatchRequest = Object.freeze({
      ...trusted,
      role: "planner",
      model: planner.model,
      reasoningEffort: planner.reasoningEffort,
      freshIndependentContext: true,
      policyDigest: binding.policyDigest,
      policySourceCommit: binding.sourceCommit,
    });
    try { await gate.assertCurrent(); } catch { return stop("POLICY_IDENTITY_MISMATCH", "Policy changed immediately before dispatch"); }
    let raw: unknown;
    try {
      raw = await host.dispatchPlanner(request);
    } catch {
      return stop("DISPATCH_OUTCOME_AMBIGUOUS", "Host dispatch threw; outcome requires reconciliation");
    }
    try { await gate.assertCurrent(); } catch { return stop("POLICY_IDENTITY_MISMATCH", "Policy changed during dispatch; outcome requires reconciliation"); }
    const envelope = ResponseEnvelope.safeParse(raw);
    if (!envelope.success) return stop("MALFORMED_RESPONSE", "Host response envelope is missing or malformed");
    if (envelope.data.issueNumber !== trusted.issueNumber ||
      envelope.data.canonicalHost !== trusted.canonicalHost ||
      envelope.data.canonicalRepository !== trusted.canonicalRepository)
      return stop("IDENTITY_MISMATCH", "Host envelope does not match the trusted GitHub issue and repository");
    const response = PlannerResponseSchema.safeParse(envelope.data.response);
    if (!response.success) return stop("MALFORMED_RESPONSE", "Planner response does not match the contract");
    const identity = validateResponseContext(response.data, {
      schemaVersion: AGENT_RESPONSE_SCHEMA_VERSION,
      runId: trusted.runId,
      taskId: trusted.taskId,
      attemptId: trusted.attemptId,
      requirementsVersion: trusted.requirementsVersion,
      expectedRole: "planner",
    });
    if (!identity.valid) return stop("IDENTITY_MISMATCH", identity.errors.join("; "));
    if (response.data.status === "READY") {
      const requirements = response.data.evidenceReferences.filter((reference) => reference.kind === "REQUIREMENTS");
      const expectedLocator = `https://${trusted.canonicalHost}/${trusted.canonicalRepository}/issues/${trusted.issueNumber}`;
      if (requirements.length === 0 || requirements.some((reference) => reference.locator !== expectedLocator))
        return stop("IDENTITY_MISMATCH", "Planner READY requirements evidence does not identify the approved GitHub issue");
    }
    // Planner data is advisory. A READY result grants no later dispatch or mutation authority.
    try { await gate.complete("VALIDATED_RESPONSE", attemptDigest(attemptIdentity)); }
    catch { return stop("RESERVATION_OUTCOME_AMBIGUOUS", "Completion evidence or gate cleanup is uncertain"); }
    return response.data.status === "READY"
      ? { status: "READY", response: response.data }
      : { status: "BLOCKED", response: response.data };
  };
}
