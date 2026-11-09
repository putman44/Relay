import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, chmod, readFile, readdir, rm, symlink, unlink, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { FileAttemptReservation, type ReservationIO } from "../../src/orchestration/file-attempt-reservation.js";
import type { PlannerAttemptIdentity } from "../../src/orchestration/planner-handoff.js";
import { open, type FileHandle } from "node:fs/promises";

const identity: PlannerAttemptIdentity = {
  canonicalHost: "github.com", canonicalRepository: "putman44/Relay", issueNumber: 30,
  runId: "run-1", taskId: "planner", attemptId: "attempt-1",
};
const binding = { policyDigest: "b".repeat(64), sourceCommit: "a".repeat(40), requirementsVersion: "requirements-v1" };
const directory = async (t: TestContext) => {
  const path = await mkdtemp(join(await realpath(tmpdir()), "relay-reservation-"));
  t.after(async () => { await rm(path, { recursive: true, force: true }); });
  return path;
};
const file = async (path: string) => join(path, (await readdir(path))[0]!);

// Fail after the actual operation to model an outcome whose side effect may have happened.
function failingIO(operation: "writeFile" | "sync" | "close", target: "file" | "directory" = "file"): ReservationIO {
  let failed = false;
  return { async open(path, flags, mode) {
    const handle = await open(path, flags, mode);
    const selected = target === "directory" ? !path.endsWith(".reservation.json") : path.endsWith(".reservation.json");
    if (!selected || failed) return handle;
    return new Proxy(handle, { get(value, key) {
      if (key === operation) return async (...args: unknown[]) => {
        failed = true;
        await (value[key] as (...args: unknown[]) => Promise<unknown>).apply(value, args);
        throw new Error(`uncertain ${operation}`);
      };
      const member = value[key as keyof FileHandle];
      return typeof member === "function" ? member.bind(value) : member;
    } }) as FileHandle;
  } };
}

test("exclusive claim and concurrent independent instances", async (t) => {
  const path = await directory(t);
  const outcomes = await Promise.allSettled(Array.from({ length: 16 }, () =>
    new FileAttemptReservation(path).reserveAttempt(identity, binding)));
  const successful = outcomes.filter((outcome) => outcome.status === "fulfilled").map((outcome) => outcome.value);
  assert.equal(successful.filter((result) => result === "RESERVED").length, 1);
  assert.ok(successful.every((result) => result === "RESERVED" || result === "ALREADY_RESERVED"));
  assert.ok(outcomes.filter((outcome) => outcome.status === "rejected").every((outcome) => outcome.reason instanceof Error));
  assert.equal((await readdir(path)).length, 1);
  assert.equal(await new FileAttemptReservation(path).reserveAttempt(identity, binding), "ALREADY_RESERVED");
});

test("restart and separate process reject the same attempt", async (t) => {
  const path = await directory(t);
  assert.equal(await new FileAttemptReservation(path).reserveAttempt(identity, binding), "RESERVED");
  const script = `import {FileAttemptReservation} from './src/orchestration/file-attempt-reservation.ts'; const result=await new FileAttemptReservation(process.argv[1]).reserveAttempt(${JSON.stringify(identity)}, ${JSON.stringify(binding)}); process.stdout.write(result);`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "ALREADY_RESERVED");
});

test("amended requirements version cannot claim the same attempt", async (t) => {
  const path = await directory(t);
  const provider = new FileAttemptReservation(path);
  assert.equal(await provider.reserveAttempt(identity, binding), "RESERVED");
  await assert.rejects(provider.reserveAttempt({ ...identity }, { ...binding, requirementsVersion: "requirements-v2" }));
  assert.equal(await provider.reserveAttempt({ ...identity }, binding), "ALREADY_RESERVED");
  await assert.rejects(provider.reserveAttempt({ ...identity, requirementsVersion: "v2" } as PlannerAttemptIdentity, binding));
});

test("invalid identity and unsafe storage are rejected", async (t) => {
  const path = await directory(t);
  const provider = new FileAttemptReservation(path);
  for (const invalid of [{ ...identity, issueNumber: 0 }, { ...identity, runId: " " }, { ...identity, attemptId: "\n" }]) {
    await assert.rejects(provider.reserveAttempt(invalid, binding));
  }
  assert.throws(() => new FileAttemptReservation("relative"));
  assert.throws(() => new FileAttemptReservation(`${path}/../other`));
  const link = `${path}-link`;
  await symlink(path, link);
  t.after(async () => { await unlink(link); });
  await assert.rejects(new FileAttemptReservation(link).reserveAttempt(identity, binding));
  await chmod(path, 0o777);
  await assert.rejects(provider.reserveAttempt(identity, binding));
});

test("corrupt and partial existing records fail closed", async (t) => {
  const path = await directory(t);
  const provider = new FileAttemptReservation(path);
  assert.equal(await provider.reserveAttempt(identity, binding), "RESERVED");
  const reservation = await file(path);
  const original = await readFile(reservation, "utf8");
  for (const content of ["{", original.slice(0, -3), original.replace("attempt-1", "attempt-2")]) {
    await writeFile(reservation, content);
    await assert.rejects(provider.reserveAttempt(identity, binding));
  }
});

test("uncertain write, file sync, close, and directory sync never grant a second claim", async (t) => {
  for (const [operation, target] of [
    ["writeFile", "file"], ["sync", "file"], ["close", "file"], ["sync", "directory"], ["close", "directory"],
  ] as const) {
    const path = await directory(t);
    await assert.rejects(new FileAttemptReservation(path, failingIO(operation, target)).reserveAttempt(identity, binding));
    assert.equal((await readdir(path)).length, 1);
    const second = await new FileAttemptReservation(path).reserveAttempt(identity, binding).catch(() => "HELD");
    assert.notEqual(second, "RESERVED");
  }
});
