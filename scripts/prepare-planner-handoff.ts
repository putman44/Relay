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

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 4 || args[0] !== "--issue" || args[2] !== "--repo")
    throw new Error("Usage: --issue N --repo owner/repo [--checkout path --preview-context] | [--output path --allow-live-api [--checkout path --context-path file ... | --checkout path --approve-context TOKEN]]");
  const preview = args.includes("--preview-context");
  const live = args.includes("--allow-live-api");
  if (preview === live) throw new Error("Choose offline preview or explicit live API authorization");
  let checkoutPath: string | undefined;
  let outputPath: string | undefined;
  let approvalToken: string | undefined;
  const paths: string[] = [];
  for (let i = 4; i < args.length;) {
    if (args[i] === "--preview-context" || args[i] === "--allow-live-api") { i++; continue; }
    if (i + 1 >= args.length) throw new Error("Incomplete source selection");
    if (args[i] === "--checkout" && !checkoutPath) checkoutPath = args[i + 1];
    else if (args[i] === "--output" && !outputPath) outputPath = args[i + 1];
    else if (args[i] === "--approve-context" && !approvalToken) approvalToken = args[i + 1];
    else if (args[i] === "--context-path") paths.push(args[i + 1]!);
    else throw new Error("Invalid source selection option");
    i += 2;
  }
  if (preview && (!checkoutPath || outputPath || approvalToken || paths.length))
    throw new Error("Offline preview requires only --checkout and --preview-context");
  if (live && (!outputPath || Boolean(checkoutPath) !== Boolean(paths.length || approvalToken) ||
      Boolean(paths.length && approvalToken)))
    throw new Error("Live handoff requires output and one valid context selection mode");
  const policy = JSON.parse(readFileSync(new URL("../.agents/relay-orchestration-policy.json", import.meta.url), "utf8"));
  if (policy?.roles?.planner?.model !== "gpt-6.1-sol" || policy?.roles?.planner?.reasoningEffort !== "medium")
    throw new Error("API Planner model and effort do not match repository policy");
  const trustedConfiguration = { repository: args[3], planner: policy.roles.planner };
  if (preview) {
    const issue = readGithubIssue(Number(args[1]), args[3]!);
    const selection = selectIssueContext({ repository: args[3]!, issueNumber: Number(args[1]),
      issue, trustedConfiguration, checkoutPath: checkoutPath! });
    process.stdout.write(JSON.stringify({ status: "PREVIEW", repository: args[3], issueNumber: Number(args[1]),
      candidates: selection.candidates, approvalToken: selection.approvalToken,
      contextLimitations: selection.limitations }) + "\n");
    return;
  }
  const result = await preparePlannerHandoff(Number(args[1]), args[3]!, process.env.OPENAI_API_KEY ?? "",
    async (number, repository) => readGithubIssue(number, repository), fetch,
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
