import '../../scripts/check-test-database.js';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import {
  createEmailCommunication,
  createResearchChunk,
  createResearchDocument,
} from '../../src/data/canonical-data.js';

test('Canonical data foundation: persistence and relational constraints', async t => {
  const connectionString = process.env.RELAY_DRAFT_TEST_DATABASE_URL!;
  const schema = `relay_canonical_data_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  const directory = new URL('../../migrations/', import.meta.url);
  const migrations = (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of migrations) await database.query(await readFile(new URL(name, directory), 'utf8'));

  const prospectId = randomUUID();
  const otherProspectId = randomUUID();
  const researchRequestId = randomUUID();
  await database.query('INSERT INTO prospects (id, company_name, website) VALUES ($1,$2,$3),($4,$5,$6)', [
    prospectId, 'Canonical Data Fixture', 'https://canonical-data-fixture.com/',
    otherProspectId, 'Other Fixture', 'https://other-canonical-fixture.com/',
  ]);
  await database.query(`INSERT INTO prospect_research_requests (
    id, prospect_id, status, owner_token, input_snapshot, drive_parent_id
  ) VALUES ($1,$2,'researching',$3,$4,$5)`, [
    researchRequestId, prospectId, randomUUID(), JSON.stringify({ website: 'https://canonical-data-fixture.com/' }),
    'test_drive_parent',
  ]);

  let documentId = '';
  await t.test('persists a research document bound to its prospect and request', async () => {
    const document = await createResearchDocument({
      prospectId,
      researchRequestId,
      sourceUrl: 'https://canonical-data-fixture.com/about',
      pageType: 'about',
      title: 'About the fixture',
      content: 'Durable source content.',
      scrapedAt: new Date('2026-11-02T12:00:00.000Z'),
    }, database);
    documentId = document.id;
    assert.equal(document.prospect_id, prospectId);
    assert.equal(document.research_request_id, researchRequestId);
    assert.equal(document.source_url, 'https://canonical-data-fixture.com/about');
    await assert.rejects(createResearchDocument({
      prospectId: otherProspectId,
      researchRequestId,
      sourceUrl: 'https://canonical-data-fixture.com/mismatch',
      pageType: 'other',
      title: null,
      content: 'Must not persist.',
      scrapedAt: new Date(),
    }, database));
  });

  await t.test('persists a research chunk with the document source and no embedding', async () => {
    const chunk = await createResearchChunk({
      prospectId,
      researchDocumentId: documentId,
      content: 'A smaller durable section.',
      chunkIndex: 0,
    }, database);
    assert.equal(chunk.research_document_id, documentId);
    assert.equal(chunk.source_url, 'https://canonical-data-fixture.com/about');
    assert.equal(chunk.embedding, null);
    await assert.rejects(createResearchChunk({
      prospectId: otherProspectId,
      researchDocumentId: documentId,
      content: 'Wrong prospect.',
      chunkIndex: 1,
    }, database));
    await assert.rejects(database.query(`INSERT INTO research_chunks (
      prospect_id, research_document_id, content, embedding, source_url, chunk_index
    ) VALUES ($1,$2,$3,$4,$5,$6)`, [
      prospectId, documentId, 'Premature embedding.', '[1,2,3]',
      'https://canonical-data-fixture.com/about', 1,
    ]));
  });

  await t.test('persists inbound and outbound email communications', async () => {
    const inbound = await createEmailCommunication({
      prospectId,
      direction: 'inbound',
      gmailMessageId: 'gmail-inbound-fixture',
      gmailThreadId: 'gmail-thread-fixture',
      subject: 'Re: Hello',
      body: 'Thanks for reaching out.',
      receivedAt: new Date('2026-11-02T13:00:00.000Z'),
    }, database);
    const outbound = await createEmailCommunication({
      prospectId,
      direction: 'outbound',
      gmailMessageId: 'gmail-outbound-fixture',
      gmailThreadId: 'gmail-thread-fixture',
      subject: 'Hello',
      body: 'A human-approved message.',
      sentAt: new Date('2026-11-02T12:30:00.000Z'),
    }, database);
    assert.equal(inbound.status, 'received');
    assert.equal(inbound.sent_at, null);
    assert.equal(outbound.status, 'sent');
    assert.equal(outbound.received_at, null);
    await assert.rejects(createEmailCommunication({
      prospectId: randomUUID(),
      direction: 'inbound',
      gmailMessageId: 'gmail-missing-prospect',
      gmailThreadId: null,
      subject: '',
      body: '',
      receivedAt: new Date(),
    }, database));
  });
});
