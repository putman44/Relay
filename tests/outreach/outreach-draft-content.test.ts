// tests/outreach/outreach-draft-content.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildOutreachDraftMime, type OutreachDraftContent } from "../../src/outreach/outreach-draft-content.js";
import { parseOutreachDraftArgs, parseOutreachDraftInput } from "../../src/operator/outreach-draft-input.js";

const input: OutreachDraftContent = {
  requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  prospectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  recipientEmail: "person@example.com",
  subject: "A question — café ☕ ".repeat(5),
  body: "Hi there,\n\nHere is supplied copy: café ☕\nBcc: body text only",
};

test("Outreach draft MIME: preserves UTF-8 copy with exactly one recipient and a stable reconciliation ID", () => {
  const mime = Buffer.from(buildOutreachDraftMime(input), "base64url").toString("utf8");
  const [headers, body] = mime.split("\r\n\r\n");
  assert.ok(headers && body);
  assert.match(headers, /^To: person@example.com\r?$/m);
  assert.doesNotMatch(headers, /^(Cc|Bcc):/mi);
  assert.match(headers, /Message-ID:\r\n <relay-outreach-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa@relay.invalid>/);
  const subject = [...headers.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
    .map((m) => Buffer.from(m[1]!, "base64").toString("utf8")).join("");
  assert.equal(subject, input.subject);
  assert.equal(Buffer.from(body, "base64").toString("utf8"), input.body);
  assert.ok(headers.split("\r\n").every((line) => line.length <= 78));
});

test("Outreach draft input: rejects malformed IDs, header injection, multiple recipients and empty copy", () => {
  for (const change of [
    { requestId: "bad-id" }, { prospectId: "bad-id" },
    { recipientEmail: "a@example.com,b@example.com" },
    { recipientEmail: "a@example.com\r\nBcc: b@example.com" },
    { recipientEmail: "[email protected]" },
    { recipientEmail: "*hidden@example.com" }, { recipientEmail: "a..b@example.com" },
    { recipientEmail: "a@-example.com" }, { recipientEmail: "a@example..com" },
    { subject: "Hello\r\nBcc: b@example.com" }, { subject: " " },
    { body: " " }, { body: "bad\0copy" }, { body: "a".repeat(100_001) },
  ]) assert.throws(() => buildOutreachDraftMime({ ...input, ...change }));
  assert.throws(() => parseOutreachDraftInput({ ...input, cc: "other@example.com" }));
  assert.throws(() => parseOutreachDraftInput({ ...input, subject: 42 }));
  assert.throws(() => parseOutreachDraftInput(null));
  assert.deepEqual(parseOutreachDraftInput(input), input);
});

test("Outreach draft CLI: requires exact creation confirmation and rejects extra arguments", () => {
  assert.equal(parseOutreachDraftArgs(["--input", "draft.json", "--confirm-create-draft"]), "draft.json");
  for (const args of [[], ["--input", "draft.json"], ["--input", "--confirm-create-draft"],
    ["--input", "draft.json", "--confirm-create-draft", "--send"]]) {
    assert.throws(() => parseOutreachDraftArgs(args), /Usage:/);
  }
});
