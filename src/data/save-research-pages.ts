import {
  validateResearchEvidence,
  type ResearchEvidence,
} from "../research/research-evidence.js";

import type { PoolClient } from "pg";
import type { ResearchPageType } from "./canonical-data.js";

import {
  createResearchDocument,
  type ResearchDocument,
} from "./canonical-data.js";

type PrepareResearchPagesInput = {
  prospectId: string;
  researchRequestId: string;
  website: string;
  evidence: ResearchEvidence;
};

type PreparedDocument = {
  prospectId: string;
  researchRequestId: string;
  sourceUrl: string;
  pageType: ResearchPageType;
  title: string | null;
  content: string;
  scrapedAt: Date;
};

export function prepareResearchPages(
  input: PrepareResearchPagesInput,
): PreparedDocument[] {
  const evidence = validateResearchEvidence(input.evidence, input.website);

  return evidence.pages.map((page) => {
    if (!page.scrapedAt || !page.markdown.trim()) {
      throw new Error("Research page requires content and a scrape timestamp.");
    }

    return {
      prospectId: input.prospectId,
      researchRequestId: input.researchRequestId,
      sourceUrl: page.url,
      pageType: new URL(page.url).pathname === "/" ? "homepage" : "other",
      title: null,
      content: page.markdown,
      scrapedAt: new Date(page.scrapedAt),
    };
  });
}

export async function saveResearchPages(
  input: PrepareResearchPagesInput,
  client: PoolClient,
): Promise<ResearchDocument[]> {
  const documents = prepareResearchPages(input);
  const saved: ResearchDocument[] = [];

  for (const document of documents) {
    const result = await createResearchDocument(document, client);
    saved.push(result);
  }

  return saved;
}
