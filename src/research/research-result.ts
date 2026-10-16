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
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!exact(value, KEYS) || !string(value.companyName, 200, true) || value.companyName !== input.company_name
    || !string(value.domain, 253, true) || !string(value.website, 2048, true)
    || !string(value.industry, 200) || (input.industry && value.industry !== input.industry)
    || !['A', 'B', 'C'].includes(String(value.fit)) || !string(value.fitReason, 2000, true)
    || !rows(value.observedCustomerPaths, ['path', 'observation', 'sourceUrl'], 12)
    || !rows(value.publicToolsOrVendors, ['name', 'evidence', 'sourceUrl'], 12)
    || !exact(value.recommendedContact, ['name', 'role', 'email', 'phone', 'sourceUrl', 'confidence'])
    || !['high', 'medium', 'low'].includes(String((value.recommendedContact as Record<string, unknown>).confidence))
    || !['name', 'role', 'email', 'phone', 'sourceUrl'].every(key => string((value.recommendedContact as Record<string, unknown>)[key], 500))
    || !string(value.primaryHypothesis, 3000) || !strings(value.hypothesisEvidence, 12, 1000)
    || !strings(value.unknowns, 12, 1000) || !string(value.primaryDiscoveryQuestion, 1000, true)
    || (input.primary_discovery_question && value.primaryDiscoveryQuestion !== input.primary_discovery_question)
    || !strings(value.secondaryDiscoveryQuestions, 8, 1000)
    || !strings(value.possibleExpansionOpportunities, 8, 1000)
    || !string(value.outreachSubject, 500, true) || !string(value.outreachBody, 10000, true)
    || !rows(value.sources, ['url', 'whatItSupported'], 20)
    || !strings(value.researchLimitations, 10, 1000)) throw new Error('Research result does not match its strict contract.');
  const result = value as ResearchResult;
  const seed = safeResearchUrl(input.website);
  if (result.domain !== new URL(seed).hostname || result.website !== seed) throw new Error('Research result changed the supplied website.');
  const fetched = new Set(evidence.pages.map(page => page.url));
  const cited = new Set(result.sources.map(item => item.url));
  if (!result.sources.length || [...cited].some(url => !fetched.has(url))) throw new Error('Research cites an unfetched source.');
  for (const item of [...result.observedCustomerPaths, ...result.publicToolsOrVendors]) {
    if (!fetched.has(item.sourceUrl) || !cited.has(item.sourceUrl)) throw new Error('Research observation cites an unfetched page.');
  }
  const contact = result.recommendedContact;
  const contactPage = evidence.pages.find(page => page.url === contact.sourceUrl);
  if ([contact.name, contact.role, contact.phone].some(field => field && !contactPage?.markdown.toLowerCase().includes(field.toLowerCase()))) {
    throw new Error('Research contact details lack public page evidence.');
  }
  validateOutreachDraftContent({ requestId, prospectId,
    recipientEmail: contact.email || 'preview@relay.invalid',
    subject: result.outreachSubject, body: result.outreachBody });
  if (contact.sourceUrl && (!fetched.has(contact.sourceUrl) || !cited.has(contact.sourceUrl))) {
    throw new Error('Research contact cites an unfetched page.');
  }
  if (contact.email) {
    if (!contactPage || !publicEmailEvidence({ pages: [contactPage], limitations: [] }).has(contact.email.toLowerCase())) {
      throw new Error('Research contact email lacks public page evidence.');
    }
  }
  if (input.contact_email && contact.email && input.contact_email.toLowerCase() !== contact.email.toLowerCase()) {
    throw new Error('Research email conflicts with the existing contact.');
  }
  return result;
}

export function renderResearchBrief(result: ResearchResult, evidence: ResearchEvidence): string {
  const list = (values: string[]) => values.length ? values.map(item => `- ${item}`).join('\n') : '- Unknown';
  return [
    `COMPANY\n${result.companyName}\n${result.website}\n${result.industry || 'Industry unknown'}`,
    `FIT\n${result.fit}: ${result.fitReason}`,
    `OBSERVED CUSTOMER PATHS\n${list(result.observedCustomerPaths.map(item => `${item.path}: ${item.observation} (${item.sourceUrl})`))}`,
    `PUBLIC TOOLS OR VENDORS\n${list(result.publicToolsOrVendors.map(item => `${item.name}: ${item.evidence} (${item.sourceUrl})`))}`,
    `CONTACT\n${result.recommendedContact.name || 'Unknown'} | ${result.recommendedContact.role || 'Unknown'} | ${result.recommendedContact.email || 'Unknown'} | ${result.recommendedContact.phone || 'Unknown'}\nSource: ${result.recommendedContact.sourceUrl || 'None'}`,
    `HYPOTHESIS\n${result.primaryHypothesis || 'Unknown'}`,
    `HYPOTHESIS EVIDENCE\n${list(result.hypothesisEvidence)}`,
    `UNKNOWNS\n${list(result.unknowns)}`,
    `PRIMARY DISCOVERY QUESTION\n${result.primaryDiscoveryQuestion}`,
    `SECONDARY QUESTIONS\n${list(result.secondaryDiscoveryQuestions)}`,
    `POSSIBLE EXPANSION\n${list(result.possibleExpansionOpportunities)}`,
    `PROPOSED OUTREACH FOR HUMAN REVIEW\nSubject: ${result.outreachSubject}\n${result.outreachBody}`,
    `SOURCES\n${list(result.sources.map(item => `${item.url}: ${item.whatItSupported}`))}`,
    `LIMITATIONS\n${list([...result.researchLimitations, ...evidence.limitations])}`,
  ].join('\n\n') + '\n';
}
