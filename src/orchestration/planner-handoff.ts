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
}

export interface PlannerHost {
  checkCapability(role: Role, setting: Readonly<{ model: string; reasoningEffort: string }>): Promise<unknown>;
  dispatchPlanner(request: Readonly<PlannerDispatchRequest>): Promise<unknown>;
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
      "DISPATCH_OUTCOME_AMBIGUOUS" | "MALFORMED_RESPONSE" | "IDENTITY_MISMATCH";
    detail: string };

const stop = (code: Extract<PlannerHandoffResult, { status: "STOP" }>["code"], detail: string): PlannerHandoffResult =>
  ({ status: "STOP", code, detail });

/** One instance owns one in-memory attempt registry. A durable caller must prevent duplicates across instances. */
export function createPlannerHandoff(host?: PlannerHost) {
  const attempted = new Set<string>();
  return async (context: PlannerHandoffContext, policy: unknown): Promise<PlannerHandoffResult> => {
    const input = TrustedInput.safeParse(context);
    if (!input.success) return stop("INVALID_TRUSTED_CONTEXT", "Trusted issue or execution context is incomplete or malformed");
    const configured = RolePolicy.safeParse(policy);
    if (!configured.success) return stop("MALFORMED_ROLE_POLICY", "Complete exact role policy is required");
    // Snapshot every configured value before a host callback can observe policy state.
    const expected = Object.freeze({
      planner: Object.freeze({ ...configured.data.roles.planner }),
      implementer: Object.freeze({ ...configured.data.roles.implementer }),
      reviewer: Object.freeze({ ...configured.data.roles.reviewer }),
    });
    if (!host || typeof host.checkCapability !== "function" || typeof host.dispatchPlanner !== "function")
      return stop("HOST_DISPATCH_UNAVAILABLE", "No verified host dispatcher is installed");

    const trusted = input.data;
    const key = JSON.stringify([trusted.runId, trusted.taskId, trusted.attemptId]);
    if (attempted.has(key)) return stop("DUPLICATE_ATTEMPT", "This execution attempt was already invoked");
    // Reserve before the first host call. Unknown outcomes remain held, never retried.
    attempted.add(key);

    for (const role of ["planner", "implementer", "reviewer"] as const) {
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
        return stop("CAPABILITY_UNPROVEN", `Host capability proof failed for ${role}`);
      }
      if (mutationAttempted) return stop("CAPABILITY_UNPROVEN", `Host attempted to alter ${role} settings`);
      const parsed = z.strictObject({
        role: z.literal(role),
        model: z.literal(setting.model),
        reasoningEffort: z.literal(setting.reasoningEffort),
        freshIndependentContext: z.literal(true),
      }).safeParse(proof);
      if (!parsed.success) return stop("CAPABILITY_UNPROVEN", `Exact model, effort, and fresh context are unproven for ${role}`);
    }

    const planner = expected.planner;
    const request: PlannerDispatchRequest = Object.freeze({
      ...trusted,
      role: "planner",
      model: planner.model,
      reasoningEffort: planner.reasoningEffort,
      freshIndependentContext: true,
    });
    let raw: unknown;
    try {
      raw = await host.dispatchPlanner(request);
    } catch {
      return stop("DISPATCH_OUTCOME_AMBIGUOUS", "Host dispatch threw; outcome requires reconciliation");
    }
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
    // Planner data is advisory. A READY result grants no later dispatch or mutation authority.
    return response.data.status === "READY"
      ? { status: "READY", response: response.data }
      : { status: "BLOCKED", response: response.data };
  };
}
