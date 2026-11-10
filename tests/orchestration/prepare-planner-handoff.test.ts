import assert from "node:assert/strict";
import test from "node:test";
import { preparePlannerHandoff } from "../../scripts/prepare-planner-handoff.js";

const issue = { number: 19, title: "Selected work", body: "Implement only the approved change." };
const repository = "putman44/Relay";
const trustedConfiguration = { repository, planner: { model: "gpt-6.1-sol", reasoningEffort: "medium" } };
const issueUrl = `https://github.com/${repository}/issues/19`;
const readIssue = async () => issue;

function plannerReply(status: "READY" | "BLOCKED", locator = issueUrl,
  extraKind?: "REPOSITORY" | "CHECK" | "INVESTIGATION") {
  return (async (_url: unknown, init: unknown) => {
    const request = JSON.parse((init as { body: string }).body);
    const input = JSON.parse(request.input);
    assert.equal(input.issueBody, issue.body);
    assert.equal(input.issueUrl, issueUrl);
    assert.deepEqual(request.tools, []);
    const identity = input.identity;
    const evidenceReferences = [{ ...identity, referenceId: "issue", kind: "REQUIREMENTS", locator },
      ...(extraKind ? [{ ...identity, referenceId: "fabricated", kind: extraKind, locator: "unverified/claim" }] : [])];
    const plan = { summary: "Implement the approved change", tasks: [{ taskId: "task-1",
      summary: "Make the scoped edit", dependencies: [], fileScope: ["src/example.ts"],
      complexity: "LOW", risk: "LOW", verificationRequirements: ["Focused test"] }] };
    const output = status === "READY"
      ? { ...identity, role: "planner", status, plan, evidenceReferences }
      : { ...identity, role: "planner", status, reason: "Missing detail",
        recommendedNextAction: "Ask issue owner", evidenceReferences };
    return { ok: true, status: 200, json: async () => ({ status: "completed", model: "gpt-6.1-sol",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }) };
  }) as typeof fetch;
}

test("prepares an issue-bound advisory artifact from a validated Planner response", async () => {
  const result = await preparePlannerHandoff(19, repository, "fake-key", readIssue, plannerReply("READY"), trustedConfiguration);
  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.artifact.advisoryOnly, true);
  assert.equal(result.artifact.implementerDispatchAuthorized, false);
  assert.deepEqual(result.artifact.issue, { ...issue, url: issueUrl, repository });
  assert.equal(result.artifact.planner.status, "READY");
  assert.equal(result.artifact.planner.runId, result.artifact.identity.runId);
});

test("a blocked Planner does not produce an Implementer artifact", async () => {
  const result = await preparePlannerHandoff(19, repository, "fake-key", readIssue, plannerReply("BLOCKED"), trustedConfiguration);
  assert.equal(result.status, "BLOCKED");
  assert.equal("artifact" in result, false);
});

test("rejects issue identity and requirements evidence mismatches", async () => {
  await assert.rejects(preparePlannerHandoff(19, repository, "fake-key", async () => ({ ...issue, number: 20 }),
    plannerReply("READY"), trustedConfiguration), /identity mismatch/);
  await assert.rejects(preparePlannerHandoff(19, repository, "fake-key", readIssue,
    plannerReply("READY", "https://github.com/putman44/Relay/issues/20"), trustedConfiguration), /requirements evidence/);
});

test("rejects the entire handoff when the tool-free Planner claims unsupported evidence", async () => {
  for (const kind of ["REPOSITORY", "CHECK", "INVESTIGATION"] as const) {
    for (const status of ["READY", "BLOCKED"] as const) {
      await assert.rejects(preparePlannerHandoff(19, repository, "fake-key", readIssue,
        plannerReply(status, issueUrl, kind), trustedConfiguration), /unsupported evidence reference/);
    }
  }
});
