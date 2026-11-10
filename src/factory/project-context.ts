import { z } from "zod";

export const RepositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const IssueSchema = z.strictObject({
  number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string().min(1),
});
export const TrustedProjectConfigurationSchema = z.strictObject({
  repository: RepositorySchema,
  planner: z.strictObject({
    model: z.literal("gpt-6.1-sol"),
    reasoningEffort: z.literal("medium"),
  }),
});
export type TrustedProjectConfiguration = z.infer<typeof TrustedProjectConfigurationSchema>;

export const ProjectContextSchema = z.strictObject({
  repository: RepositorySchema,
  issueNumber: z.number().int().positive(),
  issue: IssueSchema,
  trustedConfiguration: TrustedProjectConfigurationSchema,
});
export type ProjectContext = z.infer<typeof ProjectContextSchema>;

/** Bind supplied issue content to the explicitly selected repository and issue. */
export function validateProjectContext(input: unknown) {
  const context = ProjectContextSchema.parse(input);
  if (context.issue.number !== context.issueNumber) throw new Error("Selected issue identity mismatch");
  if (context.trustedConfiguration.repository !== context.repository)
    throw new Error("Trusted project configuration repository mismatch");
  return { ...context, issueUrl: `https://github.com/${context.repository}/issues/${context.issueNumber}` };
}
