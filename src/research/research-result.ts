import { publicEmailEvidence, safeResearchUrl, type ResearchEvidence } from './research-evidence.js';
import { validateOutreachDraftContent } from '../outreach/outreach-draft-content.js';

export type ResearchResult = {
  companyName: string; domain: string; website: string; industry: string;
  fit: 'A' | 'B' | 'C'; fitReason: string;
  observedCustomerPaths: { path: string; observation: string; sourceUrl: string }[];
  publicToolsOrVendors: { name: string; evidence: string; sourceUrl: string }[];
  recommendedContact: { name: string; role: string; email: string; phone: string; sourceUrl: string; confidence: 'high' | 'medium' | 'low' };
  primaryHypothesis: string; hypothesisEvidence: string[]; unknowns: string[];
  primaryDiscoveryQuestion: string; secondaryDiscoveryQuestions: string[];
  possibleExpansionOpportunities: string[]; outreachSubject: string; outreachBody: string;
  sources: { url: string; whatItSupported: string }[]; researchLimitations: string[];
};

type Input = { company_name: string; website: string; industry: string | null; contact_email: string | null;
  contact_name: string | null; primary_discovery_question: string | null };

const str = { type: 'string' };
const array = (items: object) => ({ type: 'array', items });
const object = (properties: Record<string, object>) => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });
export const researchResultSchema = object({
  companyName: str, domain: str, website: str, industry: str,
  fit: { type: 'string', enum: ['A', 'B', 'C'] }, fitReason: str,
  observedCustomerPaths: array(object({ path: str, observation: str, sourceUrl: str })),
  publicToolsOrVendors: array(object({ name: str, evidence: str, sourceUrl: str })),
  recommendedContact: object({ name: str, role: str, email: str, phone: str, sourceUrl: str,
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }),
  primaryHypothesis: str, hypothesisEvidence: array(str), unknowns: array(str),
  primaryDiscoveryQuestion: str, secondaryDiscoveryQuestions: array(str),
  possibleExpansionOpportunities: array(str), outreachSubject: str, outreachBody: str,
  sources: array(object({ url: str, whatItSupported: str })), researchLimitations: array(str),
});

const KEYS = Object.keys(researchResultSchema.properties);
export class ResearchValidationError extends Error {
  constructor(readonly code: string) {
    super(`Research result validation failed: ${code}.`);
    this.name = 'ResearchValidationError';
  }
}

function invalid(code: string): never {
  throw new ResearchValidationError(code);
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function string(value: unknown, limit: number, nonempty = false): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= limit
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && (!nonempty || !!value.trim());
}
function strings(value: unknown, max: number, limit: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(item => string(item, limit, true));
}
function rows(value: unknown, keys: string[], max: number): value is Record<string, string>[] {
  return Array.isArray(value) && value.length <= max && value.every(item => exact(item, keys)
    && keys.every(key => string(item[key], 1000, true)));
}

export function validateResearchResult(raw: unknown, input: Input, evidence: ResearchEvidence,
  requestId: string, prospectId: string): ResearchResult {
  let value: unknown;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { invalid('invalid_json'); }
  if (!exact(value, KEYS)) invalid('top_level_shape');
  if (!string(value.companyName, 200, true) || value.companyName !== input.company_name) invalid('company_name');
  if (!string(value.domain, 253, true) || !string(value.website, 2048, true)) invalid('website_identity');
  if (!string(value.industry, 200) || (input.industry && value.industry !== input.industry)) invalid('industry');
  if (!['A', 'B', 'C'].includes(String(value.fit)) || !string(value.fitReason, 2000, true)) invalid('fit');
  if (!rows(value.observedCustomerPaths, ['path', 'observation', 'sourceUrl'], 12)) invalid('customer_paths');
  if (!rows(value.publicToolsOrVendors, ['name', 'evidence', 'sourceUrl'], 12)) invalid('public_tools');
  if (!exact(value.recommendedContact, ['name', 'role', 'email', 'phone', 'sourceUrl', 'confidence'])) invalid('contact_shape');
  const contactFields = value.recommendedContact as Record<string, unknown>;
  if (!['high', 'medium', 'low'].includes(String(contactFields.confidence))
    || !['name', 'role', 'email', 'phone', 'sourceUrl'].every(key => string(contactFields[key], 500))) {
    invalid('contact_fields');
  }
  if (!string(value.primaryHypothesis, 3000) || !strings(value.hypothesisEvidence, 12, 1000)
    || !strings(value.unknowns, 12, 1000)) invalid('hypothesis');
  if (!string(value.primaryDiscoveryQuestion, 1000, true)
    || (input.primary_discovery_question && value.primaryDiscoveryQuestion !== input.primary_discovery_question)) {
    invalid('discovery_question');
  }
  if (!strings(value.secondaryDiscoveryQuestions, 8, 1000)
    || !strings(value.possibleExpansionOpportunities, 8, 1000)) invalid('other_questions');
  if (!string(value.outreachSubject, 500, true) || !string(value.outreachBody, 10000, true)) invalid('outreach_copy');
  if (!rows(value.sources, ['url', 'whatItSupported'], 20)) invalid('sources_shape');
  if (!strings(value.researchLimitations, 10, 1000)) invalid('limitations');
  const result = value as ResearchResult;
  const seed = safeResearchUrl(input.website);
  if (result.domain !== new URL(seed).hostname || result.website !== seed) invalid('website_identity');
  const fetched = new Set(evidence.pages.map(page => page.url));
  const cited = new Set(result.sources.map(item => item.url));
  if (!result.sources.length || [...cited].some(url => !fetched.has(url))) invalid('source_not_fetched');
  for (const item of [...result.observedCustomerPaths, ...result.publicToolsOrVendors]) {
    if (!fetched.has(item.sourceUrl) || !cited.has(item.sourceUrl)) invalid('observation_source');
  }
  const contact = { ...result.recommendedContact };
  const contactPage = evidence.pages.find(page => page.url === contact.sourceUrl);
  const omittedContactFields: Array<'name' | 'role' | 'phone'> = [];
  for (const field of ['name', 'role', 'phone'] as const) {
    if (contact[field] && !contactPage?.markdown.toLowerCase().includes(contact[field].toLowerCase())) {
      contact[field] = '';
      omittedContactFields.push(field);
    }
  }
  try {
    validateOutreachDraftContent({ requestId, prospectId,
      recipientEmail: contact.email || 'preview@relay.invalid',
      subject: result.outreachSubject, body: result.outreachBody });
  } catch { invalid('outreach_content'); }
  if (contact.sourceUrl && (!fetched.has(contact.sourceUrl) || !cited.has(contact.sourceUrl))) {
    invalid('contact_source');
  }
  if (contact.email) {
    if (!contactPage || !publicEmailEvidence({ pages: [contactPage], limitations: [] }).has(contact.email.toLowerCase())) {
      invalid('contact_email_evidence');
    }
  }
  if (input.contact_email && contact.email && input.contact_email.toLowerCase() !== contact.email.toLowerCase()) {
    invalid('contact_conflict');
  }
  if (!omittedContactFields.length) return result;
  const limitation = `Unsupported contact ${omittedContactFields.join(', ')} omitted from the cited page.`;
  return { ...result, recommendedContact: contact,
    researchLimitations: result.researchLimitations.length < 10
      ? [...result.researchLimitations, limitation] : result.researchLimitations };
}

