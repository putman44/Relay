import assert from "node:assert/strict";
import test from "node:test";
import { runApiPlanner } from "../../src/factory/agents/planner.js";
import { preparePlannerHandoff } from "../../src/factory/orchestrator.js";
import { validateProjectContext } from "../../src/factory/project-context.js";

const fixtures = [
  { repository: "putman44/Relay", issue: { number: 39, title: "Factory Planner", body: "Extract the Planner." } },
  { repository: "putman44/Parsity", issue: { number: 7, title: "Clinical search", body: "Plan clinical search." } },
] as const;

for (const fixture of fixtures) {
  const trustedConfiguration = { repository: fixture.repository,
    planner: { model: "gpt-6.1-sol", reasoningEffort: "medium" } };
  for (const status of ["READY", "BLOCKED"] as const) {
    test(`${fixture.repository} ${status} uses selected issue identity and trusted evidence`, async () => {
      const issueUrl = `https://github.com/${fixture.repository}/issues/${fixture.issue.number}`;
      const context = validateProjectContext({ repository: fixture.repository,
        issueNumber: fixture.issue.number, issue: fixture.issue, trustedConfiguration });
      assert.equal(context.issueUrl, issueUrl);
      let calls = 0;
      const send = (async (_url: string, init: RequestInit) => {
        calls++;
        const request = JSON.parse(init.body as string);
        const input = JSON.parse(request.input);
        assert.equal(input.issueBody, fixture.issue.body);
        assert.equal(input.issueUrl, issueUrl);
        assert.deepEqual(request.tools, []);
        const identity = input.identity;
        const evidenceReferences = [{ ...identity, referenceId: "issue", kind: "REQUIREMENTS", locator: issueUrl }];
        const output = status === "READY"
          ? { ...identity, role: "planner", status, plan: { summary: "Scoped plan", tasks: [{
            taskId: "one", summary: "Make the edit", dependencies: [], fileScope: ["src/example.ts"],
            complexity: "LOW", risk: "LOW", verificationRequirements: ["Offline test"] }] }, evidenceReferences }
          : { ...identity, role: "planner", status, reason: "Needs input",
            recommendedNextAction: "Ask owner", evidenceReferences };
        return { ok: true, status: 200, json: async () => ({ status: "completed", model: "gpt-6.1-sol",
          output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }) };
      }) as typeof fetch;
      const result = await preparePlannerHandoff(fixture.issue.number, fixture.repository, "fake-key",
        async () => fixture.issue, send, trustedConfiguration);
      assert.equal(calls, 1);
      assert.equal(result.status, status);
      if (result.status === "READY") {
        assert.equal(result.artifact.issue.repository, fixture.repository);
        assert.equal(result.artifact.issue.url, issueUrl);
        assert.equal(result.artifact.advisoryOnly, true);
        assert.equal(result.artifact.implementerDispatchAuthorized, false);
      } else assert.equal("artifact" in result, false);
    });
  }

  test(`${fixture.repository} rejects wrong issue data before a model call`, async () => {
    let calls = 0;
    await assert.rejects(preparePlannerHandoff(fixture.issue.number, fixture.repository, "fake-key",
      async () => ({ ...fixture.issue, number: fixture.issue.number + 1 }),
      (async () => { calls++; throw new Error("Unexpected model call"); }) as typeof fetch,
      trustedConfiguration),
    /identity mismatch/);
    assert.equal(calls, 0);
  });

  for (const status of ["READY", "BLOCKED"] as const) {
    test(`${fixture.repository} ${status} rejects unsupported evidence`, async () => {
      const send = (async (_url: string, init: RequestInit) => {
        const identity = JSON.parse(JSON.parse(init.body as string).input).identity;
        const issueUrl = `https://github.com/${fixture.repository}/issues/${fixture.issue.number}`;
        const evidenceReferences = [{ ...identity, referenceId: "issue", kind: "REQUIREMENTS", locator: issueUrl },
          { ...identity, referenceId: "unverified", kind: "CHECK", locator: "unverified/check" }];
        const output = status === "READY"
          ? { ...identity, role: "planner", status, plan: { summary: "Scoped plan", tasks: [{
            taskId: "one", summary: "Make the edit", dependencies: [], fileScope: ["src/example.ts"],
            complexity: "LOW", risk: "LOW", verificationRequirements: ["Offline test"] }] }, evidenceReferences }
          : { ...identity, role: "planner", status, reason: "Needs input",
            recommendedNextAction: "Ask owner", evidenceReferences };
        return { ok: true, json: async () => ({ status: "completed", model: "gpt-6.1-sol",
          output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] }) };
      }) as unknown as typeof fetch;
      await assert.rejects(preparePlannerHandoff(fixture.issue.number, fixture.repository, "fake-key",
        async () => fixture.issue, send, trustedConfiguration), /PlannerResponseSchema validation failed/);
    });
  }

  test(`${fixture.repository} rejects invalid or mismatched trusted configuration before issue read`, async () => {
    let reads = 0;
    let calls = 0;
    const readIssue = async () => { reads++; return fixture.issue; };
    const send = (async () => { calls++; throw new Error("Unexpected model call"); }) as typeof fetch;
    for (const configuration of [
      { ...trustedConfiguration, repository: "putman44/Other" },
      { ...trustedConfiguration, planner: { model: "unapproved", reasoningEffort: "medium" } },
      { ...trustedConfiguration, planner: { model: "gpt-6.1-sol", reasoningEffort: "low" } },
      { ...trustedConfiguration, extra: "untrusted" },
      undefined,
    ]) await assert.rejects(preparePlannerHandoff(fixture.issue.number, fixture.repository,
      "fake-key", readIssue, send, configuration));
    assert.equal(reads, 0);
    assert.equal(calls, 0);
  });
}

test("factory Planner rejects mismatched execution identity before handoff", async () => {
  const identity = { schemaVersion: 1, runId: "r", taskId: "t", attemptId: "a", requirementsVersion: "v" };
  const issueUrl = "https://github.com/putman44/Parsity/issues/7";
  const send = (async () => ({ ok: true, json: async () => ({ status: "completed", model: "gpt-6.1-sol",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
      ...identity, attemptId: "other", role: "planner", status: "BLOCKED", reason: "Needs input",
      recommendedNextAction: "Ask owner", evidenceReferences: [{ ...identity, referenceId: "issue",
        kind: "REQUIREMENTS", locator: issueUrl }],
    }) }] }] }) })) as unknown as typeof fetch;
  const result = await runApiPlanner({ issueBody: "Plan clinical search.", issueUrl, identity }, "fake-key", send);
  assert.equal(result.result, "FAIL");
  assert.equal(result.validation.context, false);
});
