import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPlannerHandoff, type PlannerHandoffContext, type PlannerHost } from "../../src/orchestration/planner-handoff.js";

const policy = JSON.parse(readFileSync(new URL("../../.agents/relay-orchestration-policy.json", import.meta.url), "utf8"));
const context: PlannerHandoffContext = {
  issueNumber: 28,
  approvedIssueBody: "## Objective — guarded local role handoff foundation\n\nIntroduce the smallest testable integration boundary.\n",
  canonicalHost: "github.com",
  canonicalRepository: "putman44/Relay",
  approvalEvidence: "explicit-user-approval-for-issue-28",
  runId: "run-1",
  taskId: "planner-invocation",
  attemptId: "attempt-1",
  requirementsVersion: "issue-28-approved-body-v1",
};
const identity = {
  schemaVersion: 1,
  runId: context.runId,
  taskId: context.taskId,
  attemptId: context.attemptId,
  requirementsVersion: context.requirementsVersion,
};
const evidence = [{ ...identity, referenceId: "issue-28", kind: "REQUIREMENTS", locator: "github.com/putman44/Relay/issues/28" }];
const ready = {
  ...identity, role: "planner", status: "READY",
  plan: { summary: "Advisory plan", tasks: [{
    taskId: "proposed-task", summary: "Proposed work", dependencies: [],
    fileScope: ["src/orchestration/planner-handoff.ts"], complexity: "LOW", risk: "LOW",
    verificationRequirements: ["typecheck"],
  }] }, evidenceReferences: evidence,
};
const blocked = { ...identity, role: "planner", status: "BLOCKED", reason: "Human decision needed", evidenceReferences: evidence, recommendedNextAction: "Ask the user" };
const envelope = (response: unknown) => ({
  issueNumber: context.issueNumber, canonicalHost: context.canonicalHost,
  canonicalRepository: context.canonicalRepository, response,
});
const fakeHost = (response: unknown = ready) => {
  const calls: unknown[] = [];
  const host: PlannerHost = {
    async checkCapability(role, setting) {
      calls.push(["capability", role, setting]);
      return { role, ...setting, freshIndependentContext: true };
    },
    async dispatchPlanner(request) {
      calls.push(["dispatch", request]);
      return envelope(response);
    },
  };
  return { host, calls };
};

test("one approved issue yields an exact fresh Planner request and validated READY", async () => {
  const { host, calls } = fakeHost();
  const result = await createPlannerHandoff(host)(context, policy);
  assert.equal(result.status, "READY");
  assert.deepEqual(calls.slice(0, 3), (["planner", "implementer", "reviewer"] as const).map((role) =>
    ["capability", role, policy.roles[role]]));
  assert.deepEqual(calls[3], ["dispatch", {
    ...context, role: "planner", ...policy.roles.planner, freshIndependentContext: true,
  }]);
  assert.equal(calls.length, 4);
  if (result.status === "READY") assert.deepEqual(result.response, ready);
});

test("BLOCKED remains distinct and advisory", async () => {
  const { host, calls } = fakeHost(blocked);
  const result = await createPlannerHandoff(host)(context, policy);
  assert.equal(result.status, "BLOCKED");
  assert.equal(calls.length, 4);
  if (result.status === "BLOCKED") assert.deepEqual(result.response, blocked);
});

test("missing host, malformed policy, and untrusted context stop before dispatch", async () => {
  assert.equal((await createPlannerHandoff()(context, policy)).status, "STOP");
  const { host, calls } = fakeHost();
  for (const malformed of [
    { ...policy, roles: { planner: policy.roles.planner } },
    { ...policy, roles: { ...policy.roles, extra: policy.roles.planner } },
    { ...policy, roles: { ...policy.roles, planner: { ...policy.roles.planner, extra: true } } },
    { ...policy, schemaVersion: 2 },
    { ...policy, roles: { ...policy.roles, planner: { ...policy.roles.planner, model: ` ${policy.roles.planner.model}` } } },
  ]) assert.deepEqual(await createPlannerHandoff(host)(context, malformed), {
    status: "STOP", code: "MALFORMED_ROLE_POLICY", detail: "Complete exact role policy is required",
  });
  assert.equal((await createPlannerHandoff(host)({ ...context, approvalEvidence: "" }, policy)).status, "STOP");
  assert.equal(calls.length, 0);
});

