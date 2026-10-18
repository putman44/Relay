import { equivalentResearchSourceUrl, safeResearchUrl, type PageScraper } from './research-evidence.js';

type Transport = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'text'>>;

export function createFirecrawlScraper(key = process.env.FIRECRAWL_API_KEY, transport: Transport = fetch): PageScraper {
  if (!key?.trim()) throw new Error('FIRECRAWL_API_KEY is required.');
  return async rawUrl => {
    const url = safeResearchUrl(rawUrl);
    const response = await transport('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown', 'links'], onlyMainContent: true, blockAds: true }),
    });
    if (!response.ok) throw new Error('Research scrape failed.');
    const body = await response.text();
    if (Buffer.byteLength(body) > 250000) throw new Error('Research scrape response is too large.');
    const payload = JSON.parse(body) as { success?: unknown; data?: {
      markdown?: unknown; links?: unknown; metadata?: { sourceURL?: unknown; statusCode?: unknown; url?: unknown };
    } };
    const data = payload.data;
    const sourceUrl = typeof data?.metadata?.sourceURL === 'string' ? data.metadata.sourceURL : '';
    const finalUrl = typeof data?.metadata?.url === 'string' ? data.metadata.url : '';
    const statusCode = data?.metadata?.statusCode;
    if (payload.success !== true || typeof data?.markdown !== 'string' || !data.markdown.trim()
      || Buffer.byteLength(data.markdown) > 30000 || !Array.isArray(data.links)
      || data.links.length > 100 || data.links.some(link => typeof link !== 'string' || link.length > 2048)
      || !equivalentResearchSourceUrl(url, sourceUrl)
      || (finalUrl && !equivalentResearchSourceUrl(url, finalUrl))
      || typeof statusCode !== 'number' || statusCode < 200 || statusCode >= 300) {
      throw new Error('Research scrape provenance or content is invalid.');
    }
    return { url, markdown: data.markdown, links: data.links as string[] };
  };
}
