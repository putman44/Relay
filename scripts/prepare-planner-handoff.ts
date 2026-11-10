import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PlannerResponseSchema } from "../src/orchestration/contracts.js";
import { runApiPlanner } from "./run-api-planner.js";

const Issue = z.strictObject({ number: z.number().int().positive(), title: z.string().min(1), body: z.string().min(1) });
const Repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
type IssueData = z.infer<typeof Issue>;

export async function preparePlannerHandoff(
  selectedNumber: number,
  repository: string,
  apiKey: string,
  readIssue: (number: number, repository: string) => Promise<unknown>,
  send: typeof fetch = fetch,
) {
  if (!Number.isSafeInteger(selectedNumber) || selectedNumber < 1) throw new Error("Select one positive issue number");
  Repository.parse(repository);
  const issue = Issue.parse(await readIssue(selectedNumber, repository));
  if (issue.number !== selectedNumber) throw new Error("Selected issue identity mismatch");
  const issueUrl = `https://github.com/${repository}/issues/${selectedNumber}`;
  const identity = {
    schemaVersion: 1 as const,
    runId: randomUUID(),
    taskId: `issue-${selectedNumber}-planner`,
    attemptId: randomUUID(),
    requirementsVersion: createHash("sha256").update(`${issueUrl}\n${issue.body}`).digest("hex"),
  };
  const report = await runApiPlanner({ issueBody: issue.body, issueUrl, identity }, apiKey, send);
  if (report.result !== "PASS") throw new Error(`Planner failed validation: ${report.errors.join("; ")}`);
  const response = PlannerResponseSchema.parse(report.response);
  if (response.evidenceReferences.some((reference) => reference.kind !== "REQUIREMENTS"))
    throw new Error("Planner returned unsupported evidence reference");
  if (response.evidenceReferences.some((reference) => reference.locator !== issueUrl))
    throw new Error("Planner requirements evidence does not match the selected issue");
  if (response.status === "BLOCKED") return { status: "BLOCKED" as const, response };
  return {
    status: "READY" as const,
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

function readGithubIssue(number: number, repository: string): IssueData {
  const output = execFileSync("gh", ["issue", "view", String(number), "--repo", repository,
    "--json", "number,title,body"], { encoding: "utf8" });
  return Issue.parse(JSON.parse(output));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 7 || args[0] !== "--issue" || args[2] !== "--repo" ||
      args[4] !== "--output" || args[6] !== "--allow-live-api")
    throw new Error("Usage: npx tsx scripts/prepare-planner-handoff.ts --issue N --repo owner/repo --output path --allow-live-api");
  const policy = JSON.parse(readFileSync(new URL("../.agents/relay-orchestration-policy.json", import.meta.url), "utf8"));
  if (policy?.roles?.planner?.model !== "gpt-6.1-sol" || policy?.roles?.planner?.reasoningEffort !== "medium")
    throw new Error("API Planner model and effort do not match repository policy");
  const result = await preparePlannerHandoff(Number(args[1]), args[3]!, process.env.OPENAI_API_KEY ?? "",
    async (number, repository) => readGithubIssue(number, repository));
  if (result.status === "BLOCKED") {
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = 1;
    return;
  }
  writeFileSync(args[5]!, JSON.stringify(result.artifact, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: "READY", artifactPath: args[5] }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : "Unknown handoff failure") + "\n");
    process.exitCode = 1;
  });