test("unsupported exact settings, missing proof, and absent fresh context stop without dispatch", async () => {
  for (const proof of [undefined, { role: "planner", model: "fallback", reasoningEffort: "medium", freshIndependentContext: true },
    { role: "planner", ...policy.roles.planner, freshIndependentContext: false }]) {
    const { host, calls } = fakeHost();
    host.checkCapability = async () => proof;
    const result = await createPlannerHandoff(host)(context, policy);
    assert.equal(result.status, "STOP");
    if (result.status === "STOP") assert.equal(result.code, "CAPABILITY_UNPROVEN");
    assert.equal(calls.length, 0);
  }
});

test("a mutating capability checker cannot substitute Planner model or effort", async () => {
  for (const field of ["model", "reasoningEffort"] as const) {
    const { host, calls } = fakeHost();
    const original = policy.roles.planner[field];
    host.checkCapability = async (role, setting) => {
      if (role === "planner") {
        assert.equal(Object.isFrozen(setting), true);
        assert.throws(() => { (setting as { model: string; reasoningEffort: string })[field] = "substituted"; }, TypeError);
        assert.equal(setting[field], original);
        return { role, ...setting, [field]: "substituted", freshIndependentContext: true };
      }
      return { role, ...setting, freshIndependentContext: true };
    };
    const stopped = await createPlannerHandoff(host)(context, policy);
    assert.equal(stopped.status, "STOP");
    if (stopped.status === "STOP") assert.equal(stopped.code, "CAPABILITY_UNPROVEN");
    assert.equal(calls.length, 0);
    assert.equal(policy.roles.planner[field], original);
  }

  const { host, calls } = fakeHost();
  const configuredPlanner = { ...policy.roles.planner };
  host.checkCapability = async (role, setting) => {
    if (role === "planner") {
      assert.throws(() => { (setting as { model: string }).model = "substituted"; }, TypeError);
      assert.throws(() => { (setting as { reasoningEffort: string }).reasoningEffort = "substituted"; }, TypeError);
    }
    return { role, ...setting, freshIndependentContext: true };
  };
  const result = await createPlannerHandoff(host)(context, policy);
  assert.equal(result.status, "STOP");
  if (result.status === "STOP") assert.equal(result.code, "CAPABILITY_UNPROVEN");
  assert.equal(calls.length, 0);
  assert.deepEqual(policy.roles.planner, configuredPlanner);
});

test("wrong host envelope or execution identity stops", async () => {
  for (const response of [
    { ...envelope(ready), issueNumber: 29 },
    { ...envelope(ready), canonicalRepository: "elsewhere/Relay" },
    { ...envelope(ready), canonicalHost: "example.com" },
    envelope({ ...ready, taskId: "different" }),
    envelope({ ...ready, attemptId: "different" }),
    envelope({ ...ready, requirementsVersion: "different" }),
    envelope({ ...ready, evidenceReferences: [{ ...evidence[0], runId: "different" }] }),
    envelope({ ...ready, evidenceReferences: [{ ...evidence[0], taskId: "different" }] }),
    envelope({ ...ready, evidenceReferences: [{ ...evidence[0], requirementsVersion: "different" }] }),
  ]) {
    const { host } = fakeHost();
    host.dispatchPlanner = async () => response;
    const result = await createPlannerHandoff(host)(context, policy);
    assert.equal(result.status, "STOP");
    if (result.status === "STOP") assert.equal(result.code, "IDENTITY_MISMATCH");
  }
});

test("malformed response and ambiguous dispatch stop with no retry", async () => {
  const { host } = fakeHost();
  host.dispatchPlanner = async () => envelope({ ...ready, plan: undefined });
  const malformed = await createPlannerHandoff(host)(context, policy);
  assert.equal(malformed.status, "STOP");
  if (malformed.status === "STOP") assert.equal(malformed.code, "MALFORMED_RESPONSE");
  let dispatches = 0;
  host.dispatchPlanner = async () => { dispatches += 1; throw new Error("acknowledgement lost"); };
  const handoff = createPlannerHandoff(host);
  const ambiguous = await handoff(context, policy);
  assert.equal(ambiguous.status, "STOP");
  if (ambiguous.status === "STOP") assert.equal(ambiguous.code, "DISPATCH_OUTCOME_AMBIGUOUS");
  const duplicate = await handoff(context, policy);
  assert.equal(duplicate.status, "STOP");
  if (duplicate.status === "STOP") assert.equal(duplicate.code, "DUPLICATE_ATTEMPT");
  assert.equal(dispatches, 1);
});
