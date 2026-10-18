import '../../scripts/check-test-database.js';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createProspectFromIntake, type ProspectIntakeInput } from '../../src/intake/prospect-intake.js';

test('Prospect intake: durable creation, idempotency and duplicate protection', async t => {
  const connectionString = process.env.RELAY_DRAFT_TEST_DATABASE_URL!;
  const schema = `relay_intake_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema}` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  const dir = new URL('../../migrations/', import.meta.url);
  const migrations = (await readdir(dir)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of migrations) await database.query(await readFile(new URL(name, dir), 'utf8'));

  const base = (requestId = randomUUID()): ProspectIntakeInput => ({
    requestId,
    companyName: 'Relay Intake Fixture',
    website: 'https://relay-intake-fixture.com/',
    industry: 'Home services',
    contactName: null,
    contactEmail: 'hello@relay-intake-fixture.com',
    primaryDiscoveryQuestion: 'How are new inquiries routed?',
  });

  await t.test('creates one researching prospect and one intake journal', async () => {
    const input = base();
    const result = await createProspectFromIntake(input, database);
    assert.equal(result.created, true);
    assert.equal(result.stage, 'researching');
    const prospect = (await database.query('SELECT * FROM prospects WHERE id = $1', [result.prospectId])).rows[0];
    assert.equal(prospect.company_name, input.companyName);
    assert.equal(prospect.website, input.website);
    assert.equal(prospect.industry, input.industry);
    assert.equal(prospect.contact_email, input.contactEmail);
    assert.equal(prospect.primary_discovery_question, input.primaryDiscoveryQuestion);
    const journal = (await database.query('SELECT * FROM prospect_intake_requests WHERE id = $1', [input.requestId])).rows[0];
    assert.equal(journal.prospect_id, result.prospectId);
  });

  await t.test('same request and same site are idempotent without resetting stage', async () => {
    const input = { ...base(), website: 'https://idempotent-intake.com/' };
    const first = await createProspectFromIntake(input, database);
    await database.query("UPDATE prospects SET stage = 'research_review' WHERE id = $1", [first.prospectId]);
    const second = await createProspectFromIntake(input, database);
    assert.equal(second.created, false);
    assert.equal(second.prospectId, first.prospectId);
    assert.equal(second.stage, 'research_review');
    assert.equal((await database.query('SELECT count(*) FROM prospects WHERE website = $1', [input.website])).rows[0].count, '1');
  });

  await t.test('concurrent identical submissions create one prospect', async () => {
    const input = { ...base(), website: 'https://concurrent-intake.com/' };
    const results = await Promise.all([
      createProspectFromIntake(input, database),
      createProspectFromIntake(input, database),
    ]);
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(results[0]!.prospectId, results[1]!.prospectId);
    assert.equal((await database.query('SELECT count(*) FROM prospects WHERE website = $1', [input.website])).rows[0].count, '1');
  });

  await t.test('same request with changed input and same website with changed input both fail closed', async () => {
    const input = { ...base(), website: 'https://conflict-intake.com/' };
    await createProspectFromIntake(input, database);
    await assert.rejects(createProspectFromIntake({ ...input, companyName: 'Different Company' }, database));
    await assert.rejects(createProspectFromIntake({ ...input, requestId: randomUUID(), industry: 'Different Industry' }, database));
  });

  await t.test('legacy prospect on the same site blocks intake instead of creating a duplicate', async () => {
    const website = 'https://legacy-intake.com/';
    await database.query('INSERT INTO prospects (company_name, website) VALUES ($1,$2)', ['Legacy Intake', website]);
    await assert.rejects(createProspectFromIntake({ ...base(), requestId: randomUUID(), website }, database));
    assert.equal((await database.query('SELECT count(*) FROM prospects WHERE website = $1', [website])).rows[0].count, '1');
  });
});
