import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runApiPlanner } from "../src/factory/agents/planner.js";
export { runApiPlanner } from "../src/factory/agents/planner.js";
export type { PlannerInput } from "../src/factory/agents/planner.js";

async function main() {
  if (process.argv.length !== 5 || process.argv[2] !== "--input" || process.argv[4] !== "--allow-live-api")
    throw new Error("Usage: npx tsx scripts/run-api-planner.ts --input /absolute/path/input.json --allow-live-api");
  const key = process.env.OPENAI_API_KEY;
  const input = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
  const report = await runApiPlanner(input, key ?? "");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (report.result === "FAIL") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    process.stderr.write(JSON.stringify({ label: "ADVISORY", result: "FAIL",
      errors: [error instanceof Error ? error.message : "Unknown precondition failure"] }) + "\n");
    process.exitCode = 1;
  });
