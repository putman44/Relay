import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { collectResearchEvidence, safeResearchUrl } from '../../src/research/research-evidence.js';
import { renderResearchBrief, ResearchValidationError, validateResearchResult,
  type ResearchResult } from '../../src/research/research-result.js';
import { createFirecrawlScraper } from '../../src/research/firecrawl-scraper.js';
import { createOpenAIResearcher } from '../../src/research/openai-researcher.js';
import { parseResearchArgs } from '../../src/operator/research-input.js';

const root = 'https://business.example.com/';
const contact = 'https://business.example.com/contact';
const input = { company_name: 'Sample Business', website: root, industry: null, contact_email: null,
  contact_name: null, primary_discovery_question: null };
const evidence = { pages: [{ url: root, markdown: 'Sample Business serves local homes.', links: [contact] },
  { url: contact, markdown: 'Email hello@business.example.com for service.', links: ['mailto:hello@business.example.com'] }], limitations: [] };
const result: ResearchResult = { companyName: input.company_name, domain: 'business.example.com', website: root, industry: 'Home services',
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
  assert.ok(pages.limitations.some(item => item.includes('outside the safe same-site page scope')));
});

test('Research follows branded same-site pages and prioritizes contact paths within its budget', async () => {
  const site = 'https://studio.example.com/';
  const links = ['/relay', '/portfolio', '/blog', '/contact', '/services', '/quote',
    '/brochure.pdf', '/checkout', 'https://other.example.com/contact'];
  const calls: string[] = [];
  const collected = await collectResearchEvidence(site, async url => {
    calls.push(url);
    return { url, markdown: `Public page at ${url}`, links: url === site ? links : [] };
  });
  assert.deepEqual(calls, [site, `${site}contact`, `${site}quote`, `${site}services`, `${site}relay`]);
  assert.equal(collected.pages.length, 5);
  assert.ok(collected.limitations.some(item => item.includes('Skipped 2 safe same-site pages')));
  assert.ok(collected.limitations.some(item => item.includes('Skipped 2 links outside')));
  assert.ok(collected.limitations.some(item => item.includes('Skipped 1 non-page asset')));

  const small: string[] = [];
  await collectResearchEvidence(site, async url => {
    small.push(url);
    return { url, markdown: 'Public page', links: url === site ? ['/relay', '/portfolio'] : [] };
  });
  assert.deepEqual(small, [site, `${site}relay`, `${site}portfolio`]);
});

test('Research distinguishes no selected page from a failed selected page', async () => {
  const empty = await collectResearchEvidence(root, async url => ({ url, markdown: 'Home', links: [] }));
  assert.ok(empty.limitations.includes('No additional safe same-site page was selected from the starting page.'));
  const failed = await collectResearchEvidence(root, async url => {
    if (url === contact) throw new Error('scrape failed');
    return { url, markdown: 'Home', links: [contact] };
  });
  assert.ok(failed.limitations.some(item => item.includes('Could not verify selected page')));
  assert.ok(failed.limitations.includes('No selected secondary page could be verified.'));
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
  const unsupported = { ...result, recommendedContact: { ...result.recommendedContact,
    name: 'Imagined Owner', role: 'Founder', phone: '555-0100' } };
  const sanitized = validateResearchResult(unsupported, input, evidence, request, prospect);
  assert.deepEqual([sanitized.recommendedContact.name, sanitized.recommendedContact.role,
    sanitized.recommendedContact.phone], ['', '', '']);
  assert.equal(sanitized.recommendedContact.email, 'hello@business.example.com');
  assert.equal(unsupported.recommendedContact.name, 'Imagined Owner');
  assert.ok(sanitized.researchLimitations.some(item => item.includes('Unsupported contact name, role, phone omitted')));
  assert.throws(() => validateResearchResult({ ...result, outreachSubject: 'Bad\nBcc: someone@evil.test' },
    input, evidence, request, prospect));
});

