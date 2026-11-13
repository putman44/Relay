import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import "../../scripts/check-test-database.js";
import { createResearchDocument } from "../../src/data/canonical-data.js";
import { listAssessments } from "../../src/data/lead-assessments.js";
import { searchResearchChunksByKeyword } from "../../src/data/research-embeddings.js";
import {
  ASSESSMENT_CATEGORIES,
  ASSESSMENT_RETRIEVAL_LIMITS,
  generateLeadIntakeAssessment,
  retrieveAssessmentSources,
} from "../../src/research/lead-intake-assessment.js";
import type { Assessor } from "../../src/research/openai-assessor.js";
import { RESEARCH_EMBEDDING_MODEL } from "../../src/research/openai-embeddings.js";
import { sampleDraft } from "../helpers/assessment-fixtures.js";
import { RESEARCH_EMBEDDING_DIMENSIONS, type Embedder } from "../../src/research/openai-embeddings.js";

const SITE = "https://sadowski.example.com";
const WIDGET = "### How soon do you need service?\n\nUrgent / call todaySame-day if availableThis weekFlexible / planning ahead";

// A paragraph of about 700 characters.
const paragraph = (topic: string) =>
  `${topic}. ${"We look at the system, the airflow, the controls, and the building before we recommend work. ".repeat(7)}`.slice(0, 700);

