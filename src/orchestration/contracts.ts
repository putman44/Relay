import { z } from "zod";

// Structure is deliberately distinct from authorization and evidence verification.
export const AGENT_RESPONSE_SCHEMA_VERSION = 1 as const;

const NonEmptyText = z.string().trim().min(1);
const CommitSha = z.string().regex(/^[0-9a-f]{40}$/);

export const ExecutionIdentitySchema = z.strictObject({
  schemaVersion: z.literal(AGENT_RESPONSE_SCHEMA_VERSION),
  runId: NonEmptyText,
  // For a planner response, this identifies the invocation, not a task it proposes.
  taskId: NonEmptyText,
  attemptId: NonEmptyText,
  requirementsVersion: NonEmptyText,
});

export const EvidenceReferenceSchema = ExecutionIdentitySchema.extend({
  referenceId: NonEmptyText,
  kind: z.enum(["REPOSITORY", "REQUIREMENTS", "CHECK", "INVESTIGATION"]),
  locator: NonEmptyText,
  commitSha: CommitSha.optional(),
});

const PlannerEvidenceReferenceSchema = EvidenceReferenceSchema.extend({
  kind: z.literal("REQUIREMENTS"),
});

const CommitEvidenceReferenceSchema = EvidenceReferenceSchema.required({
  commitSha: true,
});

export const VerificationEvidenceSchema = CommitEvidenceReferenceSchema.extend({
  kind: z.literal("CHECK"),
  check: NonEmptyText,
  result: z.enum(["PASSED", "FAILED", "INCOMPLETE"]),
  environment: NonEmptyText,
  configuration: NonEmptyText,
});

// These IDs name proposed internal tasks. They may differ from the planner invocation taskId.
// Queue membership and dependency validity are orchestrator policy, not response shape.
const TaskPlanSchema = z.strictObject({
  taskId: NonEmptyText,
  summary: NonEmptyText,
  dependencies: z.array(NonEmptyText),
  fileScope: z.array(NonEmptyText).min(1),
  complexity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
  verificationRequirements: z.array(NonEmptyText).min(1),
});

export const PlannerResponseSchema = z.discriminatedUnion("status", [
  ExecutionIdentitySchema.extend({
    role: z.literal("planner"),
    status: z.literal("READY"),
    plan: z.strictObject({
      summary: NonEmptyText,
      tasks: z.array(TaskPlanSchema).min(1),
    }),
    evidenceReferences: z.array(PlannerEvidenceReferenceSchema).min(1),
  }),
  ExecutionIdentitySchema.extend({
    role: z.literal("planner"),
    status: z.literal("BLOCKED"),
    reason: NonEmptyText,
    evidenceReferences: z.array(PlannerEvidenceReferenceSchema).min(1),
    recommendedNextAction: NonEmptyText,
  }),
]);

export const ImplementerResponseSchema = z.discriminatedUnion("status", [
  ExecutionIdentitySchema.extend({
    role: z.literal("implementer"),
    status: z.literal("COMPLETED"),
    commitSha: CommitSha,
    changedFiles: z.array(NonEmptyText).min(1),
    verificationEvidence: z.array(VerificationEvidenceSchema).min(1),
  }),
  ExecutionIdentitySchema.extend({
    role: z.literal("implementer"),
    status: z.literal("BLOCKED"),
    reason: NonEmptyText,
    evidenceReferences: z.array(EvidenceReferenceSchema).min(1),
    recommendedNextAction: NonEmptyText,
  }),
]);

export const ReviewerFindingSchema = z.strictObject({
  findingId: NonEmptyText,
  classification: z.enum([
    "IMPLEMENTATION_DEFECT",
    "REQUIREMENTS_AMBIGUITY",
    "UNVERIFIED_TECHNICAL_CONCERN",
    "REQUIREMENTS_DEFECT",
  ]),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  summary: NonEmptyText,
  technicalEvidence: z.array(CommitEvidenceReferenceSchema).min(1),
  recommendedAction: NonEmptyText,
});

const ReviewCoverageSchema = z.strictObject({
  filesExamined: z.array(NonEmptyText).min(1),
  requirementsEvaluated: z.array(NonEmptyText).min(1),
  behaviorsEvaluated: z.array(NonEmptyText).min(1),
  verificationChecks: z.array(VerificationEvidenceSchema).min(1),
  limitations: z.array(NonEmptyText),
});

const BlockedReviewCoverageSchema = z.strictObject({
  filesExamined: z.array(NonEmptyText),
  requirementsEvaluated: z.array(NonEmptyText),
  behaviorsEvaluated: z.array(NonEmptyText),
  verificationChecks: z.array(VerificationEvidenceSchema),
  limitations: z.array(NonEmptyText),
});

