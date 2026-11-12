import { strict as assert } from "node:assert";
import { test } from "node:test";

import { prepareResearchPages } from "../../src/data/save-research-pages.js";

const website = "https://www.devbytaylor.com/";
const scrapedAt = "2026-11-12T01:30:00.000Z";

const evidence = {
  pages: [
    {
      url: website,
      markdown: "# Dev by Taylor\n\nWelcome!",
      links: [],
      scrapedAt,
    },
    {
      url: `${website}relay`,
      markdown: "# Relay\n\nAI automation services.",
      links: [],
      scrapedAt,
    },
    {
      url: `${website}portfolio`,
      markdown: "# Portfolio\n\nOur projects.",
      links: [],
      scrapedAt,
    },
  ],
  limitations: [],
};

const input = {
  prospectId: "0800482b-18a5-47b9-8f8a-f35a1f7076f8",
  researchRequestId: "05bb0658-9ba9-4a46-a0bc-a7b2e7be76c5",
  website,
  evidence,
};

test("prepares Firecrawl pages without changing Markdown", () => {
  const documents = prepareResearchPages(input);

  assert.equal(documents.length, 3);

  assert.equal(documents[0]?.pageType, "homepage");
  assert.equal(documents[1]?.pageType, "other");

  for (let i = 0; i < documents.length; i++) {
    assert.equal(documents[i]?.sourceUrl, evidence.pages[i]?.url);
    assert.equal(documents[i]?.content, evidence.pages[i]?.markdown);
    assert.equal(documents[i]?.prospectId, input.prospectId);
    assert.equal(documents[i]?.researchRequestId, input.researchRequestId);
    assert.equal(documents[i]?.scrapedAt.toISOString(), scrapedAt);
  }
});

test("rejects pages without a scrape timestamp", () => {
  const invalidEvidence = {
    ...evidence,
    pages: evidence.pages.map((page, index) =>
      index === 1
        ? {
            url: page.url,
            markdown: page.markdown,
            links: page.links,
          }
        : page,
    ),
  };

  assert.throws(
    () =>
      prepareResearchPages({
        ...input,
        evidence: invalidEvidence,
      }),
    /requires content and a scrape timestamp/,
  );
});
