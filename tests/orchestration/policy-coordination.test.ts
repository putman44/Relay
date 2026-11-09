import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { attemptDigest, FileAttemptReservation } from "../../src/orchestration/file-attempt-reservation.js";
import { createPlannerHandoff, type PlannerHandoffContext, type PlannerHost } from "../../src/orchestration/planner-handoff.js";
import { PolicyCoordination, type PolicyCoordinator } from "../../src/orchestration/policy-coordination.js";

const policyText = await readFile(new URL("../../.agents/relay-orchestration-policy.json", import.meta.url), "utf8");
const policy = JSON.parse(policyText);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "relay-policy-test-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const repository = join(root, "repo");
  const directory = join(root, "reservations");
  await mkdir(join(repository, ".agents"), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(repository, ".agents/relay-orchestration-policy.json"), policyText);
  git(repository, "init", "-q");
  git(repository, "add", ".agents/relay-orchestration-policy.json");
  git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "approved policy");
  const commit = git(repository, "rev-parse", "HEAD");
  const reservation = new FileAttemptReservation(directory);
  const coordination = new PolicyCoordination(repository, reservation);
  const approved = await coordination.promote(commit, "explicit-policy-approval");
  const context: PlannerHandoffContext = {
    issueNumber: 33, approvedIssueBody: "Approved fixture issue", canonicalHost: "github.com",
    canonicalRepository: "putman44/Relay", approvalEvidence: "explicit-policy-approval",
    runId: "run-1", taskId: "planner", attemptId: "attempt-1",
    requirementsVersion: "requirements-v1", approvedPolicyCommit: commit,
    approvedPolicyEvidence: "explicit-policy-approval",
  };
  const identity = { canonicalHost: context.canonicalHost, canonicalRepository: context.canonicalRepository,
    issueNumber: context.issueNumber, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId };
  const binding = { policyDigest: approved.policyDigest, sourceCommit: commit, requirementsVersion: context.requirementsVersion };
  return { root, repository, directory, commit, reservation, coordination, approved, context, identity, binding };
}

function hostFor(context: PlannerHandoffContext): PlannerHost {
  return {
    async checkCapability(role, setting) { return { role, ...setting, freshIndependentContext: true }; },
    async dispatchPlanner(request) {
      assert.equal(Object.isFrozen(request), true);
      return { issueNumber: context.issueNumber, canonicalHost: context.canonicalHost,
        canonicalRepository: context.canonicalRepository,
        response: { schemaVersion: 1, runId: context.runId, taskId: context.taskId,
          attemptId: context.attemptId, requirementsVersion: context.requirementsVersion,
          role: "planner", status: "BLOCKED", reason: "Fixture decision", evidenceReferences: [{
            schemaVersion: 1, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
            requirementsVersion: context.requirementsVersion, referenceId: "fixture-issue", kind: "REQUIREMENTS",
            locator: "https://github.com/putman44/Relay/issues/33",
          }],
          recommendedNextAction: "Ask the owner" } };
    },
  };
}

test("promotion before an attempt binds a verified commit and a version 2 claim", async (t) => {
  const f = await fixture(t);
  git(f.repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "later approved policy commit");
  const later = git(f.repository, "rev-parse", "HEAD");
  const promoted = await f.coordination.promote(later, "explicit-later-approval");
  assert.equal(promoted.policyDigest, f.approved.policyDigest);
  assert.equal(promoted.sourceCommit, later);
  const gate = await f.coordination.beginAttempt(later, "explicit-later-approval");
  assert.equal(gate.policy.policyDigest, f.approved.policyDigest);
  const binding = { ...f.binding, sourceCommit: later };
  assert.equal(await f.reservation.reserveAttempt(f.identity, binding), "RESERVED");
  const digest = attemptDigest(f.identity);
  const record = await f.reservation.readReservation(digest);
  assert.equal(record.version, 2);
  assert.deepEqual(record.policy, binding);
  await gate.complete("NO_DISPATCH", digest);
  assert.equal((await readdir(f.directory)).includes(".policy-gate.json"), false);
  assert.equal((await readdir(f.directory)).includes(`${digest}.reservation.json`), true);
});

