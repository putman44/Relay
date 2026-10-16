import 'dotenv/config';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { monitorReplies } from '../../src/outreach/reply-monitor.js';
import { GmailThreadUnavailableError } from '../../src/gmail/gmail-thread-reader.js';

test('Reply monitor database: durable detection and safe polling', { skip: !process.env.RELAY_DRAFT_TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.RELAY_DRAFT_TEST_DATABASE_URL!;
  const schema = `reply_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema}` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => { await database.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const directory = new URL('../../migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(f => f.endsWith('.sql')).sort()) {
    await database.query(await readFile(new URL(file, directory), 'utf8'));
  }
  const seed = async () => {
    const prospect = randomUUID(), draft = randomUUID(), thread = randomUUID();
    await database.query(`INSERT INTO prospects (id,company_name,stage) VALUES ($1,'Test','outreach_sent')`, [prospect]);
    await database.query(`INSERT INTO message_drafts
      (id,prospect_id,recipient_email,subject,body,gmail_thread_id,send_status,sent_at,sent_message_id)
      VALUES ($1,$2,'person@example.com','Subject','Body',$3,'sent',now() - interval '1 day','sent-message')`, [draft, prospect, thread]);
    return { prospect, draft, thread };
  };
  const reply = (thread: string, id = 'reply', at = Date.now()) => ({ id: thread, messages: [
    { id: 'sent-message', threadId: thread, internalDate: String(Date.now() - 86400000), labelIds: ['SENT'] },
    { id, threadId: thread, internalDate: String(at), labelIds: ['INBOX'], snippet: 'Hi' },
  ] });
  const clear = async () => { await database.query('DELETE FROM prospects'); };

  await t.test('idempotent repeated and concurrent polls retain exact inbound identities', async () => {
    await clear(); const target = await seed();
    const reader = async () => reply(target.thread);
    const results = await Promise.all([monitorReplies(database, reader), monitorReplies(database, reader)]);
    assert.equal(results.reduce((sum, r) => sum + r.recorded, 0), 1);
    assert.equal((await monitorReplies(database, reader)).recorded, 0);
    const p = (await database.query('SELECT * FROM prospects WHERE id=$1', [target.prospect])).rows[0];
    assert.equal(p.stage, 'replied'); assert.equal(p.cold_outreach_blocked, true);
    await monitorReplies(database, async () => reply(target.thread, 'older', Date.now() - 10000));
    const latest = (await database.query('SELECT gmail_message_id FROM prospect_replies ORDER BY received_at DESC')).rows[0];
    assert.equal(latest.gmail_message_id, 'reply');
  });
  await t.test('reconciliation and in-flight send evidence are not reset by a reply', async () => {
    await clear(); const target = await seed();
    await database.query("UPDATE prospects SET stage='send_reconciliation' WHERE id=$1", [target.prospect]);
    await database.query(`INSERT INTO message_drafts (prospect_id,recipient_email,subject,body,send_status)
      VALUES ($1,'person@example.com','Other','Body','sending')`, [target.prospect]);
    await monitorReplies(database, async () => reply(target.thread));
    const p = (await database.query('SELECT * FROM prospects WHERE id=$1', [target.prospect])).rows[0];
    assert.equal(p.stage, 'send_reconciliation'); assert.equal(p.cold_outreach_blocked, true);
    assert.equal((await database.query("SELECT count(*) FROM message_drafts WHERE send_status='sending'")).rows[0].count, '1');
  });
  await t.test('transient failures are recorded and later retried without inventing replies', async () => {
    await clear(); const target = await seed();
    const result = await monitorReplies(database, async () => { throw new Error('auth failure'); });
    assert.equal(result.errors, 1); assert.equal(result.recorded, 0);
    assert.equal((await database.query('SELECT status FROM reply_thread_checks')).rows[0].status, 'error');
    assert.equal((await monitorReplies(database, async () => reply(target.thread))).recorded, 1);
    assert.equal((await database.query('SELECT status FROM reply_thread_checks')).rows[0].status, 'ok');
  });
  await t.test('unavailable threads block cold outreach and stop automatic polling', async () => {
    await clear(); const target = await seed();
    assert.equal((await monitorReplies(database, async () => { throw new GmailThreadUnavailableError(); })).unavailable, 1);
    assert.equal((await database.query('SELECT cold_outreach_blocked FROM prospects WHERE id=$1', [target.prospect])).rows[0].cold_outreach_blocked, true);
    const later = await monitorReplies(database, async () => { assert.fail('unavailable thread requires operator repair'); });
    assert.equal(later.checked, 0);
    assert.equal(later.attentionRequired, 1);
  });
  await t.test('a stale successful poll cannot clear a concurrently recorded unavailable state', async () => {
    await clear(); const target = await seed();
    let ready!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { ready = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const stale = monitorReplies(database, async () => { ready(); await resume; return reply(target.thread); });
    await reading;
    try {
      await monitorReplies(database, async () => { throw new GmailThreadUnavailableError(); });
    } finally { release(); }
    assert.equal((await stale).attentionRequired, 1);
    assert.equal((await database.query('SELECT status FROM reply_thread_checks')).rows[0].status, 'unavailable');
    assert.equal((await database.query('SELECT cold_outreach_blocked FROM prospects')).rows[0].cold_outreach_blocked, true);
  });
  await t.test('healthy threads without inbound messages remain unblocked', async () => {
    await clear(); const target = await seed();
    const result = await monitorReplies(database, async () => ({ id: target.thread, messages: [reply(target.thread).messages[0]!] }));
    assert.equal(result.recorded, 0); assert.equal(result.attentionRequired, 0);
    assert.equal((await database.query('SELECT cold_outreach_blocked FROM prospects')).rows[0].cold_outreach_blocked, false);
  });
  await t.test('bounded oldest-first polling reaches later records and ignores unsent drafts', async () => {
    await clear(); await seed(); await seed();
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) await monitorReplies(database, async id => { seen.push(id); return reply(id); }, 1);
    assert.equal(new Set(seen).size, 2);
    await assert.rejects(monitorReplies(database, async id => reply(id), 0));
  });
  await t.test('one Gmail failure does not prevent checking other candidates', async () => {
    await clear(); const failed = await seed(); await seed();
    const result = await monitorReplies(database, async id => {
      if (id === failed.thread) throw new Error('temporary failure');
      return reply(id);
    });
    assert.equal(result.checked, 2); assert.equal(result.errors, 1);
    assert.equal(result.recorded, 1); assert.equal(result.attentionRequired, 1);
  });
  await t.test('a draft changed during the Gmail read causes rollback without stale writes', async () => {
    await clear(); const target = await seed();
    await assert.rejects(monitorReplies(database, async () => {
      await database.query("UPDATE message_drafts SET gmail_thread_id='changed' WHERE id=$1", [target.draft]);
      return reply(target.thread);
    }), /changed during thread read/);
    assert.equal((await database.query('SELECT count(*) FROM prospect_replies')).rows[0].count, '0');
    assert.equal((await database.query('SELECT count(*) FROM reply_thread_checks')).rows[0].count, '0');
  });
});
