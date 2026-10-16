import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildOutreachDraftMime } from "../../src/outreach/outreach-draft-content.js";
import { verifyGmailDraftSnapshot, type GmailDraftSnapshot, type GmailDraftReadApi } from "../../src/gmail/gmail-draft-preflight.js";
import { GmailPreflightError } from "../../src/gmail/gmail-preflight-error.js";
import { createVerifiedGmailDraftSender } from "../../src/gmail/gmail-verified-draft-sender.js";
import type { GmailDraftApi } from "../../src/gmail/gmail-draft-sender.js";

const content = {
  requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  prospectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  recipientEmail: "person@example.com",
  subject: "Approved question — café ☕",
  body: "Hi there,\n\nApproved copy — café ☕\n",
};
const approved = { ...content, threadId: "thread-1" };
const raw = buildOutreachDraftMime(content);
const snapshot = (): GmailDraftSnapshot => ({
  id: "draft-1",
  message: { id: "message-1", threadId: "thread-1", labelIds: ["DRAFT"], raw },
});
const changeMime = (change: (mime: string) => string): GmailDraftSnapshot => ({
  ...snapshot(), message: { ...snapshot().message,
    raw: Buffer.from(change(Buffer.from(raw, "base64url").toString())).toString("base64url"),
  },
});

test("Gmail preflight: validates UTF-8 MIME against approved database content", async () => {
  assert.deepEqual(await verifyGmailDraftSnapshot("draft-1", approved, snapshot()), { raw, threadId: "thread-1" });
  await verifyGmailDraftSnapshot("draft-1", { ...approved, body: content.body.replaceAll("\n", "\r\n") }, snapshot());
});

test("Gmail preflight: rejects changed or incomplete draft/thread identity and non-drafts", async () => {
  for (const candidate of [
    { ...snapshot(), id: "other" }, {}, { id: "draft-1" },
    { ...snapshot(), message: { ...snapshot().message, id: "" } },
    { ...snapshot(), message: { ...snapshot().message, threadId: "other" } },
    { ...snapshot(), message: { ...snapshot().message, labelIds: ["SENT"] } },
    { ...snapshot(), message: { ...snapshot().message, labelIds: ["DRAFT", "SENT"] } },
    { ...snapshot(), message: { ...snapshot().message, raw: "not valid base64" } },
    { ...snapshot(), message: { ...snapshot().message, raw: "A".repeat(350_001) } },
  ]) await assert.rejects(verifyGmailDraftSnapshot("draft-1", approved, candidate), GmailPreflightError);
});

test("Gmail preflight: rejects extra, duplicated, grouped and hidden recipient headers", async () => {
  for (const header of [
    "Cc: other@example.com", "Bcc: other@example.com", "bCc:",
    "Resent-To: other@example.com", "Reply-To: other@example.com",
    "Apparently-To: other@example.com", "To: other@example.com",
    "Bcc : other@example.com", "X-Header: bad\x0bvalue",
    "X-Header: bad\rBcc: other@example.com",
  ]) {
    await assert.rejects(verifyGmailDraftSnapshot("draft-1", approved, changeMime((mime) => header + "\r\n" + mime)), GmailPreflightError);
  }
  for (const to of ["other@example.com", "person@example.com, other@example.com", "Group: person@example.com;"]) {
    await assert.rejects(verifyGmailDraftSnapshot("draft-1", approved, changeMime((mime) => mime.replace("To: person@example.com", `To: ${to}`))), GmailPreflightError);
  }
});

test("Gmail preflight: rejects edited subject/body and duplicated content headers", async () => {
  for (const change of [{ subject: "Changed" }, { body: "Changed" }, { body: content.body + " " }]) {
    const candidate = snapshot();
    candidate.message!.raw = buildOutreachDraftMime({ ...content, ...change });
    await assert.rejects(verifyGmailDraftSnapshot("draft-1", approved, candidate), GmailPreflightError);
  }
  for (const header of ["Subject: another", "Content-Type: text/plain", "Content-Transfer-Encoding: base64"]) {
    await assert.rejects(verifyGmailDraftSnapshot("draft-1", approved, changeMime((mime) => header + "\r\n" + mime)), GmailPreflightError);
  }
});

test("Gmail preflight: rejects HTML, multipart and attachments without an approved representation", async () => {
  for (const type of ["text/html", "multipart/alternative; boundary=x", "multipart/mixed; boundary=x", "application/octet-stream"]) {
    await assert.rejects(verifyGmailDraftSnapshot("draft-1", approved, changeMime((mime) => mime.replace('text/plain; charset="UTF-8"', type))), GmailPreflightError);
  }
  await assert.rejects(verifyGmailDraftSnapshot("draft-1", approved, changeMime((mime) => "Content-Disposition: attachment; filename=test.txt\r\n" + mime)), GmailPreflightError);
});

test("Verified sender: sends the inspected snapshot even if the mailbox changes after reading", async () => {
  let sends = 0;
  let mailboxRaw = raw;
  const api: GmailDraftApi & GmailDraftReadApi = { users: { drafts: {
    get: async (request) => {
      assert.deepEqual(request, { userId: "me", id: "draft-1", format: "raw" });
      const result = snapshot();
      mailboxRaw = "edited-after-read";
      return { data: result };
    },
    send: async (request, options) => {
      sends++;
      assert.deepEqual(options, { retry: false });
      assert.equal(mailboxRaw, "edited-after-read");
      assert.deepEqual(request.requestBody, { id: "draft-1", message: { raw, threadId: "thread-1" } });
      return { data: { id: "sent-1", threadId: "thread-1" } };
    },
  } } };
  assert.equal((await createVerifiedGmailDraftSender(api)("draft-1", approved)).status, "sent");
  assert.equal(sends, 1);
});

test("Verified sender: missing approval, read failure and mismatches never invoke send", async () => {
  for (const mode of ["missing", "read-error", "mismatch"]) {
    const api: GmailDraftApi & GmailDraftReadApi = { users: { drafts: {
      get: async () => {
        if (mode === "missing") assert.fail("must not retrieve without approved content");
        if (mode === "read-error") throw new Error("Simulated API failure");
        return { data: { ...snapshot(), id: "other" } };
      },
      send: async () => { assert.fail("send must not be called"); },
    } } };
    await assert.rejects(createVerifiedGmailDraftSender(api)("draft-1", mode === "missing" ? undefined : approved), GmailPreflightError);
  }
});

test("Verified sender: errors after send invocation remain uncertain send errors", async () => {
  const failure = new Error("lost send response");
  const api: GmailDraftApi & GmailDraftReadApi = { users: { drafts: {
    get: async () => ({ data: snapshot() }),
    send: async () => { throw failure; },
  } } };
  await assert.rejects(createVerifiedGmailDraftSender(api)("draft-1", approved), (error) => error === failure);
});

test("Verified sender: incomplete send response is never misclassified as a preflight block", async () => {
  const api: GmailDraftApi & GmailDraftReadApi = { users: { drafts: {
    get: async () => ({ data: snapshot() }),
    send: async () => ({ data: { id: "sent-id" } }),
  } } };
  await assert.rejects(createVerifiedGmailDraftSender(api)("draft-1", approved), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof GmailPreflightError));
    assert.match(error.message, /incomplete message data/);
    return true;
  });
});