export function renderResearchBrief(result: ResearchResult, evidence: ResearchEvidence): string {
  const list = (values: string[]) => values.length ? values.map(item => `- ${item}`).join('\n') : '- Unknown';
  const publicContactLinks: string[] = [];
  const seenContactLinks = new Set<string>();
  for (const page of evidence.pages) {
    for (const link of page.links) {
      if (!/^(?:mailto|tel):/i.test(link)) continue;
      let address: string;
      try { address = decodeURIComponent(new URL(link).pathname); }
      catch { continue; }
      const isEmail = /^mailto:/i.test(link);
      if (isEmail ? !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(address)
        : !/^\+?[0-9][0-9(). -]{5,30}$/.test(address)) continue;
      const key = `${isEmail ? 'email' : 'phone'}:${address.toLowerCase()}`;
      if (seenContactLinks.has(key)) continue;
      seenContactLinks.add(key);
      publicContactLinks.push(`${isEmail ? 'Email' : 'Phone'}: ${address} (${page.url})`);
    }
  }
  const hostname = new URL(result.website).hostname.toLowerCase();
  const ownedSite = hostname === 'devbytaylor.com' || hostname.endsWith('.devbytaylor.com');
  return [
    `COMPANY\n${result.companyName}\n${result.website}\n${result.industry || 'Industry unknown'}`,
    `FIT\n${result.fit}: ${result.fitReason}`,
    `OBSERVED CUSTOMER PATHS\n${list(result.observedCustomerPaths.map(item => `${item.path}: ${item.observation} (${item.sourceUrl})`))}`,
    `PUBLIC TOOLS OR VENDORS\n${list(result.publicToolsOrVendors.map(item => `${item.name}: ${item.evidence} (${item.sourceUrl})`))}`,
    `SELECTED CONTACT\nName: ${result.recommendedContact.name || 'Unknown'}\nRole: ${result.recommendedContact.role || 'Unknown'}\nEmail: ${result.recommendedContact.email || 'Not assigned'}\nPhone: ${result.recommendedContact.phone || 'Not assigned'}\nSource: ${result.recommendedContact.sourceUrl || 'None'}`,
    `PUBLIC CONTACT LINKS (NOT ATTRIBUTED TO THE SELECTED CONTACT)\n${list(publicContactLinks)}`,
    `HYPOTHESIS\n${result.primaryHypothesis || 'Unknown'}`,
    `HYPOTHESIS EVIDENCE\n${list(result.hypothesisEvidence)}`,
    `UNKNOWNS\n${list(result.unknowns)}`,
    `PRIMARY DISCOVERY QUESTION\n${result.primaryDiscoveryQuestion}`,
    `SECONDARY QUESTIONS\n${list(result.secondaryDiscoveryQuestions)}`,
    `POSSIBLE EXPANSION\n${list(result.possibleExpansionOpportunities)}`,
    ...(result.fit === 'C' || ownedSite ? [] : [
      `PROPOSED OUTREACH FOR HUMAN REVIEW\nSubject: ${result.outreachSubject}\n${result.outreachBody}`,
    ]),
    `SOURCES\n${list(result.sources.map(item => `${item.url}: ${item.whatItSupported}`))}`,
    `LIMITATIONS\n${list([...result.researchLimitations, ...evidence.limitations])}`,
  ].join('\n\n') + '\n';
}
