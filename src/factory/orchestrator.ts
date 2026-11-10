import { createHash, randomUUID } from "node:crypto";
import { PlannerResponseSchema } from "../orchestration/contracts.js";
import { runApiPlanner } from "./agents/planner.js";
import { RepositorySchema, TrustedProjectConfigurationSchema, validateProjectContext } from "./project-context.js";
import { loadRepositoryContext } from "./repository-context.js";
import { selectIssueContext } from "./context-selection.js";

export async function preparePlannerHandoff(
  selectedNumber: number,
  repository: string,
  apiKey: string,
  readIssue: (number: number, repository: string) => Promise<unknown>,
  send: typeof fetch,
  trustedConfiguration: unknown,
  sourceSelection?: { checkoutPath: string; paths: readonly string[] } | { checkoutPath: string; approvalToken: string },
) {
  if (!Number.isSafeInteger(selectedNumber) || selectedNumber < 1) throw new Error("Select one positive issue number");
  RepositorySchema.parse(repository);
  const configuration = TrustedProjectConfigurationSchema.parse(trustedConfiguration);
  if (configuration.repository !== repository) throw new Error("Trusted project configuration repository mismatch");
  const { issue, issueUrl } = validateProjectContext({
    repository, issueNumber: selectedNumber, issue: await readIssue(selectedNumber, repository),
    trustedConfiguration: configuration,
  });
  const identity = {
    schemaVersion: 1 as const,
    runId: randomUUID(),
    taskId: `issue-${selectedNumber}-planner`,
    attemptId: randomUUID(),
    requirementsVersion: createHash("sha256").update(`${issueUrl}\n${issue.body}`).digest("hex"),
  };
  const repositoryContext = sourceSelection && "approvalToken" in sourceSelection
    ? (() => {
      const selection = selectIssueContext({ repository, issueNumber: selectedNumber, issue,
        trustedConfiguration: configuration, checkoutPath: sourceSelection.checkoutPath });
      if (selection.approvalToken !== sourceSelection.approvalToken)
        throw new Error("Approved context does not match current issue or files; preview again");
      return selection.files;
    })()
    : sourceSelection
      ? loadRepositoryContext(sourceSelection.checkoutPath, repository, sourceSelection.paths) : undefined;
  const report = await runApiPlanner({ issueBody: issue.body, issueUrl, identity,
    ...(repositoryContext ? { repositoryContext } : {}) }, apiKey, send);
  if (report.result !== "PASS") throw new Error(`Planner failed validation: ${report.errors.join("; ")}`);
  const response = PlannerResponseSchema.parse(report.response);
  if (response.evidenceReferences.some((reference) => reference.kind !== "REQUIREMENTS"))
    throw new Error("Planner returned unsupported evidence reference");
  if (response.evidenceReferences.some((reference) => reference.locator !== issueUrl))
    throw new Error("Planner requirements evidence does not match the selected issue");
  if (response.status === "BLOCKED") return { status: "BLOCKED" as const, response, selectedPaths: repositoryContext?.map((file) => file.path) ?? [] };
  return {
    status: "READY" as const,
    selectedPaths: repositoryContext?.map((file) => file.path) ?? [],
    artifact: {
      kind: "relay-v3-planner-implementer-handoff" as const,
      advisoryOnly: true as const,
      implementerDispatchAuthorized: false as const,
      issue: { number: issue.number, title: issue.title, body: issue.body, url: issueUrl, repository },
      identity,
      planner: response,
    },
  };
}