test('Research validation reports field codes without copying model output', () => {
  const request = randomUUID(), prospect = randomUUID();
  const codeFor = (value: unknown): string => {
    try { validateResearchResult(value, input, evidence, request, prospect); }
    catch (error) {
      assert.ok(error instanceof ResearchValidationError);
      assert.doesNotMatch(error.message, /evil\.test|private body/i);
      return error.code;
    }
    assert.fail('Expected research validation to fail.');
  };
  assert.equal(codeFor('not json'), 'invalid_json');
  assert.equal(codeFor({ ...result, unexpected: 'private body' }), 'top_level_shape');
  assert.equal(codeFor({ ...result, outreachSubject: '' }), 'outreach_copy');
  assert.equal(codeFor({ ...result, sources: [{ url: 'https://evil.test/', whatItSupported: 'private body' }] }),
    'source_not_fetched');
  assert.equal(codeFor({ ...result, recommendedContact: {
    ...result.recommendedContact, email: 'other@business.example.com' } }), 'contact_email_evidence');
});

test('Research brief separates selected contact from page-sourced public contact links', () => {
  const publicEvidence = { pages: [
    { url: root, markdown: 'Taylor Putman is a software developer.', links: [contact] },
    { url: contact, markdown: 'Contact us at hello@business.example.com.', links: [
      'mailto:hello@business.example.com?subject=Question', 'tel:+15550101000',
      'mailto:hello@business.example.com?subject=other@example.com',
    ] },
  ], limitations: [] };
  const brief = renderResearchBrief({ ...result, recommendedContact: {
    name: 'Taylor Putman', role: 'software developer', email: '', phone: '', sourceUrl: root, confidence: 'medium',
  } }, publicEvidence);
  assert.match(brief, /SELECTED CONTACT\nName: Taylor Putman\nRole: software developer\nEmail: Not assigned/);
  assert.match(brief, /PUBLIC CONTACT LINKS \(NOT ATTRIBUTED TO THE SELECTED CONTACT\)/);
  assert.match(brief, /Email: hello@business\.example\.com \(https:\/\/business\.example\.com\/contact\)/);
  assert.match(brief, /Phone: \+15550101000 \(https:\/\/business\.example\.com\/contact\)/);
  assert.doesNotMatch(brief, /other@example\.com/);
  assert.equal(brief.match(/Email: hello@business\.example\.com/g)?.length, 1);
  assert.match(brief, /PROPOSED OUTREACH FOR HUMAN REVIEW/);
});

test('Research brief omits proposed outreach for C-fit and owned-site research', () => {
  const cFit = renderResearchBrief({ ...result, fit: 'C' }, evidence);
  assert.doesNotMatch(cFit, /PROPOSED OUTREACH FOR HUMAN REVIEW|Question about service inquiries/);
  const owned = renderResearchBrief({ ...result, website: 'https://www.devbytaylor.com/' }, evidence);
  assert.doesNotMatch(owned, /PROPOSED OUTREACH FOR HUMAN REVIEW|Question about service inquiries/);
  const lookalike = renderResearchBrief({ ...result, website: 'https://notdevbytaylor.com/' }, evidence);
  assert.match(lookalike, /PROPOSED OUTREACH FOR HUMAN REVIEW/);
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
      assert.match(payload.instructions, /single cited sourceUrl page/);
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
  assert.deepEqual(parseResearchArgs(['start-safe', '--prospect', id, '--confirm-research-only']),
    { action: 'start-safe', prospectId: id });
  assert.throws(() => parseResearchArgs(['start', '--prospect', id]));
  assert.throws(() => parseResearchArgs(['start-safe', '--prospect', id]));
  assert.throws(() => parseResearchArgs(['start-safe', '--prospect', id, '--confirm-research']));
  assert.throws(() => parseResearchArgs(['resume', '--request', id]));
  assert.deepEqual(parseResearchArgs(['retry-pre-artifact', '--request', id, '--confirm-retry-pre-artifact']),
    { action: 'retry-pre-artifact', requestId: id });
  assert.throws(() => parseResearchArgs(['retry-pre-artifact', '--request', id]));
});
