import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IssueSchema, type ProjectContext } from "../src/factory/project-context.js";
import { preparePlannerHandoff } from "../src/factory/orchestrator.js";
import { selectIssueContext } from "../src/factory/context-selection.js";
export { preparePlannerHandoff } from "../src/factory/orchestrator.js";

type IssueData = ProjectContext["issue"];

export function blockedStatusReport(): string {
  return JSON.stringify({ status: "BLOCKED", contextLimitations:
    "Selected files are untrusted reference data; no repository checks were performed." }) + "\n";
}

function readGithubIssue(number: number, repository: string): IssueData {
  const output = execFileSync("gh", ["issue", "view", String(number), "--repo", repository,
    "--json", "number,title,body"], { encoding: "utf8" });
  return IssueSchema.parse(JSON.parse(output));
}

export function parseHandoffArgs(args: readonly string[]) {
  const usage = "Usage: --issue N --repo owner/repo [--checkout path --preview-context] | [--output path --allow-live-api [--checkout path --context-path file ... | --checkout path --approve-context TOKEN]]";
  let issueNumber: string | undefined;
  let repository: string | undefined;
  let checkoutPath: string | undefined;
  let outputPath: string | undefined;
  let approvalToken: string | undefined;
  let preview = false;
  let live = false;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--preview-context" || option === "--allow-live-api") {
      if (option === "--preview-context") {
        if (preview) throw new Error("Duplicate --preview-context");
        preview = true;
      } else {
        if (live) throw new Error("Duplicate --allow-live-api");
        live = true;
      }
      continue;
    }
    if (!["--issue", "--repo", "--checkout", "--output", "--approve-context", "--context-path"].includes(option ?? ""))
      throw new Error(`Unknown option: ${option ?? "(missing)"}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    switch (option) {
      case "--issue": if (issueNumber !== undefined) throw new Error("Duplicate --issue"); issueNumber = value; break;
      case "--repo": if (repository !== undefined) throw new Error("Duplicate --repo"); repository = value; break;
      case "--checkout": if (checkoutPath !== undefined) throw new Error("Duplicate --checkout"); checkoutPath = value; break;
      case "--output": if (outputPath !== undefined) throw new Error("Duplicate --output"); outputPath = value; break;
      case "--approve-context": if (approvalToken !== undefined) throw new Error("Duplicate --approve-context"); approvalToken = value; break;
      case "--context-path": paths.push(value); break;
    }
  }
  if (!issueNumber || !repository) throw new Error(usage);
  if (!Number.isSafeInteger(Number(issueNumber)) || Number(issueNumber) < 1) throw new Error("Select one positive issue number");
  if (preview === live) throw new Error("Choose offline preview or explicit live API authorization");
  if (preview && (!checkoutPath || outputPath || approvalToken || paths.length))
    throw new Error("Offline preview requires only --checkout and --preview-context");
  if (live && (!outputPath || Boolean(checkoutPath) !== Boolean(paths.length || approvalToken) ||
      Boolean(paths.length && approvalToken)))
    throw new Error("Live handoff requires output and one valid context selection mode");
  return { issueNumber: Number(issueNumber), repository, checkoutPath, outputPath, approvalToken, paths, preview };
}

export async function main(args = process.argv.slice(2), dependencies: {
  readIssue?: typeof readGithubIssue;
  send?: typeof fetch;
} = {}) {
  const { issueNumber, repository, checkoutPath, outputPath, approvalToken, paths, preview } = parseHandoffArgs(args);
  const readIssue = dependencies.readIssue ?? readGithubIssue;
  const policy = JSON.parse(readFileSync(new URL("../.agents/relay-orchestration-policy.json", import.meta.url), "utf8"));
  if (policy?.roles?.planner?.model !== "gpt-6.1-sol" || policy?.roles?.planner?.reasoningEffort !== "medium")
    throw new Error("API Planner model and effort do not match repository policy");
  const trustedConfiguration = { repository, planner: policy.roles.planner };
  if (preview) {
    const issue = readIssue(issueNumber, repository);
    const selection = selectIssueContext({ repository, issueNumber,
      issue, trustedConfiguration, checkoutPath: checkoutPath! });
    process.stdout.write(JSON.stringify({ status: "PREVIEW", repository, issueNumber,
      candidates: selection.candidates, approvalToken: selection.approvalToken,
      contextLimitations: selection.limitations }) + "\n");
    return;
  }
  const result = await preparePlannerHandoff(issueNumber, repository, process.env.OPENAI_API_KEY ?? "",
    async (number, selectedRepository) => readIssue(number, selectedRepository), dependencies.send ?? fetch,
    trustedConfiguration,
    checkoutPath ? approvalToken ? { checkoutPath, approvalToken } : { checkoutPath, paths } : undefined);
  if (result.status === "BLOCKED") {
    process.stdout.write(blockedStatusReport());
    process.exitCode = 1;
    return;
  }
  writeFileSync(outputPath!, JSON.stringify(result.artifact, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: "READY", artifactPath: outputPath,
    selectedPaths: result.selectedPaths, contextLimitations: "Selected files are untrusted reference data; no repository checks were performed." }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : "Unknown handoff failure") + "\n");
    process.exitCode = 1;
  });