export const ReviewerResponseSchema = z.discriminatedUnion("status", [
  ExecutionIdentitySchema.extend({
    role: z.literal("reviewer"),
    status: z.literal("PASSED"),
    commitSha: CommitSha,
    coverage: ReviewCoverageSchema,
    evidenceReferences: z.array(CommitEvidenceReferenceSchema).min(1),
  }),
  ExecutionIdentitySchema.extend({
    role: z.literal("reviewer"),
    status: z.literal("BLOCKED"),
    commitSha: CommitSha,
    coverage: BlockedReviewCoverageSchema,
    reasons: z
      .array(
        z.enum([
          "IMPLEMENTATION_DEFECT",
          "REQUIREMENTS_AMBIGUITY",
          "UNVERIFIED_TECHNICAL_CONCERN",
          "REQUIREMENTS_DEFECT",
          "INCOMPLETE_VERIFICATION",
        ]),
      )
      .min(1),
    findings: z.array(ReviewerFindingSchema).min(1),
    evidenceReferences: z.array(CommitEvidenceReferenceSchema).min(1),
    recommendedNextActions: z.array(NonEmptyText).min(1),
  }).refine(
    (response) =>
      !response.reasons.includes("INCOMPLETE_VERIFICATION") ||
      response.coverage.limitations.length > 0,
    {
      path: ["coverage", "limitations"],
      message: "Incomplete verification must identify its limitations",
    },
  ),
]);

export const AgentResponseSchema = z.union([
  PlannerResponseSchema,
  ImplementerResponseSchema,
  ReviewerResponseSchema,
]);

export type ExecutionIdentity = z.infer<typeof ExecutionIdentitySchema>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type PlannerResponse = z.infer<typeof PlannerResponseSchema>;
export type ImplementerResponse = z.infer<typeof ImplementerResponseSchema>;
export type ReviewerResponse = z.infer<typeof ReviewerResponseSchema>;
export type AgentResponse =
  | PlannerResponse
  | ImplementerResponse
  | ReviewerResponse;

export type TrustedResponseContext = ExecutionIdentity & {
  expectedRole: AgentResponse["role"];
  expectedCommitSha?: string;
};

export type ContextValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

/** Compare parsed agent claims with orchestrator-owned state. This does not authorize advancement. */
export function validateResponseContext(
  response: AgentResponse,
  trusted: TrustedResponseContext,
): ContextValidationResult {
  const errors: string[] = [];
  const compareIdentity = (
    value: ExecutionIdentity,
    location: string,
  ): void => {
    for (const field of [
      "schemaVersion",
      "runId",
      "taskId",
      "attemptId",
      "requirementsVersion",
    ] as const) {
      if (value[field] !== trusted[field])
        errors.push(`${location}.${field} does not match trusted execution`);
    }
  };
  const compareEvidence = (
    references: readonly EvidenceReference[],
    expectedCommitSha?: string,
  ): void => {
    for (const [index, reference] of references.entries()) {
      compareIdentity(reference, `evidence[${index}]`);
      if (
        expectedCommitSha !== undefined &&
        reference.commitSha !== expectedCommitSha
      ) {
        errors.push(
          `evidence[${index}].commitSha does not match the response commit`,
        );
      }
    }
  };

  compareIdentity(response, "response");
  if (response.role !== trusted.expectedRole)
    errors.push("response.role does not match assigned role");

  if (response.role === "planner") {
    compareEvidence(response.evidenceReferences);
  } else if (response.role === "implementer") {
    if (response.status === "COMPLETED") {
      if (
        trusted.expectedCommitSha !== undefined &&
        response.commitSha !== trusted.expectedCommitSha
      ) {
        errors.push("response.commitSha does not match trusted commit");
      }
      compareEvidence(response.verificationEvidence, response.commitSha);
    } else {
      compareEvidence(response.evidenceReferences);
    }
  } else {
    if (trusted.expectedCommitSha === undefined) {
      errors.push("trusted commit is required for reviewer responses");
    } else if (response.commitSha !== trusted.expectedCommitSha) {
      errors.push("response.commitSha does not match trusted commit");
    }
    compareEvidence(response.evidenceReferences, response.commitSha);
    compareEvidence(response.coverage.verificationChecks, response.commitSha);
    if (response.status === "BLOCKED") {
      for (const finding of response.findings)
        compareEvidence(finding.technicalEvidence, response.commitSha);
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
