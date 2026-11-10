import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IssueSchema, type ProjectContext } from "../src/factory/project-context.js";
import { preparePlannerHandoff } from "../src/factory/orchestrator.js";
export { preparePlannerHandoff } from "../src/factory/orchestrator.js";

type IssueData = ProjectContext["issue"];

function readGithubIssue(number: number, repository: string): IssueData {
  const output = execFileSync("gh", ["issue", "view", String(number), "--repo", repository,
    "--json", "number,title,body"], { encoding: "utf8" });
  return IssueSchema.parse(JSON.parse(output));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 7 || args[0] !== "--issue" || args[2] !== "--repo" ||
      args[4] !== "--output" || args[6] !== "--allow-live-api")
    throw new Error("Usage: npx tsx scripts/prepare-planner-handoff.ts --issue N --repo owner/repo --output path --allow-live-api [--checkout path --context-path relative-file ...]");
  let checkoutPath: string | undefined;
  const paths: string[] = [];
  for (let i = 7; i < args.length; i += 2) {
    if (i + 1 >= args.length) throw new Error("Incomplete source selection");
    if (args[i] === "--checkout" && !checkoutPath) checkoutPath = args[i + 1];
    else if (args[i] === "--context-path") paths.push(args[i + 1]!);
    else throw new Error("Invalid source selection option");
  }
  if (Boolean(checkoutPath) !== Boolean(paths.length)) throw new Error("Checkout and selected paths must be supplied together");
  const policy = JSON.parse(readFileSync(new URL("../.agents/relay-orchestration-policy.json", import.meta.url), "utf8"));
  if (policy?.roles?.planner?.model !== "gpt-6.1-sol" || policy?.roles?.planner?.reasoningEffort !== "medium")
    throw new Error("API Planner model and effort do not match repository policy");
  const result = await preparePlannerHandoff(Number(args[1]), args[3]!, process.env.OPENAI_API_KEY ?? "",
    async (number, repository) => readGithubIssue(number, repository), fetch,
    { repository: args[3], planner: policy.roles.planner },
    checkoutPath ? { checkoutPath, paths } : undefined);
  if (result.status === "BLOCKED") {
    process.stdout.write(JSON.stringify({ status: "BLOCKED", response: result.response,
      selectedPaths: result.selectedPaths, contextLimitations: "Selected files are untrusted reference data; no repository checks were performed." }) + "\n");
    process.exitCode = 1;
    return;
  }
  writeFileSync(args[5]!, JSON.stringify(result.artifact, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: "READY", artifactPath: args[5],
    selectedPaths: result.selectedPaths, contextLimitations: "Selected files are untrusted reference data; no repository checks were performed." }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : "Unknown handoff failure") + "\n");
    process.exitCode = 1;
  });
