import "dotenv/config";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { createOutreachDraft } from "../../src/outreach/outreach-draft-creation.js";
import type { OutreachDraftContent } from "../../src/outreach/outreach-draft-content.js";

test("Outreach draft creation: durable reservation and review-only finalization", {
  skip: !process.env.RELAY_DRAFT_TEST_DATABASE_URL,
}, async (t) => {
  // Apply migrations only to a fresh isolated schema, never the existing tables.
  // Explicit opt-in avoids creating schemas in the normal configured database.
  const connectionString = process.env.RELAY_DRAFT_TEST_DATABASE_URL;
  assert.ok(connectionString, "Set RELAY_DRAFT_TEST_DATABASE_URL to a disposable Postgres database.");
  const schema = `relay_draft_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const database = new Pool({
    connectionString,
    options: `-c search_path=${schema}`,
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const migrations = [
    "001_create_prospects.sql", "002_create_message_drafts.sql", "003_add_send_status.sql",
    "004_add_send_reconciliation.sql", "005_add_prospect_stage_constraint.sql",
    "006_create_outreach_jobs.sql", "007_create_outreach_draft_requests.sql",
  ];
  const sql = await Promise.all(migrations.map((name) => readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8")));
  await database.query(sql.join("\n"));

  const input = async (): Promise<OutreachDraftContent> => {
    const prospectId = randomUUID();
    await database.query(
      "INSERT INTO prospects (id, company_name, contact_email) VALUES ($1, 'Draft Test', 'person@example.com')",
      [prospectId],
    );
    return { requestId: randomUUID(), prospectId, recipientEmail: "person@example.com", subject: "Supplied subject", body: "Supplied body." };
  };
  const created = () => ({ draftId: randomUUID(), messageId: randomUUID(), threadId: randomUUID() });

  await t.test("persists reservation before Gmail, then produces an unapproved pending draft without queueing", async () => {
    const data = await input();
    const gmail = created();
    const draft = await createOutreachDraft(data, { database, createGmailDraft: async (raw) => {
      assert.match(Buffer.from(raw, "base64url").toString(), /To: person@example.com/);
      const requests = await database.query("SELECT status FROM outreach_draft_requests WHERE id = $1", [data.requestId]);
      assert.equal(requests.rows[0].status, "creating");
      return gmail;
    } });
    assert.equal(draft.id, data.requestId);
    assert.equal(draft.subject, data.subject);
    assert.equal(draft.body, data.body);
    assert.equal(draft.gmail_draft_id, gmail.draftId);
    assert.equal(draft.review_status, "needs_review");
    assert.equal(draft.send_status, "pending");
    assert.equal((await database.query("SELECT stage FROM prospects WHERE id = $1", [data.prospectId])).rows[0].stage, "draft_ready");
    assert.equal((await database.query("SELECT count(*) FROM outreach_jobs")).rows[0].count, "0");
    await assert.rejects(createOutreachDraft(data, { database, createGmailDraft: async () => { assert.fail("must not retry"); } }));
  });

  await t.test("concurrent requests allow only one Gmail invocation", async () => {
    const data = await input();
    let calls = 0;
    const createGmailDraft = async () => { calls++; return created(); };
    const results = await Promise.allSettled([
      createOutreachDraft(data, { database, createGmailDraft }),
      createOutreachDraft({ ...data, requestId: randomUUID() }, { database, createGmailDraft }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(calls, 1);
  });

  await t.test("an uncertain Gmail failure is durable and prevents every automatic retry", async () => {
    const data = await input();
    let calls = 0;
    const createGmailDraft = async () => { calls++; throw new Error("lost response"); };
    await assert.rejects(createOutreachDraft(data, { database, createGmailDraft }), /requires reconciliation/);
    const request = (await database.query("SELECT * FROM outreach_draft_requests WHERE id = $1", [data.requestId])).rows[0];
    assert.equal(request.status, "needs_reconciliation");
    assert.equal(request.gmail_draft_id, null);
    await assert.rejects(createOutreachDraft({ ...data, requestId: randomUUID() }, { database, createGmailDraft }));
    assert.equal(calls, 1);
    assert.equal((await database.query("SELECT count(*) FROM message_drafts WHERE prospect_id = $1", [data.prospectId])).rows[0].count, "0");
    assert.equal((await database.query("SELECT stage FROM prospects WHERE id = $1", [data.prospectId])).rows[0].stage, "researching");
  });

  await t.test("a prospect edit after Gmail preserves returned IDs for reconciliation", async () => {
    const data = await input();
    const gmail = created();
    await assert.rejects(createOutreachDraft(data, { database, createGmailDraft: async () => {
      await database.query("UPDATE prospects SET contact_email = 'changed@example.com' WHERE id = $1", [data.prospectId]);
      return gmail;
    } }), /requires reconciliation/);
    const request = (await database.query("SELECT * FROM outreach_draft_requests WHERE id = $1", [data.requestId])).rows[0];
    assert.equal(request.status, "needs_reconciliation");
    assert.equal(request.gmail_draft_id, gmail.draftId);
    assert.equal(request.gmail_message_id, gmail.messageId);
    assert.equal(request.gmail_thread_id, gmail.threadId);
    assert.equal((await database.query("SELECT count(*) FROM message_drafts WHERE id = $1", [data.requestId])).rows[0].count, "0");
  });

  await t.test("a finalization database failure rolls back review state and retains recovery IDs", async () => {
    const data = await input();
    const gmail = created();
    const other = await input();
    await database.query(
      "INSERT INTO message_drafts (prospect_id, recipient_email, subject, body, gmail_draft_id) VALUES ($1, $2, $3, $4, $5)",
      [other.prospectId, other.recipientEmail, other.subject, other.body, gmail.draftId],
    );
    await assert.rejects(createOutreachDraft(data, { database, createGmailDraft: async () => gmail }), /requires reconciliation/);
    assert.equal((await database.query("SELECT status FROM outreach_draft_requests WHERE id = $1", [data.requestId])).rows[0].status, "needs_reconciliation");
    assert.equal((await database.query("SELECT stage FROM prospects WHERE id = $1", [data.prospectId])).rows[0].stage, "researching");
  });

  await t.test("missing prospects, invalid copy, mismatched recipients and wrong stages never reach Gmail", async () => {
    const data = await input();
    const createGmailDraft = async () => { assert.fail("Gmail must not be invoked"); };
    for (const change of [{ prospectId: randomUUID() }, { recipientEmail: "other@example.com" }, { subject: "" }]) {
      await assert.rejects(createOutreachDraft({ ...data, ...change }, { database, createGmailDraft }));
    }
    await database.query("UPDATE prospects SET stage = 'outreach_sent' WHERE id = $1", [data.prospectId]);
    await assert.rejects(createOutreachDraft(data, { database, createGmailDraft }));
    assert.equal((await database.query("SELECT count(*) FROM outreach_draft_requests WHERE prospect_id = $1", [data.prospectId])).rows[0].count, "0");
  });

  await t.test("an incomplete Gmail result cannot become a reviewable draft", async () => {
    const data = await input();
    await assert.rejects(createOutreachDraft(data, { database, createGmailDraft: async () => ({
      draftId: "partial-draft-id", messageId: "", threadId: "",
    }) }), /requires reconciliation/);
    const request = (await database.query("SELECT status, gmail_draft_id FROM outreach_draft_requests WHERE id = $1", [data.requestId])).rows[0];
    assert.equal(request.status, "needs_reconciliation");
    assert.equal(request.gmail_draft_id, "partial-draft-id");
    assert.equal((await database.query("SELECT count(*) FROM message_drafts WHERE id = $1", [data.requestId])).rows[0].count, "0");
  });

  await t.test("database outage after Gmail leaves a creating reservation that blocks retries", async () => {
    const data = await input();
    let connects = 0;
    const unavailable = new Proxy(database, {
      get(target, key) {
        if (key === "connect") return async () => {
          if (++connects > 1) throw new Error("database unavailable");
          return target.connect();
        };
        if (key === "query") return async () => { throw new Error("database unavailable"); };
        return Reflect.get(target, key);
      },
    });
    await assert.rejects(createOutreachDraft(data, { database: unavailable, createGmailDraft: async () => created() }), /requires reconciliation/);
    assert.equal((await database.query("SELECT status FROM outreach_draft_requests WHERE id = $1", [data.requestId])).rows[0].status, "creating");
    await assert.rejects(createOutreachDraft({ ...data, requestId: randomUUID() }, {
      database, createGmailDraft: async () => { assert.fail("must not retry after outage"); },
    }));
  });

  await t.test("existing outreach drafts and interrupted creating requests block new Gmail calls", async () => {
    for (const mode of ["draft", "creating"]) {
      const data = await input();
      if (mode === "draft") {
        await database.query("INSERT INTO message_drafts (prospect_id, recipient_email, subject, body) VALUES ($1, $2, $3, $4)", [data.prospectId, data.recipientEmail, data.subject, data.body]);
      } else {
        await database.query("INSERT INTO outreach_draft_requests (id, prospect_id, recipient_email, subject, body) VALUES ($1, $2, $3, $4, $5)", [data.requestId, data.prospectId, data.recipientEmail, data.subject, data.body]);
      }
      await assert.rejects(createOutreachDraft({ ...data, requestId: randomUUID() }, { database, createGmailDraft: async () => { assert.fail("must not create another draft"); } }));
    }
  });
});
