import { FileAttemptReservation } from "../src/orchestration/file-attempt-reservation.js";
import { PolicyCoordination } from "../src/orchestration/policy-coordination.js";

// Operational command. Invoke only with separate, explicit approval for this promotion.
const names = ["--repository", "--reservation-directory", "--commit", "--approval-evidence"] as const;
const args = process.argv.slice(2);
if (args.length !== names.length * 2 || names.some((name, index) => args[index * 2] !== name || !args[index * 2 + 1])) {
  throw new Error(`Usage: promote-orchestration-policy ${names.map((name) => `${name} <value>`).join(" ")}`);
}
const [, repository, , directory, , commit, , approvalEvidence] = args as [string, string, string, string, string, string, string, string];
const coordination = new PolicyCoordination(repository, new FileAttemptReservation(directory));
const policy = await coordination.promote(commit, approvalEvidence);
process.stdout.write(JSON.stringify({ status: "PROMOTED", policyDigest: policy.policyDigest, sourceCommit: policy.sourceCommit }) + "\n");
