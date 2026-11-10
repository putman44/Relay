import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { validateProjectContext } from "./project-context.js";
import { loadRepositoryContext } from "./repository-context.js";

// Paths are suggestions from issue text. The loader remains the authority for file safety.
const MENTION = /(?:^|[\s`'"(])((?:\.{1,2}\/|\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+)(?=$|[\s`'"),;:])/gm;
const MAX_MENTIONS = 32;

export function selectIssueContext(input: {
  repository: string;
  issueNumber: number;
  issue: unknown;
  trustedConfiguration: unknown;
  checkoutPath: string;
}) {
  const { issue, issueUrl } = validateProjectContext({ repository: input.repository,
    issueNumber: input.issueNumber, issue: input.issue, trustedConfiguration: input.trustedConfiguration });
  const fileScope = /^## File scope\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(issue.body)?.[1];
  const mentions = [...(fileScope ?? issue.body).matchAll(MENTION)].map((match) => match[1]!);
  if (!mentions.length || mentions.length > MAX_MENTIONS)
    throw new Error("No bounded explicit source paths; select context paths manually");
  const paths = [...new Set(mentions)];
  if (paths.length !== mentions.length)
    throw new Error("Repeated issue paths require human selection; select context paths manually");
  if (paths.length > 8) throw new Error("Too many source candidates; select context paths manually");

  const files = loadRepositoryContext(input.checkoutPath, input.repository, paths);

  const root = realpathSync(resolve(input.checkoutPath));
  const tracked = new Set(execFileSync("git", ["-C", root, "--literal-pathspecs", "ls-files", "-z", "--cached", "--", ...paths],
    { encoding: "utf8", maxBuffer: 64_000 }).split("\0").filter(Boolean));
  if (paths.some((path) => !tracked.has(path)))
    throw new Error("Issue path is missing or not repository tracked; select context paths manually");

  const approvalToken = createHash("sha256").update(JSON.stringify({
    issueUrl, issueBody: issue.body, repository: input.repository,
    paths, files: files.map((file) => createHash("sha256").update(file.content).digest("hex")),
  })).digest("hex");
  return {
    files,
    paths,
    candidates: paths.map((path) => ({ path, reason: "Explicit path in selected issue" })),
    approvalToken,
    limitations: "Only explicit issue paths were considered; paths are untrusted suggestions.",
  };
}
