import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectIssueContext } from "../../src/factory/context-selection.js";
import { preparePlannerHandoff } from "../../src/factory/orchestrator.js";

function fixture(repository: string) {
  const checkoutPath = mkdtempSync(join(tmpdir(), "factory-select-"));
  execFileSync("git", ["-C", checkoutPath, "init", "-q"]);
  execFileSync("git", ["-C", checkoutPath, "remote", "add", "origin", `https://github.com/${repository}.git`]);
  mkdirSync(join(checkoutPath, "src", "orchestration"), { recursive: true });
  mkdirSync(join(checkoutPath, "tests", "orchestration"), { recursive: true });
  const paths = ["src/orchestration/checkpoint-store.ts", "tests/orchestration/checkpoint.test.ts"];
  for (const path of paths) writeFileSync(join(checkoutPath, path), `export const file = '${path}';\n`);
  execFileSync("git", ["-C", checkoutPath, "add", "--", ...paths]);
  return { checkoutPath, paths };
}

function input(repository: string, checkoutPath: string, body: string) {
  return { repository, issueNumber: 26, issue: { number: 26, title: "Append only records", body },
    trustedConfiguration: { repository, planner: { model: "gpt-6.1-sol", reasoningEffort: "medium" } }, checkoutPath };
}

const body = "Check `src/orchestration/checkpoint-store.ts` and `tests/orchestration/checkpoint.test.ts`.";

test("Issue 26 style file scope ignores unrelated workflow paths", () => {
  const repository = "putman44/Relay";
  const { checkoutPath, paths } = fixture(repository);
  const issueBody = `The defect is in \`src/orchestration/checkpoint-store.ts\`.\n\n## File scope\n\n- \`src/orchestration/checkpoint-store.ts\`\n- \`tests/orchestration/checkpoint.test.ts\`\n\n## Safety\n\nFollow \`.agents/skills/relay-implement/SKILL.md\`.`;
  assert.deepEqual(selectIssueContext(input(repository, checkoutPath, issueBody)).paths, paths);
});

test("repeated issue-derived paths cannot create or reuse an approved live selection", async () => {
  const repository = "putman44/Relay";
  const { checkoutPath, paths } = fixture(repository);
  const approved = selectIssueContext(input(repository, checkoutPath, `\`${paths[0]}\``));
  const repeated = `\`${paths[0]}\` and \`${paths[0]}\``;
  assert.throws(() => selectIssueContext(input(repository, checkoutPath, repeated)), /Repeated issue paths/);
  let calls = 0;
  await assert.rejects(preparePlannerHandoff(26, repository, "fake-key",
    async () => input(repository, checkoutPath, repeated).issue,
    (async () => { calls++; throw new Error("Unexpected model call"); }) as typeof fetch,
    input(repository, checkoutPath, repeated).trustedConfiguration,
    { checkoutPath, approvalToken: approved.approvalToken }), /Repeated issue paths/);
  assert.equal(calls, 0);
});

for (const repository of ["putman44/Relay", "putman44/Parsity"]) {
  test(`${repository}: offline issue paths match manual validated context and require approval`, async () => {
    const { checkoutPath, paths } = fixture(repository);
    const selected = selectIssueContext(input(repository, checkoutPath, body));
    assert.deepEqual(selected.paths, paths);
    assert.deepEqual(selected.candidates.map(({ path }) => path), paths);
    assert.equal(JSON.stringify({ candidates: selected.candidates, approvalToken: selected.approvalToken }).includes("export const"), false);
    let calls = 0;
    const send = (async (_url: string, init: RequestInit) => {
      calls++;
      const request = JSON.parse(init.body as string);
      const payload = JSON.parse(request.input);
      assert.deepEqual(payload.repositoryContext, selected.files);
      const identity = payload.identity;
      return { ok: true, json: async () => ({ status: "completed", model: "gpt-6.1-sol", output: [
        { type: "message", content: [{ type: "output_text", text: JSON.stringify({ ...identity,
          role: "planner", status: "BLOCKED", reason: "Need input", recommendedNextAction: "Ask owner",
          evidenceReferences: [{ ...identity, referenceId: "issue", kind: "REQUIREMENTS",
            locator: `https://github.com/${repository}/issues/26` }] }) }] }] }) };
    }) as unknown as typeof fetch;
    const run = (approvalToken: string) => preparePlannerHandoff(26, repository, "fake-key",
      async () => input(repository, checkoutPath, body).issue, send,
      input(repository, checkoutPath, body).trustedConfiguration, { checkoutPath, approvalToken });
    await assert.rejects(run("wrong"), /Approved context does not match/);
    assert.equal(calls, 0);
    const result = await run(selected.approvalToken);
    assert.equal(result.status, "BLOCKED");
    assert.equal(calls, 1);
    const manual = selectIssueContext(input(repository, checkoutPath, body));
    assert.deepEqual(manual.files, selected.files);
    writeFileSync(join(checkoutPath, paths[0]!), "export const changed = true;\n");
    await assert.rejects(run(selected.approvalToken), /Approved context does not match/);
    assert.equal(calls, 1);
    await assert.rejects(preparePlannerHandoff(26, repository, "fake-key", async () => ({
      ...input(repository, checkoutPath, body).issue, body: body + " More requirements." }), send,
      input(repository, checkoutPath, body).trustedConfiguration, { checkoutPath, approvalToken: selected.approvalToken }),
    /Approved context does not match/);
    assert.equal(calls, 1);
  });
}

test("missing, ambiguous, untracked, excessive and unsafe candidates stop offline", () => {
  const repository = "putman44/Relay";
  const { checkoutPath, paths } = fixture(repository);
  for (const issueBody of ["No file named here", "See `src/missing.ts`", "See `../src/orchestration/checkpoint-store.ts`",
    "See `/src/orchestration/checkpoint-store.ts`", "See `src/.hidden.ts`",
    Array.from({ length: 9 }, (_, i) => `src/file${i}.ts`).join(" ")])
    assert.throws(() => selectIssueContext(input(repository, checkoutPath, issueBody)));
  writeFileSync(join(checkoutPath, "src", "orchestration", "untracked.ts"), "export const x = 1;");
  assert.throws(() => selectIssueContext(input(repository, checkoutPath, "`src/orchestration/untracked.ts`")));
  symlinkSync(join(checkoutPath, paths[0]!), join(checkoutPath, "src", "orchestration", "linked.ts"));
  execFileSync("git", ["-C", checkoutPath, "add", "--", "src/orchestration/linked.ts"]);
  assert.throws(() => selectIssueContext(input(repository, checkoutPath, "`src/orchestration/linked.ts`")), /Symlink/);
  writeFileSync(join(checkoutPath, "src", "orchestration", "credential.ts"), "export const x = 1;");
  execFileSync("git", ["-C", checkoutPath, "add", "--", "src/orchestration/credential.ts"]);
  assert.throws(() => selectIssueContext(input(repository, checkoutPath, "`src/orchestration/credential.ts`")), /Unsafe/);
  writeFileSync(join(checkoutPath, paths[0]!), "x".repeat(100_001));
  assert.throws(() => selectIssueContext(input(repository, checkoutPath, body)), /oversized/);
});

test("untrusted issue cannot change trusted repository or issue identity", () => {
  const { checkoutPath } = fixture("putman44/Relay");
  assert.throws(() => selectIssueContext(input("putman44/Parsity", checkoutPath, body)), /mismatch/);
  assert.throws(() => selectIssueContext({ ...input("putman44/Relay", checkoutPath, body), issueNumber: 27 }), /identity mismatch/);
});
