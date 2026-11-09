import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPlannerHandoff, type PlannerHandoffContext, type PlannerHost, type TrustedAttemptReservation } from "../../src/orchestration/planner-handoff.js";

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
const evidence = [{ ...identity, referenceId: "issue-28", kind: "REQUIREMENTS", locator: "https://github.com/putman44/Relay/issues/28" }];
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

// Test-only shared fake. It does not establish production atomicity or durability.
const fakeReservation = () => {
  const attempts = new Set<string>();
  const reservation: TrustedAttemptReservation = {
    async reserveAttempt(input) {
      assert.equal("requirementsVersion" in input, false);
      const key = JSON.stringify([input.canonicalHost, input.canonicalRepository, input.issueNumber,
        input.runId, input.taskId, input.attemptId]);
      if (attempts.has(key)) return "ALREADY_RESERVED";
      attempts.add(key);
      return "RESERVED";
    },
  };
  return reservation;
};
const handoff = (host: PlannerHost, reservation = fakeReservation()) => createPlannerHandoff(host, reservation);

test("one approved issue yields an exact fresh Planner request and validated READY", async () => {
  const { host, calls } = fakeHost();
  const result = await handoff(host)(context, policy);
  assert.equal(result.status, "READY");
  assert.deepEqual(policy.roles, {
    planner: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
    implementer: { model: "gpt-6.1-sol", reasoningEffort: "high" },
    reviewer: { model: "gpt-6.1-sol", reasoningEffort: "high" },
  });
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
  const result = await handoff(host)(context, policy);
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
  ]) {
    const result = await handoff(host)(context, malformed);
    assert.equal(result.status, "STOP");
    if (result.status === "STOP") assert.equal(result.code, "MALFORMED_ROLE_POLICY");
  }
  assert.equal((await handoff(host)({ ...context, approvalEvidence: "" }, policy)).status, "STOP");
  assert.equal(calls.length, 0);
});

test("valid-looking substituted model or effort is rejected before reservation or host calls", async () => {
  for (const role of ["planner", "implementer", "reviewer"] as const) for (const field of ["model", "reasoningEffort"] as const) {
    const { host, calls } = fakeHost();
    let reservations = 0;
    const reservation: TrustedAttemptReservation = { async reserveAttempt() { reservations += 1; return "RESERVED"; } };
    const substitute = { ...policy, roles: { ...policy.roles,
      [role]: { ...policy.roles[role], [field]: "substituted" } } };
    const result = await handoff(host, reservation)(context, substitute);
    assert.equal(result.status, "STOP");
    if (result.status === "STOP") assert.equal(result.code, "MALFORMED_ROLE_POLICY");
    assert.equal(reservations, 0);
    assert.equal(calls.length, 0);
  }
});

test("reservation is required, and ambiguous reservation outcomes never reach the host", async () => {
  const { host, calls } = fakeHost();
  const absent = await createPlannerHandoff(host)(context, policy);
  assert.equal(absent.status, "STOP");
  if (absent.status === "STOP") assert.equal(absent.code, "RESERVATION_UNAVAILABLE");
  for (const reserveAttempt of [
    async () => { throw new Error("acknowledgement lost"); },
    async () => undefined,
  ]) {
    const invoke = handoff(host, { reserveAttempt });
    const ambiguous = await invoke(context, policy);
    assert.equal(ambiguous.status, "STOP");
    if (ambiguous.status === "STOP") assert.equal(ambiguous.code, "RESERVATION_OUTCOME_AMBIGUOUS");
    const repeated = await invoke(context, policy);
    assert.equal(repeated.status, "STOP");
    if (repeated.status === "STOP") assert.equal(repeated.code, "DUPLICATE_ATTEMPT");
  }
  assert.equal(calls.length, 0);
});

test("a shared reservation rejects duplicate attempts across separate handoff instances", async () => {
  const reservation = fakeReservation();
  const { host, calls } = fakeHost();
  const first = handoff(host, reservation);
  const second = handoff(host, reservation);
  const results = await Promise.all([first(context, policy), second(context, policy)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["READY", "STOP"]);
  const duplicate = results.find((result) => result.status === "STOP");
  if (duplicate?.status === "STOP") assert.equal(duplicate.code, "DUPLICATE_ATTEMPT");
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "dispatch").length, 1);
});

test("uncertain dispatch remains reserved across handoff instances", async () => {
  const reservation = fakeReservation();
  const { host } = fakeHost();
  let dispatches = 0;
  host.dispatchPlanner = async () => { dispatches += 1; throw new Error("acknowledgement lost"); };
  const uncertain = await handoff(host, reservation)(context, policy);
  assert.equal(uncertain.status, "STOP");
  if (uncertain.status === "STOP") assert.equal(uncertain.code, "DISPATCH_OUTCOME_AMBIGUOUS");
  const repeated = await handoff(host, reservation)(context, policy);
  assert.equal(repeated.status, "STOP");
  if (repeated.status === "STOP") assert.equal(repeated.code, "DUPLICATE_ATTEMPT");
  assert.equal(dispatches, 1);
});