test("identity mismatch at the final pre-dispatch check holds the claim", async (t) => {
  const f = await fixture(t);
  let checks = 0;
  const coordinator: PolicyCoordinator = { async beginAttempt(commit, approval) {
    const gate = await f.coordination.beginAttempt(commit, approval);
    return { ...gate, async assertCurrent() {
      checks += 1;
      if (checks === 8) throw new Error("policy identity changed before dispatch");
      await gate.assertCurrent();
    } };
  } };
  let dispatches = 0;
  const host = hostFor(f.context);
  host.dispatchPlanner = async () => { dispatches += 1; throw new Error("must not dispatch"); };
  const result = await createPlannerHandoff(host, f.reservation, coordinator)(f.context, policy);
  assert.equal(result.status, "STOP", JSON.stringify(result));
  if (result.status === "STOP") assert.equal(result.code, "POLICY_IDENTITY_MISMATCH");
  assert.equal(dispatches, 0);
  assert.equal((await readdir(f.directory)).includes(".policy-gate.json"), true);
});

test("clean capability failure records no dispatch and releases the temporary gate", async (t) => {
  const f = await fixture(t);
  const host = hostFor(f.context);
  host.checkCapability = async () => undefined;
  host.dispatchPlanner = async () => { throw new Error("must not dispatch"); };
  const result = await createPlannerHandoff(host, f.reservation, f.coordination)(f.context, policy);
  assert.equal(result.status, "STOP");
  if (result.status === "STOP") assert.equal(result.code, "CAPABILITY_UNPROVEN");
  assert.equal((await readdir(f.directory)).includes(".policy-gate.json"), false);
  const digest = attemptDigest(f.identity);
  assert.equal(JSON.parse(await readFile(join(f.directory, `${digest}.completion.json`), "utf8")).outcome, "NO_DISPATCH");
  await f.coordination.promote(f.commit, "separate-promotion-approval");
  assert.equal(await f.reservation.reserveAttempt(f.identity, f.binding), "ALREADY_RESERVED");
});

test("active attempt blocks promotion, clean completion releases only its temporary gate", async (t) => {
  const f = await fixture(t);
  const gate = await f.coordination.beginAttempt(f.commit, "explicit-policy-approval");
  await f.reservation.reserveAttempt(f.identity, f.binding);
  await assert.rejects(f.coordination.promote(f.commit, "separate-promotion-approval"));
  await gate.complete("NO_DISPATCH", attemptDigest(f.identity));
  await f.coordination.promote(f.commit, "separate-promotion-approval");
  assert.equal(await f.reservation.reserveAttempt(f.identity, f.binding), "ALREADY_RESERVED");
});

test("policy file change during a pending capability check holds the gate and claim", async (t) => {
  const f = await fixture(t);
  let resume!: () => void;
  const pending = new Promise<void>((resolve) => { resume = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const host = hostFor(f.context);
  host.checkCapability = async (role, setting) => { entered(); await pending; return { role, ...setting, freshIndependentContext: true }; };
  const invocation = createPlannerHandoff(host, f.reservation, f.coordination)(f.context, policy);
  await started;
  await assert.rejects(f.coordination.promote(f.commit, "later-approval"));
  await writeFile(join(f.repository, ".agents/relay-orchestration-policy.json"), policyText.replace("medium", "low"));
  resume();
  const result = await invocation;
  assert.equal(result.status, "STOP");
  if (result.status === "STOP") assert.equal(result.code, "POLICY_IDENTITY_MISMATCH");
  assert.equal((await readdir(f.directory)).includes(".policy-gate.json"), true);
  await assert.rejects(f.coordination.promote(f.commit, "later-approval"));
});

test("ambiguous dispatch remains blocked across restart and separate process", async (t) => {
  const f = await fixture(t);
  const host = hostFor(f.context);
  host.dispatchPlanner = async () => { throw new Error("acknowledgement lost"); };
  const result = await createPlannerHandoff(host, f.reservation, f.coordination)(f.context, policy);
  assert.equal(result.status, "STOP");
  if (result.status === "STOP") assert.equal(result.code, "DISPATCH_OUTCOME_AMBIGUOUS");
  const second = await createPlannerHandoff(host, new FileAttemptReservation(f.directory), new PolicyCoordination(f.repository, new FileAttemptReservation(f.directory)))(f.context, policy);
  assert.equal(second.status, "STOP");
  const script = `import {FileAttemptReservation} from './src/orchestration/file-attempt-reservation.ts'; import {PolicyCoordination} from './src/orchestration/policy-coordination.ts'; const c=new PolicyCoordination(process.argv[1],new FileAttemptReservation(process.argv[2])); try { await c.promote(process.argv[3],'later-approval'); process.exit(2); } catch { process.stdout.write('HELD'); }`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, f.repository, f.directory, f.commit], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "HELD");
});

