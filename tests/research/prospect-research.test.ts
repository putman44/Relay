import '../../scripts/check-test-database.js';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { startProspectResearch, resumeProspectResearch, retryFailedPreArtifactResearch,
  type ResearchDependencies } from '../../src/research/prospect-research.js';
import type { DriveArtifact } from '../../src/research/drive-artifacts.js';

test('Prospect research journals external artifacts and creates only review drafts', async t => {
  const connectionString = process.env.RELAY_DRAFT_TEST_DATABASE_URL!;
  const schema = `relay_research_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema}` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => { await database.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const dir = new URL('../../migrations/', import.meta.url);
  const migrations = (await readdir(dir)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  const policyMigration = '013_add_research_gmail_draft_policy.sql';
  for (const name of migrations.filter(name => name !== policyMigration)) {
    await database.query(await readFile(new URL(name, dir), 'utf8'));
  }
  const migratedProspectId = randomUUID(), migratedRequestId = randomUUID();
  await database.query('INSERT INTO prospects (id, company_name, website) VALUES ($1,$2,$3)',
    [migratedProspectId, 'Pre-migration Fixture', 'https://pre-migration.testsite.org/']);
  await database.query(`INSERT INTO prospect_research_requests
    (id,prospect_id,status,owner_token,input_snapshot,drive_parent_id)
    VALUES ($1,$2,'researching',$3,$4,$5)`,
  [migratedRequestId,migratedProspectId,randomUUID(),JSON.stringify({ company_name: 'Pre-migration Fixture',
    website: 'https://pre-migration.testsite.org/', industry: null, contact_email: null, contact_name: null,
    primary_discovery_question: null }),'parentfolder12345']);
  await database.query(await readFile(new URL(policyMigration, dir), 'utf8'));
  assert.equal((await database.query('SELECT gmail_draft_allowed FROM prospect_research_requests WHERE id = $1',
    [migratedRequestId])).rows[0].gmail_draft_allowed, false);
  await database.query('DELETE FROM prospects WHERE id = $1', [migratedProspectId]);

  const root = 'https://business.testsite.org/';
  const contact = 'https://business.testsite.org/contact';
  const parent = 'parentfolder12345';
  const fixtureResult = (email: string, fit = 'B') => ({
    companyName: 'Research Fixture', domain: 'business.testsite.org', website: root, industry: 'Home services',
    fit, fitReason: 'The site has a public customer contact route.',
    observedCustomerPaths: [{ path: 'Contact', observation: 'The site lists an email.', sourceUrl: contact }],
    publicToolsOrVendors: [], recommendedContact: { name: '', role: '', email, phone: '',
      sourceUrl: email ? contact : '', confidence: 'high' }, primaryHypothesis: 'Unknown inquiry routing.',
    hypothesisEvidence: ['Contact page has an email.'], unknowns: ['Response process'],
    primaryDiscoveryQuestion: 'How do you route inquiries?', secondaryDiscoveryQuestions: [],
    possibleExpansionOpportunities: [], outreachSubject: 'Question about inquiries',
    outreachBody: 'I saw your public contact page. How do you route inquiries?',
    sources: [{ url: root, whatItSupported: 'Business website' }, { url: contact, whatItSupported: 'Contact page' }],
    researchLimitations: [],
  });
  const evidence = { pages: [{ url: root, markdown: 'Home service.', links: [contact] },
    { url: contact, markdown: 'Contact hello@business.testsite.org', links: ['mailto:hello@business.testsite.org'] }], limitations: [] };
  const insertProspect = async () => {
    const id = randomUUID();
    await database.query('INSERT INTO prospects (id, company_name, website) VALUES ($1,$2,$3)',
      [id, 'Research Fixture', root]);
    return id;
  };
  const artifacts = new Map<string, DriveArtifact>();
  const briefs = new Map<string, string>();
  const calls = { folder: 0, brief: 0, gmail: 0, research: 0 };
  let output = fixtureResult('hello@business.testsite.org');
  let failGmail = false;
  let failDriveRead = false;
  const deps: ResearchDependencies = {
    database, driveParentId: parent,
    scrape: async url => {
      const page = evidence.pages.find(p => p.url === url);
      assert.ok(page);
      return page;
    },
    research: async () => { calls.research++; return output; },
    drive: {
      createFolder: async (id, parentId) => {
        calls.folder++;
        const artifact: DriveArtifact = { id: randomUUID().replaceAll('-', ''), mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId], appProperties: { relayResearchRequestId: id, relayArtifactKind: 'folder' } };
        artifacts.set(artifact.id, artifact);
        const state = (await database.query('SELECT status FROM prospect_research_requests WHERE id = $1', [id])).rows[0].status;
        assert.equal(state, 'folder_creating');
        return artifact;
      },
      createBrief: async (id, folderId, _name, text) => {
        calls.brief++;
        assert.match(text, /SOURCES/);
        briefs.set(id, text);
        const artifact: DriveArtifact = { id: randomUUID().replaceAll('-', ''), mimeType: 'application/vnd.google-apps.document',
          parents: [folderId], appProperties: { relayResearchRequestId: id, relayArtifactKind: 'brief' },
          webViewLink: 'https://docs.google.com/document/d/fake/edit' };
        artifacts.set(artifact.id, artifact);
        const state = (await database.query('SELECT status FROM prospect_research_requests WHERE id = $1', [id])).rows[0].status;
        assert.equal(state, 'brief_creating');
        return artifact;
      },
      get: async id => {
        if (failDriveRead) throw new Error('Drive read unavailable');
        const item = artifacts.get(id); assert.ok(item); return item;
      },
    },
    createGmailDraft: async raw => {
      calls.gmail++;
      if (failGmail) throw new Error('lost Gmail response');
      assert.match(Buffer.from(raw, 'base64url').toString('utf8'), /To: hello@business.testsite.org/);
      const decoded = Buffer.from(raw, 'base64url').toString('utf8');
      assert.match(decoded, /relay-outreach-/);
      const token = randomUUID();
      return { draftId: `draft-${token}`, messageId: `message-${token}`, threadId: `thread-${token}` };
    },
  };

  await t.test('success is one review-only draft and duplicate starts reach no providers', async () => {
    const id = await insertProspect();
    const request = await startProspectResearch(id, deps, { gmailDraftAllowed: true });
    assert.equal(request.status, 'completed');
    assert.equal(request.gmail_draft_allowed, true);
    const draft = (await database.query('SELECT * FROM message_drafts WHERE prospect_id = $1', [id])).rows[0];
    assert.equal(draft.id, request.id);
    assert.equal(draft.research_request_id, request.id);
    assert.equal(draft.review_status, 'needs_review');
    assert.equal(draft.send_status, 'pending');
    assert.equal((await database.query('SELECT count(*) FROM outreach_jobs WHERE draft_id = $1', [request.id])).rows[0].count, '0');
    assert.equal((await database.query('SELECT stage,contact_email FROM prospects WHERE id = $1', [id])).rows[0].stage, 'draft_ready');
    const before = { ...calls };
    await assert.rejects(startProspectResearch(id, deps, { gmailDraftAllowed: true }));
    assert.deepEqual(calls, before);
  });

  await t.test('missing public contact saves the brief and holds the draft', async () => {
    const id = await insertProspect();
    output = fixtureResult('');
    const before = calls.gmail;
    const request = await startProspectResearch(id, deps, { gmailDraftAllowed: true });
    assert.equal(request.status, 'needs_contact');
    assert.ok(request.brief_id);
    assert.equal(calls.gmail, before);
    assert.equal((await database.query('SELECT stage FROM prospects WHERE id = $1', [id])).rows[0].stage, 'needs_contact');
  });

  await t.test('concurrent starts reserve one request before provider work', async () => {
    const id = await insertProspect();
    output = fixtureResult('hello@business.testsite.org');
    const before = { ...calls };
    const settled = await Promise.allSettled([
      startProspectResearch(id, deps, { gmailDraftAllowed: true }),
      startProspectResearch(id, deps, { gmailDraftAllowed: true }),
    ]);
    assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(calls.research, before.research + 1);
    assert.equal(calls.folder, before.folder + 1);
    assert.equal(calls.brief, before.brief + 1);
    assert.equal(calls.gmail, before.gmail + 1);
  });

  await t.test('Drive verification failure retains its folder and blocks a second creation', async () => {
    const id = await insertProspect();
    failDriveRead = true;
    const before = { ...calls };
    await assert.rejects(startProspectResearch(id, deps, { gmailDraftAllowed: true }), /could not be verified/);
    const request = (await database.query('SELECT * FROM prospect_research_requests WHERE prospect_id = $1', [id])).rows[0];
    assert.equal(request.status, 'needs_reconciliation');
    assert.ok(request.folder_id);
    assert.equal(calls.folder, before.folder + 1);
    assert.equal(calls.brief, before.brief);
    await assert.rejects(resumeProspectResearch(request.id, deps));
    failDriveRead = false;
  });

  await t.test('C fit requires research review without a draft', async () => {
    const id = await insertProspect();
    output = fixtureResult('', 'C');
    const before = calls.gmail;
    const request = await startProspectResearch(id, deps, { gmailDraftAllowed: true });
    assert.equal(request.status, 'research_review');
    assert.equal(calls.gmail, before);
    const brief = briefs.get(request.id);
    assert.ok(brief);
    assert.match(brief, /SELECTED CONTACT\nName: Unknown\nRole: Unknown\nEmail: Not assigned/);
    assert.match(brief, /PUBLIC CONTACT LINKS \(NOT ATTRIBUTED TO THE SELECTED CONTACT\)\n- Email: hello@business\.testsite\.org \(https:\/\/business\.testsite\.org\/contact\)/);
    assert.doesNotMatch(brief, /PROPOSED OUTREACH FOR HUMAN REVIEW|Question about inquiries/);
  });

  await t.test('safe start persists Gmail disallowed and reaches research review without a draft', async () => {
    const id = await insertProspect();
    output = fixtureResult('hello@business.testsite.org', 'A');
    const before = calls.gmail;
    const request = await startProspectResearch(id, deps, { gmailDraftAllowed: false });
    assert.equal(request.status, 'research_review');
    assert.equal(request.gmail_draft_allowed, false);
    assert.ok(request.folder_id);
    assert.ok(request.brief_id);
    assert.equal(request.gmail_draft_id, null);
    assert.equal(calls.gmail, before);
    assert.equal((await database.query('SELECT count(*) FROM message_drafts WHERE prospect_id = $1', [id])).rows[0].count, '0');
    assert.equal((await database.query('SELECT stage FROM prospects WHERE id = $1', [id])).rows[0].stage, 'research_review');
  });

  await t.test('failed validation keeps a safe code and explicitly retries the same pre-artifact request', async () => {
    const id = await insertProspect();
    output = { ...fixtureResult(''), outreachSubject: '' };
    const before = { ...calls };
    await assert.rejects(startProspectResearch(id, deps, { gmailDraftAllowed: true }), /failed validation or collection/);
    const saved = (await database.query('SELECT * FROM prospect_research_requests WHERE prospect_id = $1', [id])).rows[0];
    assert.equal(saved.status, 'failed');
    assert.equal(saved.last_error, 'Research result validation failed: outreach_copy.');
    assert.equal(saved.folder_id, null);
    assert.equal(saved.brief_id, null);
    assert.equal(saved.gmail_draft_id, null);
    assert.equal(calls.folder, before.folder);
    assert.equal(calls.brief, before.brief);
    assert.equal(calls.gmail, before.gmail);
    await assert.rejects(resumeProspectResearch(saved.id, deps));

    output = fixtureResult('');
    const retried = await retryFailedPreArtifactResearch(saved.id, deps);
    assert.equal(retried.id, saved.id);
    assert.equal(retried.status, 'needs_contact');
    assert.ok(retried.folder_id);
    assert.ok(retried.brief_id);
    assert.equal(retried.gmail_draft_id, null);
    assert.equal(retried.last_error, saved.last_error);
    assert.equal(calls.research, before.research + 2);
    assert.equal(calls.folder, before.folder + 1);
    assert.equal(calls.brief, before.brief + 1);
    assert.equal(calls.gmail, before.gmail);
    assert.equal((await database.query('SELECT count(*) FROM prospect_research_requests WHERE prospect_id = $1',
      [id])).rows[0].count, '1');
    await assert.rejects(retryFailedPreArtifactResearch(saved.id, deps));
  });

  await t.test('pre-artifact retry rejects artifact markers, changed input, and concurrent retries', async () => {
    const makeFailed = async () => {
      const id = await insertProspect(), requestId = randomUUID();
      await database.query("UPDATE prospects SET stage = 'research_review' WHERE id = $1", [id]);
      await database.query(`INSERT INTO prospect_research_requests
        (id,prospect_id,status,owner_token,input_snapshot,drive_parent_id,last_error)
        VALUES ($1,$2,'failed',$3,$4,$5,$6)`,
      [requestId,id,randomUUID(),JSON.stringify({ company_name: 'Research Fixture', website: root,
        industry: null, contact_email: null, contact_name: null, primary_discovery_question: null }),
      parent,'Research result validation failed: outreach_copy.']);
      return { id, requestId };
    };
    const artifact = await makeFailed();
    await database.query('UPDATE prospect_research_requests SET folder_id = $2 WHERE id = $1',
      [artifact.requestId, 'untracked-folder']);
    const before = { ...calls };
    await assert.rejects(retryFailedPreArtifactResearch(artifact.requestId, deps), /pre-artifact/);
    const changed = await makeFailed();
    await database.query('UPDATE prospects SET company_name = $2 WHERE id = $1', [changed.id, 'Changed']);
    await assert.rejects(retryFailedPreArtifactResearch(changed.requestId, deps), /pre-artifact/);
    const wrongParent = await makeFailed();
    await assert.rejects(retryFailedPreArtifactResearch(wrongParent.requestId,
      { ...deps, driveParentId: 'differentparent12345' }), /pre-artifact/);
    assert.deepEqual(calls, before);

    const concurrent = await makeFailed();
    output = fixtureResult('');
    const settled = await Promise.allSettled([
      retryFailedPreArtifactResearch(concurrent.requestId, deps),
      retryFailedPreArtifactResearch(concurrent.requestId, deps),
    ]);
    assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(calls.folder, before.folder + 1);
    assert.equal(calls.brief, before.brief + 1);
    assert.equal(calls.gmail, before.gmail);
  });

  await t.test('uncertain Gmail result keeps its durable claim and blocks another draft', async () => {
    const id = await insertProspect();
    output = fixtureResult('hello@business.testsite.org');
    failGmail = true;
    await assert.rejects(startProspectResearch(id, deps, { gmailDraftAllowed: true }), /requires reconciliation/);
    const saved = (await database.query('SELECT * FROM prospect_research_requests WHERE prospect_id = $1', [id])).rows[0];
    assert.equal(saved.status, 'needs_reconciliation');
    assert.equal((await database.query('SELECT count(*) FROM message_drafts WHERE prospect_id = $1', [id])).rows[0].count, '0');
    const before = { ...calls };
    await assert.rejects(startProspectResearch(id, deps, { gmailDraftAllowed: true }));
    await assert.rejects(resumeProspectResearch(saved.id, deps));
    assert.deepEqual(calls, before);
    failGmail = false;
  });

  await t.test('Gmail-enabled brief checkpoint resumes without repeating research or Drive creation', async () => {
    const id = await insertProspect();
    const requestId = randomUUID(), oldOwner = randomUUID();
    const brief: DriveArtifact = { id: randomUUID().replaceAll('-', ''), mimeType: 'application/vnd.google-apps.folder',
      parents: [parent], appProperties: { relayResearchRequestId: requestId, relayArtifactKind: 'folder' } };
    const doc: DriveArtifact = { id: randomUUID().replaceAll('-', ''), mimeType: 'application/vnd.google-apps.document',
      parents: [brief.id], appProperties: { relayResearchRequestId: requestId, relayArtifactKind: 'brief' } };
    artifacts.set(brief.id, brief);
    artifacts.set(doc.id, doc);
    await database.query("UPDATE prospects SET stage = 'research_in_progress' WHERE id = $1", [id]);
    await database.query(`INSERT INTO prospect_research_requests
      (id,prospect_id,status,owner_token,input_snapshot,drive_parent_id,evidence,result,folder_id,brief_id,
       gmail_draft_allowed)
      VALUES ($1,$2,'brief_ready',$3,$4,$5,$6,$7,$8,$9,true)`,
    [requestId,id,oldOwner,JSON.stringify({ company_name: 'Research Fixture', website: root, industry: null,
      contact_email: null, contact_name: null, primary_discovery_question: null }),parent,
      JSON.stringify(evidence),JSON.stringify(fixtureResult('hello@business.testsite.org')),brief.id,doc.id]);
    const before = { ...calls };
    const request = await resumeProspectResearch(requestId, deps);
    assert.equal(request.status, 'completed');
    assert.equal(calls.folder, before.folder);
    assert.equal(calls.brief, before.brief);
    assert.equal(calls.research, before.research);
    assert.equal(calls.gmail, before.gmail + 1);
  });

  await t.test('default-disallowed brief checkpoint blocks Gmail after dependency reconstruction', async () => {
    const id = await insertProspect();
    const requestId = randomUUID(), oldOwner = randomUUID();
    const folder: DriveArtifact = { id: randomUUID().replaceAll('-', ''), mimeType: 'application/vnd.google-apps.folder',
      parents: [parent], appProperties: { relayResearchRequestId: requestId, relayArtifactKind: 'folder' } };
    const brief: DriveArtifact = { id: randomUUID().replaceAll('-', ''), mimeType: 'application/vnd.google-apps.document',
      parents: [folder.id], appProperties: { relayResearchRequestId: requestId, relayArtifactKind: 'brief' } };
    artifacts.set(folder.id, folder);
    artifacts.set(brief.id, brief);
    await database.query("UPDATE prospects SET stage = 'research_in_progress' WHERE id = $1", [id]);
    await database.query(`INSERT INTO prospect_research_requests
      (id,prospect_id,status,owner_token,input_snapshot,drive_parent_id,evidence,result,folder_id,brief_id)
      VALUES ($1,$2,'brief_ready',$3,$4,$5,$6,$7,$8,$9)`,
    [requestId,id,oldOwner,JSON.stringify({ company_name: 'Research Fixture', website: root, industry: null,
      contact_email: null, contact_name: null, primary_discovery_question: null }),parent,
      JSON.stringify(evidence),JSON.stringify(fixtureResult('hello@business.testsite.org')),folder.id,brief.id]);
    const before = { ...calls };
    const request = await resumeProspectResearch(requestId, { ...deps });
    assert.equal(request.status, 'research_review');
    assert.equal(request.gmail_draft_allowed, false);
    assert.equal(request.gmail_draft_id, null);
    assert.equal(calls.folder, before.folder);
    assert.equal(calls.brief, before.brief);
    assert.equal(calls.research, before.research);
    assert.equal(calls.gmail, before.gmail);
    assert.equal((await database.query('SELECT count(*) FROM message_drafts WHERE prospect_id = $1', [id])).rows[0].count, '0');
    assert.equal((await database.query('SELECT stage FROM prospects WHERE id = $1', [id])).rows[0].stage, 'research_review');
  });

  await t.test('safe failed research keeps Gmail disallowed when retried with normal dependencies', async () => {
    const id = await insertProspect();
    output = { ...fixtureResult(''), outreachSubject: '' };
    await assert.rejects(startProspectResearch(id, deps, { gmailDraftAllowed: false }),
      /failed validation or collection/);
    const saved = (await database.query('SELECT * FROM prospect_research_requests WHERE prospect_id = $1', [id])).rows[0];
    assert.equal(saved.gmail_draft_allowed, false);
    output = fixtureResult('hello@business.testsite.org');
    const before = { ...calls };
    const retried = await retryFailedPreArtifactResearch(saved.id, { ...deps });
    assert.equal(retried.status, 'research_review');
    assert.equal(retried.gmail_draft_allowed, false);
    assert.equal(retried.gmail_draft_id, null);
    assert.equal(calls.research, before.research + 1);
    assert.equal(calls.folder, before.folder + 1);
    assert.equal(calls.brief, before.brief + 1);
    assert.equal(calls.gmail, before.gmail);
    assert.equal((await database.query('SELECT count(*) FROM message_drafts WHERE prospect_id = $1', [id])).rows[0].count, '0');
  });
});
