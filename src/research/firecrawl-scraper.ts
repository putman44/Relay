import {
  equivalentResearchSourceUrl,
  safeResearchUrl,
  type PageScraper,
} from "./research-evidence.js";

export class FirecrawlScrapeError extends Error {
  constructor(
    public readonly kind: "request_not_sent" | "provider_failed" | "provider_uncertain" | "response_invalid",
    public readonly httpStatus?: number,
    public readonly providerRequestId?: string,
  ) {
    super({
      request_not_sent: "Research request was not sent.",
      provider_failed: "Research scrape failed.",
      provider_uncertain: "Research scrape outcome is uncertain.",
      response_invalid: "Research scrape provenance or content is invalid.",
    }[kind]);
    this.name = "FirecrawlScrapeError";
  }
}

type Transport = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "text"> & Partial<Pick<Response, "status" | "headers">>>;

function providerId(headers: Headers | undefined): string | undefined {
  const value = headers?.get("x-request-id") ?? headers?.get("request-id");
  return value && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : undefined;
}

export function createFirecrawlScraper(
  key = process.env.FIRECRAWL_API_KEY,
  transport: Transport = fetch,
): PageScraper {
  if (!key?.trim()) throw new Error("FIRECRAWL_API_KEY is required.");
  return async (rawUrl) => {
    let url: string;
    try { url = safeResearchUrl(rawUrl); }
    catch { throw new FirecrawlScrapeError("request_not_sent"); }
    let response: Awaited<ReturnType<Transport>>;
    try { response = await transport("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(45000),
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown", "links"],
        onlyMainContent: true,
        blockAds: true,
      }),
    }); } catch { throw new FirecrawlScrapeError("provider_uncertain"); }
    const id = providerId(response.headers);
    if (!response.ok) throw new FirecrawlScrapeError("provider_failed", response.status, id);
    let body: string;
    try { body = await response.text(); }
    catch { throw new FirecrawlScrapeError("provider_uncertain", response.status, id); }
    if (Buffer.byteLength(body) > 250000)
      throw new FirecrawlScrapeError("response_invalid", response.status, id);
    let payload: {
      success?: unknown;
      data?: {
        markdown?: unknown;
        links?: unknown;
        metadata?: { sourceURL?: unknown; statusCode?: unknown; url?: unknown };
      };
    };
    try { payload = JSON.parse(body); }
    catch { throw new FirecrawlScrapeError("response_invalid", response.status, id); }
    const data = payload.data;
    const sourceUrl =
      typeof data?.metadata?.sourceURL === "string"
        ? data.metadata.sourceURL
        : "";
    const finalUrl = data?.metadata?.url;
    const statusCode = data?.metadata?.statusCode;
    if (
      payload.success !== true ||
      typeof data?.markdown !== "string" ||
      !data.markdown.trim() ||
      Buffer.byteLength(data.markdown) > 30000 ||
      !Array.isArray(data.links) ||
      data.links.length > 100 ||
      data.links.some(
        (link) => typeof link !== "string" || link.length > 2048,
      ) ||
      !equivalentResearchSourceUrl(url, sourceUrl) ||
      (finalUrl != null &&
        (typeof finalUrl !== "string" ||
          !equivalentResearchSourceUrl(url, finalUrl))) ||
      typeof statusCode !== "number" ||
      statusCode < 200 ||
      statusCode >= 300
    ) {
      throw new FirecrawlScrapeError("response_invalid", response.status, id);
    }
    return {
      url,
      markdown: data.markdown,
      links: data.links as string[],
      scrapedAt: new Date().toISOString(),
    };
  };
}