// Exact vectors, so ranking is deterministic. Category query i is axis i. A decoy for category i
// sits (almost) on axis i, so it is the nearest chunk to that query. Emergency chunks sit on an
// axis no query uses, so vector search ranks them last for every category, as in the real run.
const axis = (index: number, mix?: { index: number; weight: number }) => {
  const vector = new Array<number>(RESEARCH_EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  if (mix) vector[mix.index] = mix.weight;
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
};
const AFTER_HOURS = ASSESSMENT_CATEGORIES.findIndex((category) => category.id === "after_hours");
const FAR = 100;
const axisEmbedder = () => {
  const calls: string[][] = [];
  const embed: Embedder = async (texts) => {
    calls.push(texts);
    return texts.map((_, index) => axis(index));
  };
  return { embed, calls };
};

type Chunk = { content: string; vector: number[] };
type Page = { path: string; chunks: Chunk[] };
const decoys = (count: number, tag: string): Chunk[] =>
  ASSESSMENT_CATEGORIES.flatMap((category, index) =>
    Array.from({ length: count }, (_, n) => ({
      // (Not the category label: "After-hours and emergency intake" would put "emergency" in a decoy.)
      content: `Decoy ${category.id.replace("_", " ")} ${tag}${n}. Filler text for this category, number ${n}.`,
      vector: axis(index, { index: 200 + n, weight: 0.3 }),
    })),
  );
const widget: Chunk = { content: WIDGET, vector: axis(AFTER_HOURS) };
const plain = (topic: string): Chunk => ({ content: paragraph(topic), vector: axis(FAR + 1) });
const emergency = (content: string): Chunk => ({ content, vector: axis(FAR) });
const PAGES: Page[] = [
  { path: "/", chunks: [plain("Heating and cooling in Linden"), widget, ...decoys(2, "home"), emergency(paragraph("Emergency HVAC repair has its own page. Smell gas? Leave the building"))] },
  { path: "/contact-us/", chunks: [widget, ...decoys(2, "contact"), plain("Send property details")] },
  { path: "/about-us/", chunks: [widget, ...decoys(2, "about"), plain("The standards behind a visit")] },
  { path: "/service-areas/", chunks: [widget, ...decoys(2, "areas"), plain("Where we work")] },
  {
    path: "/emergency-hvac-repair-in-linden-nj/",
    chunks: [
      emergency(`# Emergency HVAC Repair in Linden, NJ\n\n${paragraph("When a heating or cooling system stops working at the worst time")}`.slice(0, 760)),
      emergency(paragraph("We separate comfort problems from safety problems first. Emergency does not mean guessing")),
      emergency(paragraph("Emergency HVAC repair across heating, cooling, and controls")),
      emergency(paragraph("Emergency HVAC situations are stressful")),
      emergency(paragraph("Emergency HVAC repair details")),
    ],
  },
];

test("Assessment retrieval: keyword evidence reaches the assessor when vector search alone misses it", async (t) => {
  const connectionString = process.env.RELAY_DRAFT_TEST_DATABASE_URL!;
  const schema = `relay_assessment_retrieval_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const directory = new URL("../../migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort())
    await database.query(await readFile(new URL(name, directory), "utf8"));

  // Chunks are inserted directly so each one is exactly the text below.
  async function prospect(pages: Page[], options: { embedded?: boolean } = {}) {
    const prospectId = randomUUID(), requestId = randomUUID();
    await database.query("INSERT INTO prospects (id, company_name, website) VALUES ($1,$2,$3)", [prospectId, "Sadowski-like HVAC", `${SITE}/`]);
    await database.query(
      `INSERT INTO prospect_research_requests (id, prospect_id, status, owner_token, input_snapshot, drive_parent_id, website_index_status)
      VALUES ($1,$2,'completed',$3,$4,'','ready')`,
      [requestId, prospectId, randomUUID(), JSON.stringify({ website: `${SITE}/` })],
    );
    for (const page of pages) {
      const url = `${SITE}${page.path}`;
      const document = await createResearchDocument(
        { prospectId, researchRequestId: requestId, sourceUrl: url, pageType: "other", title: null, content: page.chunks.map((item) => item.content).join("\n\n"), scrapedAt: new Date("2026-11-12T02:00:00.000Z") },
        database,
      );
      for (const [index, chunk] of page.chunks.entries())
        await database.query(
          `INSERT INTO research_chunks (prospect_id, research_document_id, content, embedding, embedding_model, source_url, chunk_index)
          VALUES ($1,$2,$3,$4::public.vector,$5,$6,$7)`,
          [prospectId, document.id, chunk.content, options.embedded === false ? null : JSON.stringify(chunk.vector), options.embedded === false ? null : RESEARCH_EMBEDDING_MODEL, url, index],
        );
    }
    return { prospectId };
  }
  const { prospectId } = await prospect(PAGES);
  const isEmergency = (text: string) => /emergency/i.test(text);
  const VECTOR_ONLY = { ...ASSESSMENT_RETRIEVAL_LIMITS, keywordPerCategory: 0 };
  const bytes = (sources: { text: string }[]) => sources.reduce((total, item) => total + Buffer.byteLength(item.text), 0);

  await t.test("vector search alone never reaches the emergency page, which is the problem being fixed", async () => {
    const embedder = axisEmbedder();
    const sources = await retrieveAssessmentSources(prospectId, { database, embed: embedder.embed }, VECTOR_ONLY);
    assert.equal(sources.filter((source) => isEmergency(source.text)).length, 0, "the fixture must reproduce the miss");
    // The site-wide widget and lookalike chunks filled the slots.
    assert.ok(sources.some((source) => source.text.includes("How soon do you need service")));
    assert.ok(sources.every((source) => source.via === "vector"));
  });

  await t.test("the hybrid reaches emergency evidence from the emergency page, within the same bounds", async () => {
    const embedder = axisEmbedder();
    const sources = await retrieveAssessmentSources(prospectId, { database, embed: embedder.embed });
    const emergency = sources.filter((source) => isEmergency(source.text));
    assert.ok(emergency.length >= 2, `${emergency.length} emergency chunks`);
    assert.ok(emergency.every((source) => source.via === "keyword" || source.via === "both"));
    assert.ok(emergency.some((source) => source.sourceUrl === `${SITE}/emergency-hvac-repair-in-linden-nj/`));
    // One embedding request for the six category queries, as before. No other provider call exists here.
    assert.equal(embedder.calls.length, 1);
    assert.equal(embedder.calls[0]!.length, ASSESSMENT_CATEGORIES.length);
    // Bounded: the same ceilings as the vector-only assessment.
    assert.ok(sources.length <= ASSESSMENT_RETRIEVAL_LIMITS.maxChunks);
    assert.ok(bytes(sources) <= ASSESSMENT_RETRIEVAL_LIMITS.maxBytes);
    assert.deepEqual(sources.map((source) => source.id), sources.map((_, index) => `S${index + 1}`));
  });

  await t.test("evidence is de-duplicated, comes from distinct pages, and no page contributes more than two keyword chunks", async () => {
    const sources = await retrieveAssessmentSources(prospectId, { database, embed: axisEmbedder().embed });
    // The widget is on four pages but reaches the assessor once.
    assert.equal(sources.filter((source) => source.text === WIDGET).length, 1);
    const texts = sources.map((source) => source.text.replace(/\s+/g, " ").trim().toLowerCase());
    assert.equal(new Set(texts).size, texts.length);
    // Emergency evidence from more than one page: the emergency page and the homepage call to action.
    const pages = new Set(sources.filter((source) => isEmergency(source.text)).map((source) => source.sourceUrl));
    assert.ok(pages.size >= 2, [...pages].join(", "));
    const keywordByPage = new Map<string, number>();
    for (const source of sources.filter((item) => item.via !== "vector"))
      keywordByPage.set(source.sourceUrl, (keywordByPage.get(source.sourceUrl) ?? 0) + 1);
    // (A keyword chunk may serve several categories, so the cap is per category; the total stays small.)
    assert.ok([...keywordByPage.values()].every((count) => count <= ASSESSMENT_CATEGORIES.length * ASSESSMENT_RETRIEVAL_LIMITS.maxKeywordPerPage));
    // Every source is a stored chunk of this prospect, verbatim.
    for (const source of sources) {
      const row = (await database.query("SELECT prospect_id, content, source_url FROM research_chunks WHERE id = $1", [source.chunkId])).rows[0];
      assert.equal(row.prospect_id, prospectId);
      assert.equal(row.content, source.text);
      assert.equal(row.source_url, source.sourceUrl);
    }
  });

  await t.test("retrieval is scoped to one prospect: another prospect's emergency text never appears", async () => {
    const other = await prospect([{ path: "/", chunks: [emergency("Emergency plumbing and gas leak repair for another company, call our other number now.")] }]);
    const sources = await retrieveAssessmentSources(prospectId, { database, embed: axisEmbedder().embed });
    assert.ok(sources.every((source) => !source.text.includes("another company")));
    assert.deepEqual(await searchResearchChunksByKeyword({ prospectId, query: "gas leak", limit: 5 }, database), []);
    const own = await searchResearchChunksByKeyword({ prospectId: other.prospectId, query: "gas leak", limit: 5 }, database);
    assert.equal(own.length, 1);
    assert.ok(own[0]!.rank > 0);
  });

  await t.test("keyword search reads only embedded chunks, ranks best-first, validates input, and is safe with odd syntax", async () => {
    const unembedded = await prospect([{ path: "/", chunks: [emergency("Emergency service here, but this chunk has no embedding.")] }], { embedded: false });
    assert.deepEqual(await searchResearchChunksByKeyword({ prospectId: unembedded.prospectId, query: "emergency", limit: 5 }, database), []);
    const chunksBefore = (await database.query("SELECT count(*)::int AS n FROM research_chunks")).rows[0].n;
    const hits = await searchResearchChunksByKeyword({ prospectId, query: ASSESSMENT_CATEGORIES.find((item) => item.id === "after_hours")!.keywords, limit: 20 }, database);
    assert.ok(hits.length >= 5);
    assert.deepEqual(hits.map((hit) => hit.rank), [...hits.map((hit) => hit.rank)].sort((a, b) => b - a));
    // The terms no longer collapse to stop-word leftovers, so every hit really is about emergency service.
    assert.ok(hits.every((hit) => isEmergency(hit.content)), hits.map((hit) => hit.content.slice(0, 40)).join(" | "));
    for (const odd of [`'; DROP TABLE research_chunks; --`, `"unbalanced quote`, `emergency or or or`, `!!!`])
      await searchResearchChunksByKeyword({ prospectId, query: odd, limit: 3 }, database);
    // The odd queries changed nothing (and the table still exists).
    assert.equal((await database.query("SELECT count(*)::int AS n FROM research_chunks")).rows[0].n, chunksBefore);
    // "24/7" is a usable term: it finds a chunk that contains it, and not one that does not.
    const around = await prospect([{ path: "/", chunks: [emergency("We answer the phone 24/7 for our customers."), plain("Where we work")] }]);
    const roundTheClock = await searchResearchChunksByKeyword({ prospectId: around.prospectId, query: '"24/7" or "around the clock"', limit: 5 }, database);
    assert.deepEqual(roundTheClock.map((hit) => hit.content.slice(0, 20)), ["We answer the phone "]);
    // Terms that PostgreSQL collapses into very common words are not used: "even if" must not match "evening".
    for (const category of ASSESSMENT_CATEGORIES) assert.doesNotMatch(category.keywords, /\b(?:evening|after hours|on call|contact you)\b/i, category.id);
    await assert.rejects(searchResearchChunksByKeyword({ prospectId, query: "   ", limit: 3 }, database), /1 to 500/);
    await assert.rejects(searchResearchChunksByKeyword({ prospectId, query: "x".repeat(501), limit: 3 }, database), /1 to 500/);
    await assert.rejects(searchResearchChunksByKeyword({ prospectId, query: "emergency", limit: 0 }, database), /between 1 and 20/);
    await assert.rejects(searchResearchChunksByKeyword({ prospectId: "not-a-uuid", query: "emergency", limit: 3 }, database), /UUID/);
  });

  await t.test("the assessor receives the emergency evidence and the server can accept it end to end", async () => {
    const embedder = axisEmbedder();
    const seen: { id: string; sourceUrl: string; text: string }[][] = [];
    const assess: Assessor = async (sources) => {
      seen.push(sources);
      const emergencySource = sources.find((source) => source.text.includes("# Emergency HVAC Repair in Linden, NJ"));
      assert.ok(emergencySource, "the emergency page's opening chunk must be among the sources");
      const draft = sampleDraft([{ id: sources[0]!.id, text: "Call 555-0100 to reach our office. Request a quote with the contact form. Technicians answer emergency calls 24 hours a day." }]);
      // Only the emergency claim is cited from what was actually retrieved.
      for (const item of draft.categories) item.observations = [];
      draft.categories.find((item: any) => item.category === "after_hours").observations = [
        { type: "emergency_service_stated", citations: [{ source: emergencySource.id, quote: "# Emergency HVAC Repair in Linden, NJ" }] },
      ];
      draft.preliminary_fit.signals = [{ signal: "urgent_or_emergency_service", citations: [{ source: emergencySource.id, quote: "# Emergency HVAC Repair in Linden, NJ" }] }];
      for (const item of draft.categories) item.hypotheses = [];
      draft.primary_opportunity_hypothesis = { category: "after_hours", observed: "emergency_service_stated", unknown: "after_hours_handling" };
      draft.top_opportunities = [{ category: "after_hours", observed: "urgent_or_emergency_service", unknown: "urgent_identification" }];
      return JSON.stringify(draft);
    };
    await generateLeadIntakeAssessment(prospectId, { database, embed: embedder.embed, assess, model: "test-model" });
    assert.equal(seen.length, 1);
    assert.equal(embedder.calls.length, 1);
    const record = (await listAssessments(prospectId, database)).records[0]!;
    const result = record.result as any;
    assert.equal(record.status, "completed");
    assert.equal(result.categories.find((item: any) => item.category === "after_hours").observations[0].statement, "The website states that it offers emergency service.");
    assert.deepEqual(result.fit.signals.map((signal: { id: string }) => signal.id), ["urgent_or_emergency_service"]);
    assert.match(result.primaryOpportunityHypothesis.statement, /emergency service, so it may be worth understanding what happens after hours\.$/);
    assert.ok(result.sources.some((source: { via: string; sourceUrl: string }) => source.via !== "vector" && source.sourceUrl.includes("emergency")));
    assert.ok(result.sources.every((source: { via: string }) => ["vector", "keyword", "both"].includes(source.via)));
  });
});
