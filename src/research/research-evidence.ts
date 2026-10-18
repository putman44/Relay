import { isIP } from 'node:net';

export type ResearchPage = { url: string; markdown: string; links: string[] };
export type ResearchEvidence = { pages: ResearchPage[]; limitations: string[] };
export type PageScraper = (url: string) => Promise<ResearchPage>;

const CONTACT_PATH = /(?:^|\/)(?:contact|quote|estimate|request|book|appointment|schedule|consultation|get-in-touch)(?=$|[\/-])/i;
const BUSINESS_PATH = /(?:^|\/)(?:about|services?|solutions?|offerings?|products?|pricing|emergency|team|locations?|faq)(?=$|[\/-])/i;
const NON_PAGE_PATH = /\.(?:pdf|png|jpe?g|gif|webp|svg|ico|css|js|zip|mp[34]|mov)$/i;
const ACTION = /(?:login|logout|sign-?in|account|cart|checkout|delete|admin|wp-admin|subscribe|unsubscribe|payment|pay)/i;

const siteHostname = (hostname: string): string => hostname.toLowerCase().replace(/^www\./, '');
const normalizedPath = (pathname: string): string => pathname === '/' ? '/' : pathname.replace(/\/+$/, '');

function sameResearchSite(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.port === b.port && siteHostname(a.hostname) === siteHostname(b.hostname);
}

export function safeResearchUrl(raw: string, origin?: string): string {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\x00-\x20\x7f]/.test(raw)) throw new Error('Unsafe research URL.');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid research URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search
    || isIP(url.hostname) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/.test(url.hostname)
    || /%(?:0[0-9a-f]|1[0-9a-f]|2f|5c|7f)/i.test(raw)
    || ACTION.test(url.pathname)) throw new Error('Unsafe research URL.');
  if (origin) {
    let supplied: URL;
    try { supplied = new URL(origin); } catch { throw new Error('Research URL left the supplied website.'); }
    if (!sameResearchSite(url, supplied)) throw new Error('Research URL left the supplied website.');
  }
  url.hash = '';
  return url.href;
}

export function equivalentResearchSourceUrl(requested: string, reported: string): boolean {
  try {
    const expected = new URL(safeResearchUrl(requested));
    const actual = new URL(safeResearchUrl(reported));
    return sameResearchSite(expected, actual) && normalizedPath(expected.pathname) === normalizedPath(actual.pathname);
  } catch {
    return false;
  }
}

export function validateResearchEvidence(input: unknown, seedUrl: string): ResearchEvidence {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Research evidence is invalid.');
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 5
    || !Array.isArray(value.limitations) || value.limitations.length > 10
    || value.limitations.some(item => typeof item !== 'string' || item.length > 500)) throw new Error('Research evidence is invalid.');
  const root = safeResearchUrl(seedUrl);
  const seen = new Set<string>();
  for (const page of value.pages) {
    if (!page || typeof page !== 'object' || Array.isArray(page)) throw new Error('Research page is invalid.');
    const p = page as ResearchPage;
    const url = safeResearchUrl(p.url, new URL(root).origin);
    if (url !== p.url || seen.has(url) || typeof p.markdown !== 'string' || Buffer.byteLength(p.markdown) > 30000
      || !Array.isArray(p.links) || p.links.length > 100 || p.links.some(link => typeof link !== 'string' || link.length > 2048)) {
      throw new Error('Research page is invalid.');
    }
    seen.add(url);
  }
  if (value.pages[0].url !== root) throw new Error('Research evidence must start with the supplied website.');
  return input as ResearchEvidence;
}

export async function collectResearchEvidence(seedUrl: string, scrape: PageScraper): Promise<ResearchEvidence> {
  const root = safeResearchUrl(seedUrl);
  const origin = new URL(root).origin;
  const pages: ResearchPage[] = [];
  const limitations: string[] = [];
  const first = await scrape(root);
  pages.push(validateResearchEvidence({ pages: [first], limitations }, root).pages[0]!);
  const candidates = new Map<string, { priority: number; order: number }>();
  let outsideSafeScope = 0;
  let nonPageLinks = 0;
  for (const link of first.links) {
    try {
      const candidate = safeResearchUrl(new URL(link, root).href, origin);
      if (candidate === root || candidates.has(candidate)) continue;
      const path = new URL(candidate).pathname;
      if (NON_PAGE_PATH.test(path)) { nonPageLinks++; continue; }
      const priority = CONTACT_PATH.test(path) ? 0 : BUSINESS_PATH.test(path) ? 1 : 2;
      candidates.set(candidate, { priority, order: candidates.size });
    } catch { outsideSafeScope++; /* Off-site, mailto, private and action links are never scraped. */ }
  }
  const ranked = [...candidates].sort((a, b) => a[1].priority - b[1].priority || a[1].order - b[1].order);
  const selected = ranked.slice(0, 4);
  for (const [candidate] of selected) {
    try {
      const page = await scrape(candidate);
      if (page.url !== candidate) throw new Error('The scrape returned a different source URL.');
      validateResearchEvidence({ pages: [first, page], limitations }, root);
      pages.push(page);
    } catch {
      limitations.push(`Could not verify selected page ${candidate.slice(0, 300)}.`);
    }
  }
  if (ranked.length > selected.length) {
    limitations.push(`Skipped ${ranked.length - selected.length} safe same-site pages because of the four-page follow-up limit.`);
  }
  if (outsideSafeScope) limitations.push(`Skipped ${outsideSafeScope} links outside the safe same-site page scope.`);
  if (nonPageLinks) limitations.push(`Skipped ${nonPageLinks} non-page asset links.`);
  if (!selected.length) limitations.push('No additional safe same-site page was selected from the starting page.');
  else if (pages.length === 1) limitations.push('No selected secondary page could be verified.');
  return validateResearchEvidence({ pages, limitations }, root);
}

export function publicEmailEvidence(evidence: ResearchEvidence): Set<string> {
  const emails = new Set<string>();
  const pattern = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi;
  for (const page of evidence.pages) {
    for (const text of [page.markdown, ...page.links.filter(link => /^mailto:/i.test(link))]) {
      for (const match of text.matchAll(pattern)) emails.add(match[0]!.toLowerCase());
    }
  }
  return emails;
}