test("amended requirements cannot retry an uncertain attempt across handoff instances", async () => {
  const reservation = fakeReservation();
  const { host, calls } = fakeHost();
  let dispatches = 0;
  host.dispatchPlanner = async (request) => {
    dispatches += 1;
    assert.equal(request.requirementsVersion, context.requirementsVersion);
    throw new Error("acknowledgement lost");
  };
  const first = handoff(host, reservation);
  const uncertain = await first(context, policy);
  assert.equal(uncertain.status, "STOP");
  if (uncertain.status === "STOP") assert.equal(uncertain.code, "DISPATCH_OUTCOME_AMBIGUOUS");

  const amendedContext = { ...context, requirementsVersion: "issue-28-approved-body-v2" };
  const localRetry = await first(amendedContext, policy);
  assert.equal(localRetry.status, "STOP");
  if (localRetry.status === "STOP") assert.equal(localRetry.code, "DUPLICATE_ATTEMPT");
  const amended = await handoff(host, reservation)(amendedContext, policy);
  assert.equal(amended.status, "STOP");
  if (amended.status === "STOP") assert.equal(amended.code, "DUPLICATE_ATTEMPT");
  assert.equal(dispatches, 1);
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "capability").length, 3);
});

test("READY requires exact issue and repository evidence while permitting other evidence", async () => {
  for (const references of [
    [{ ...evidence[0], locator: "https://github.com/putman44/Relay/issues/29" }],
    [{ ...evidence[0], locator: "https://github.com/elsewhere/Relay/issues/28" }],
    [{ ...evidence[0], kind: "CHECK", locator: "checks/planner" }],
    [evidence[0], { ...evidence[0], locator: "https://github.com/elsewhere/Relay/issues/28" }],
  ]) {
    const { host } = fakeHost({ ...ready, evidenceReferences: references });
    const result = await handoff(host)(context, policy);
    assert.equal(result.status, "STOP");
    if (result.status === "STOP") assert.equal(result.code, "IDENTITY_MISMATCH");
  }
  const { host } = fakeHost({ ...ready, evidenceReferences: [
    evidence[0], { ...evidence[0], kind: "CHECK", referenceId: "check-1", locator: "checks/planner" },
    { ...evidence[0], kind: "INVESTIGATION", referenceId: "investigation-1", locator: "notes/planner" },
  ] });
  assert.equal((await handoff(host)(context, policy)).status, "READY");
});

test("unsupported exact settings, missing proof, and absent fresh context stop without dispatch", async () => {
  for (const role of ["planner", "implementer", "reviewer"] as const) {
    for (const proof of [
      undefined,
      { role, ...policy.roles[role], model: "gpt-6-sol", freshIndependentContext: true },
      { role, ...policy.roles[role], reasoningEffort: "low", freshIndependentContext: true },
      { role, ...policy.roles[role], freshIndependentContext: false },
    ]) {
      const { host, calls } = fakeHost();
      host.checkCapability = async (checkedRole, setting) => checkedRole === role
        ? proof : { role: checkedRole, ...setting, freshIndependentContext: true };
      const result = await handoff(host)(context, policy);
      assert.equal(result.status, "STOP");
      if (result.status === "STOP") assert.equal(result.code, "CAPABILITY_UNPROVEN");
      assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "dispatch"), false);
    }
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
    const stopped = await handoff(host)(context, policy);
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
  const result = await handoff(host)(context, policy);
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
    const result = await handoff(host)(context, policy);
    assert.equal(result.status, "STOP");
    if (result.status === "STOP") assert.equal(result.code, "IDENTITY_MISMATCH");
  }
});

test("malformed response and ambiguous dispatch stop with no retry", async () => {
  const { host } = fakeHost();
  host.dispatchPlanner = async () => envelope({ ...ready, plan: undefined });
  const malformed = await handoff(host)(context, policy);
  assert.equal(malformed.status, "STOP");
  if (malformed.status === "STOP") assert.equal(malformed.code, "MALFORMED_RESPONSE");
  let dispatches = 0;
  host.dispatchPlanner = async () => { dispatches += 1; throw new Error("acknowledgement lost"); };
  const invoke = handoff(host);
  const ambiguous = await invoke(context, policy);
  assert.equal(ambiguous.status, "STOP");
  if (ambiguous.status === "STOP") assert.equal(ambiguous.code, "DISPATCH_OUTCOME_AMBIGUOUS");
  const duplicate = await invoke(context, policy);
  assert.equal(duplicate.status, "STOP");
  if (duplicate.status === "STOP") assert.equal(duplicate.code, "DUPLICATE_ATTEMPT");
  assert.equal(dispatches, 1);
});