test("interrupted process retains its gate and reservation for reconciliation", async (t) => {
  const f = await fixture(t);
  const script = `import {FileAttemptReservation} from './src/orchestration/file-attempt-reservation.ts'; import {PolicyCoordination} from './src/orchestration/policy-coordination.ts'; const r=new FileAttemptReservation(process.argv[2]); const c=new PolicyCoordination(process.argv[1],r); await c.beginAttempt(process.argv[3],'explicit-policy-approval'); await r.reserveAttempt(${JSON.stringify(f.identity)},${JSON.stringify(f.binding)});`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, f.repository, f.directory, f.commit], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal((await readdir(f.directory)).includes(".policy-gate.json"), true);
  assert.equal((await readdir(f.directory)).includes(`${attemptDigest(f.identity)}.reservation.json`), true);
  await assert.rejects(f.coordination.promote(f.commit, "later-approval"));
  assert.equal(await f.reservation.reserveAttempt(f.identity, f.binding), "ALREADY_RESERVED");
});

test("validated response releases gate with retained claim, not promotion authority", async (t) => {
  const f = await fixture(t);
  const result = await createPlannerHandoff(hostFor(f.context), f.reservation, f.coordination)(f.context, policy);
  assert.equal(result.status, "BLOCKED", JSON.stringify(result));
  assert.equal((await readdir(f.directory)).includes(".policy-gate.json"), false);
  assert.equal((await readdir(f.directory)).includes(`${attemptDigest(f.identity)}.completion.json`), true);
  assert.equal(await f.reservation.reserveAttempt(f.identity, f.binding), "ALREADY_RESERVED");
  // Promotion still requires a distinct explicit approval evidence value.
  await assert.rejects(f.coordination.promote(f.commit, ""));
});

test("legacy and corrupt claims block promotion without erasing evidence", async (t) => {
  const f = await fixture(t);
  const legacy = join(f.directory, `${"a".repeat(64)}.reservation.json`);
  await writeFile(legacy, JSON.stringify({ version: 1, digest: "a".repeat(64), identity: [] }));
  await assert.rejects(f.coordination.promote(f.commit, "later-approval"));
  assert.equal((await readdir(f.directory)).includes(".policy-gate.json"), false);
  assert.equal(await readFile(legacy, "utf8"), JSON.stringify({ version: 1, digest: "a".repeat(64), identity: [] }));
  await writeFile(legacy, "{");
  await assert.rejects(f.coordination.promote(f.commit, "later-approval"));
  assert.equal(await readFile(legacy, "utf8"), "{");
});

test("corrupt completion evidence blocks promotion after a clean gate release", async (t) => {
  const f = await fixture(t);
  const gate = await f.coordination.beginAttempt(f.commit, "explicit-policy-approval");
  await f.reservation.reserveAttempt(f.identity, f.binding);
  const digest = attemptDigest(f.identity);
  await gate.complete("NO_DISPATCH", digest);
  const completion = join(f.directory, `${digest}.completion.json`);
  await writeFile(completion, "{");
  await assert.rejects(f.coordination.promote(f.commit, "later-approval"));
  assert.equal(await readFile(completion, "utf8"), "{");
  assert.equal((await readdir(f.directory)).includes(`${digest}.reservation.json`), true);
});
