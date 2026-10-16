import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { collectResearchEvidence, safeResearchUrl } from '../../src/research/research-evidence.js';
import { validateResearchResult } from '../../src/research/research-result.js';
import { createFirecrawlScraper } from '../../src/research/firecrawl-scraper.js';
import { createOpenAIResearcher } from '../../src/research/openai-researcher.js';
import { parseResearchArgs } from '../../src/operator/research-input.js';

const root = 'https://business.example.com/';
const contact = 'https://business.example.com/contact';
const input = { company_name: 'Sample Business', website: root, industry: null, contact_email: null,
  contact_name: null, primary_discovery_question: null };
const evidence = { pages: [{ url: root, markdown: 'Sample Business serves local homes.', links: [contact] },
  { url: contact, markdown: 'Email hello@business.example.com for service.', links: ['mailto:hello@business.example.com'] }], limitations: [] };
const result = { companyName: input.company_name, domain: 'business.example.com', website: root, industry: 'Home services',
  fit: 'B', fitReason: 'Service contact path is visible.',
  observedCustomerPaths: [{ path: 'Contact', observation: 'Contact page lists an email.', sourceUrl: contact }],
  publicToolsOrVendors: [], recommendedContact: { name: '', role: '', email: 'hello@business.example.com', phone: '',
    sourceUrl: contact, confidence: 'high' }, primaryHypothesis: 'The contact form may route inquiries manually.',
  hypothesisEvidence: ['Contact email is public.'], unknowns: ['Response process'],
  primaryDiscoveryQuestion: 'How do you route new inquiries?', secondaryDiscoveryQuestions: [],
  possibleExpansionOpportunities: [], outreachSubject: 'Question about service inquiries',
  outreachBody: 'I noticed your contact page lists an email for service inquiries. How do you route new inquiries?',
  sources: [{ url: root, whatItSupported: 'Business site' }, { url: contact, whatItSupported: 'Public email' }],
  researchLimitations: [] };

test('Research URLs and crawl stay on safe discovered pages', async () => {
  for (const url of ['http://business.example.com', 'https://127.0.0.1/x',
    'https://business.example.com/admin', 'https://business.example.com/contact?token=x',
    'https://business.example.com%2F.evil.test/', 'https://business.example.com:8443/']) {
    assert.throws(() => safeResearchUrl(url));
  }
  const calls: string[] = [];
  const pages = await collectResearchEvidence(root, async url => {
    calls.push(url);
    return url === root ? { url, markdown: 'Home', links: [contact, 'https://evil.test/contact',
      'https://business.example.com/admin', 'mailto:hello@business.example.com'] }
      : { url, markdown: 'Contact', links: [] };
  });
  assert.deepEqual(calls, [root, contact]);
  assert.equal(pages.pages.length, 2);
});

test('Research output validates sources and contact evidence for objects and strings', () => {
  const request = randomUUID(), prospect = randomUUID();
  assert.equal(validateResearchResult(result, input, evidence, request, prospect).recommendedContact.email,
    'hello@business.example.com');
  assert.equal(validateResearchResult(JSON.stringify(result), input, evidence, request, prospect).fit, 'B');
  assert.throws(() => validateResearchResult({ ...result, unexpected: 'yes' }, input, evidence, request, prospect));
  assert.throws(() => validateResearchResult({ ...result, sources: [{ url: 'https://other.test/', whatItSupported: 'X' }] },
    input, evidence, request, prospect));
  assert.throws(() => validateResearchResult({ ...result, recommendedContact: {
    ...result.recommendedContact, email: 'owner@business.example.com' } }, input, evidence, request, prospect));
  assert.throws(() => validateResearchResult({ ...result, recommendedContact: {
    ...result.recommendedContact, sourceUrl: root } }, input, evidence, request, prospect));
  assert.throws(() => validateResearchResult({ ...result, recommendedContact: {
    ...result.recommendedContact, name: 'Imagined Owner' } }, input, evidence, request, prospect));
  assert.throws(() => validateResearchResult({ ...result, outreachSubject: 'Bad\nBcc: someone@evil.test' },
    input, evidence, request, prospect));
});

test('Firecrawl adapter accepts only a successful matching source', async () => {
  const scraper = createFirecrawlScraper('fake-key', async (_url, init) => {
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init.body)), { url: root, formats: ['markdown', 'links'],
      onlyMainContent: true, blockAds: true });
    return { ok: true, text: async () => JSON.stringify({ success: true, data: {
      markdown: 'Business', links: [], metadata: { sourceURL: root, statusCode: 200 },
    } }) };
  });
  assert.equal((await scraper(root)).url, root);
  await assert.rejects(createFirecrawlScraper('fake-key', async () => ({ ok: true,
    text: async () => JSON.stringify({ success: true, data: { markdown: 'Wrong', links: [],
      metadata: { sourceURL: 'https://evil.test/', statusCode: 200 } } }) }))(root));
});

test('OpenAI research adapter is tool-free and requires one completed text result', async () => {
  const researcher = createOpenAIResearcher({ OPENAI_API_KEY: 'fake-key', RELAY_RESEARCH_MODEL: 'chosen-model' },
    async (_url, init) => {
      const payload = JSON.parse(String(init.body));
      assert.deepEqual(payload.tools, []);
      assert.equal(payload.store, false);
      assert.equal(payload.model, 'chosen-model');
      assert.equal(payload.text.format.strict, true);
      assert.deepEqual(payload.text.format.schema.properties.companyName.enum, [input.company_name]);
      assert.deepEqual(payload.text.format.schema.properties.website.enum, [root]);
      assert.deepEqual(payload.text.format.schema.properties.domain.enum, ['business.example.com']);
      return { ok: true, text: async () => JSON.stringify({ status: 'completed', output: [{ type: 'message',
        role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }) };
    });
  assert.equal(typeof await researcher(input, evidence), 'string');
  await assert.rejects(createOpenAIResearcher({ OPENAI_API_KEY: 'x', RELAY_RESEARCH_MODEL: 'y' },
    async () => ({ ok: true, text: async () => JSON.stringify({ status: 'incomplete', output: [] }) }))(input, evidence));
});

test('Research CLI requires explicit confirmation before provider access', () => {
  const id = randomUUID();
  assert.deepEqual(parseResearchArgs(['start', '--prospect', id, '--confirm-research']), { action: 'start', prospectId: id });
  assert.throws(() => parseResearchArgs(['start', '--prospect', id]));
  assert.throws(() => parseResearchArgs(['resume', '--request', id]));
});
