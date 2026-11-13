import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import "../../scripts/check-test-database.js";
import {
  createResearchChunk,
  createResearchDocument,
} from "../../src/data/canonical-data.js";
import {
  indexProspectResearch,
  listDashboardProspects,
  listIndexedProspects,
  previewProspectResearch,
  searchResearchChunks,
} from "../../src/data/research-embeddings.js";
import {
  askRelay,
  UNVERIFIED_ANSWER,
} from "../../src/research/ask-relay.js";
import type { AnswerSource } from "../../src/research/openai-answerer.js";
import {
  RESEARCH_EMBEDDING_DIMENSIONS,
  type Embedder,
} from "../../src/research/openai-embeddings.js";
import { chunkResearchMarkdown } from "../../src/research/research-chunker.js";

// Deterministic bag-of-words vectors: texts sharing words are close.
function fakeVector(text: string): number[] {
  const vector = new Array<number>(RESEARCH_EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 0.001;
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261;
    for (const character of word) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    vector[1 + ((hash >>> 0) % (RESEARCH_EMBEDDING_DIMENSIONS - 1))]! += 1;
  }
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

function fakeEmbedder() {
  const calls: string[][] = [];
  const embed: Embedder = async (texts) => {
    calls.push(texts);
    return texts.map(fakeVector);
  };
  return { embed, calls };
}

const answerFrom =
  (draft: (sources: AnswerSource[]) => unknown, seen: AnswerSource[][] = []) =>
  async (_question: string, sources: AnswerSource[]) => {
    seen.push(sources);
    return JSON.stringify(draft(sources));
  };

const comfortPage = [
  "# Riverbend Comfort",
  "We repair furnaces and air conditioners in Riverbend.",
  "## Emergency service",
  "Technicians answer emergency calls 24 hours a day.",
  "## Service area",
  "We serve Riverbend, Oak Hollow, and Pine Flats.",
].join("\n\n");
const counselingQuestion = "Do you offer telehealth counseling sessions on weekends?";
const counselingPage = [
  "# Oak Hollow Counseling",
  counselingQuestion,
  "Yes: telehealth counseling sessions run on weekends.",
].join("\n\n");

test("Research embeddings: indexing, prospect-scoped search, and grounded answers", async (t) => {
  const connectionString = process.env.RELAY_DRAFT_TEST_DATABASE_URL!;
  const schema = `relay_research_embeddings_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const database = new Pool({
    connectionString,
    options: `-c search_path=${schema},public`,
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  const directory = new URL("../../migrations/", import.meta.url);
  const migrations = (await readdir(directory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const name of migrations)
    await database.query(await readFile(new URL(name, directory), "utf8"));

  async function prospectWithPage(website: string, content: string) {
    const prospectId = randomUUID(),
      researchRequestId = randomUUID();
    await database.query(
      "INSERT INTO prospects (id, company_name, website) VALUES ($1,$2,$3)",
      [prospectId, `Fixture ${website}`, website],
    );
    await database.query(
      `INSERT INTO prospect_research_requests (
        id, prospect_id, status, owner_token, input_snapshot, drive_parent_id
      ) VALUES ($1,$2,'research_review',$3,$4,'test_drive_parent')`,
      [researchRequestId, prospectId, randomUUID(), JSON.stringify({ website })],
    );
    const document = await createResearchDocument(
      {
        prospectId,
        researchRequestId,
        sourceUrl: website,
        pageType: "homepage",
        title: null,
        content,
        scrapedAt: new Date("2026-11-12T02:00:00.000Z"),
      },
      database,
    );
    return { prospectId, documentId: document.id };
  }

  const comfort = await prospectWithPage("https://riverbend.example.com/", comfortPage);
  const counseling = await prospectWithPage(
    "https://oakhollow.example.com/",
    counselingPage,
  );
  const comfortChunks = chunkResearchMarkdown(comfortPage);

  await t.test("migration 015 accepts only complete 1536-dimension vectors", async () => {
    const { prospectId, documentId } = await prospectWithPage(
      "https://constraints.example.com/",
      "# Constraint fixture",
    );
    const insert = (index: number, embedding: string | null, model: string | null) =>
      database.query(
        `INSERT INTO research_chunks (
          prospect_id, research_document_id, content, embedding, embedding_model,
          source_url, chunk_index
        ) VALUES ($1,$2,'Constraint fixture.',$3::public.vector,$4,$5,$6)`,
        [prospectId, documentId, embedding, model, "https://constraints.example.com/", index],
      );
    const full = JSON.stringify(fakeVector("constraint"));
    await insert(0, full, "text-embedding-3-small");
    await insert(1, null, null);
    await assert.rejects(insert(2, full, null));
    await assert.rejects(insert(3, null, "text-embedding-3-small"));
    await assert.rejects(insert(4, full, "text-embedding-3-large"));
    await assert.rejects(insert(5, "[1,2,3]", "text-embedding-3-small"));
  });

  await t.test("indexing embeds each chunk once and later runs reuse stored vectors", async () => {
    const first = fakeEmbedder();
    const result = await indexProspectResearch(comfort.prospectId, {
      database,
      embed: first.embed,
    });
    assert.deepEqual(result, {
      documents: 1,
      chunks: comfortChunks.length,
      embedded: comfortChunks.length,
      reused: 0,
    });
    assert.deepEqual(first.calls, [comfortChunks.map((chunk) => chunk.content)]);

    const stored = await database.query(
      `SELECT chunk_index, content, source_url, embedding_model,
        vector_dims(embedding) AS dimensions
      FROM research_chunks WHERE prospect_id = $1 ORDER BY chunk_index`,
      [comfort.prospectId],
    );
    assert.deepEqual(
      stored.rows,
      comfortChunks.map((chunk) => ({
        chunk_index: chunk.index,
        content: chunk.content,
        source_url: "https://riverbend.example.com/",
        embedding_model: "text-embedding-3-small",
        dimensions: 1536,
      })),
    );
    // Indexing one prospect never writes another prospect's chunks.
    const others = await database.query(
      "SELECT count(*)::int AS count FROM research_chunks WHERE prospect_id = $1",
      [counseling.prospectId],
    );
    assert.equal(others.rows[0].count, 0);

    const again = fakeEmbedder();
    assert.deepEqual(
      await indexProspectResearch(comfort.prospectId, { database, embed: again.embed }),
      { documents: 1, chunks: comfortChunks.length, embedded: 0, reused: comfortChunks.length },
    );
    assert.equal(again.calls.length, 0);
    assert.deepEqual(await previewProspectResearch(comfort.prospectId, database), [
      {
        documentId: comfort.documentId,
        sourceUrl: "https://riverbend.example.com/",
        chunks: comfortChunks.length,
        embedded: comfortChunks.length,
      },
    ]);
  });

  await t.test("a failed embedding call writes nothing and a retry completes", async () => {
    const page = "# Retry fixture\n\nFirst section.\n\n## More\n\nSecond section.";
    const { prospectId, documentId } = await prospectWithPage(
      "https://retry.example.com/",
      page,
    );
    const [planned] = chunkResearchMarkdown(page);
    // A chunk saved earlier without an embedding is filled, not duplicated.
    const existing = await createResearchChunk(
      { prospectId, researchDocumentId: documentId, content: planned!.content, chunkIndex: 0 },
      database,
    );
    await assert.rejects(
      indexProspectResearch(prospectId, {
        database,
        embed: async () => {
          throw new Error("provider timeout");
        },
      }),
      /provider timeout/,
    );
    const afterFailure = await database.query(
      "SELECT id, embedding FROM research_chunks WHERE prospect_id = $1",
      [prospectId],
    );
    assert.deepEqual(afterFailure.rows, [{ id: existing.id, embedding: null }]);

    const retry = await indexProspectResearch(prospectId, {
      database,
      embed: fakeEmbedder().embed,
    });
    assert.deepEqual(retry, { documents: 1, chunks: 2, embedded: 2, reused: 0 });
    const afterRetry = await database.query(
      `SELECT id, chunk_index, embedding IS NOT NULL AS embedded
      FROM research_chunks WHERE prospect_id = $1 ORDER BY chunk_index`,
      [prospectId],
    );
    assert.equal(afterRetry.rows[0].id, existing.id);
    assert.deepEqual(
      afterRetry.rows.map((row) => [row.chunk_index, row.embedded]),
      [
        [0, true],
        [1, true],
      ],
    );
  });

  await t.test("stored chunks that differ from deterministic chunking stop indexing", async () => {
    const { prospectId, documentId } = await prospectWithPage(
      "https://conflict.example.com/",
      "# Conflict fixture\n\nCurrent text.",
    );
    await createResearchChunk(
      { prospectId, researchDocumentId: documentId, content: "Older chunking.", chunkIndex: 0 },
      database,
    );
    const embedder = fakeEmbedder();
    await assert.rejects(
      indexProspectResearch(prospectId, { database, embed: embedder.embed }),
      /differ from its deterministic chunking/,
    );
    assert.equal(embedder.calls.length, 0);
    const stored = await database.query(
      "SELECT content, embedding FROM research_chunks WHERE prospect_id = $1",
      [prospectId],
    );
    assert.deepEqual(stored.rows, [{ content: "Older chunking.", embedding: null }]);
  });

  await t.test("search and Ask Relay never cross prospect boundaries", async () => {
    await indexProspectResearch(counseling.prospectId, {
      database,
      embed: fakeEmbedder().embed,
    });
    const query = fakeVector(counselingQuestion);
    const scoped = await searchResearchChunks(
      { prospectId: comfort.prospectId, embedding: query, limit: 20 },
      database,
    );
    assert.equal(scoped.length, comfortChunks.length);
    assert.ok(scoped.every((chunk) => chunk.sourceUrl === "https://riverbend.example.com/"));
    // The nearest stored vector overall belongs to the counseling prospect,
    // yet the comfort prospect's search never returned it.
    const own = await searchResearchChunks(
      { prospectId: counseling.prospectId, embedding: query, limit: 1 },
      database,
    );
    assert.equal(own[0]!.sourceUrl, "https://oakhollow.example.com/");
    assert.ok(own[0]!.similarity > Math.max(...scoped.map((chunk) => chunk.similarity)));
    assert.deepEqual(
      await searchResearchChunks(
        { prospectId: randomUUID(), embedding: query, limit: 20 },
        database,
      ),
      [],
    );

    const seen: AnswerSource[][] = [];
    const result = await askRelay(
      { prospectId: comfort.prospectId, question: counselingQuestion },
      {
        database,
        embed: fakeEmbedder().embed,
        answer: answerFrom(
          () => ({ status: "insufficient_evidence", answer: "Not covered.", citations: [] }),
          seen,
        ),
      },
    );
    assert.equal(result.status, "insufficient_evidence");
    assert.ok(seen[0]!.every((source) => source.sourceUrl === "https://riverbend.example.com/"));
    assert.ok(seen[0]!.every((source) => !source.text.includes("telehealth")));

    // A prospect without embedded research gets no provider calls at all.
    const embedder = fakeEmbedder();
    const unanswered: AnswerSource[][] = [];
    const empty = await askRelay(
      { prospectId: randomUUID(), question: "What services are offered?" },
      { database, embed: embedder.embed, answer: answerFrom(() => ({}), unanswered) },
    );
    assert.equal(empty.status, "insufficient_evidence");
    assert.equal(empty.reason, "no_indexed_research");
    assert.equal(embedder.calls.length, 0);
    assert.equal(unanswered.length, 0);
  });

  await t.test("Ask Relay answers from retrieved chunks with source URLs and holds unsupported answers", async () => {
    const question = "Which towns do you serve?";
    const quoteTop = () => ({
      status: "answered",
      answer: "Riverbend, Oak Hollow, and Pine Flats.",
      citations: [{ source: "S1", quote: "Riverbend, Oak Hollow, and Pine Flats" }],
    });
    const seen: AnswerSource[][] = [];
    const answered = await askRelay(
      { prospectId: comfort.prospectId, question },
      { database, embed: fakeEmbedder().embed, answer: answerFrom(quoteTop, seen) },
    );
    // Vector similarity put the service-area chunk first.
    assert.match(seen[0]![0]!.text, /## Service area/);
    assert.equal(answered.status, "answered");
    assert.equal(answered.reason, null);
    assert.deepEqual(answered.citations, [
      {
        sourceId: "S1",
        sourceUrl: "https://riverbend.example.com/",
        quote: "Riverbend, Oak Hollow, and Pine Flats",
      },
    ]);
    assert.equal(answered.retrieved.length, comfortChunks.length);

    const declined = await askRelay(
      { prospectId: comfort.prospectId, question: "Which insurance plans do you accept?" },
      {
        database,
        embed: fakeEmbedder().embed,
        answer: answerFrom(() => ({
          status: "insufficient_evidence",
          answer: "The excerpts do not mention insurance.",
          citations: [],
        })),
      },
    );
    assert.equal(declined.status, "insufficient_evidence");
    assert.equal(declined.reason, "model_reported");
    assert.deepEqual(declined.citations, []);

    const fabricated = await askRelay(
      { prospectId: comfort.prospectId, question },
      {
        database,
        embed: fakeEmbedder().embed,
        answer: answerFrom(() => ({
          status: "answered",
          answer: "They also serve Santa Clara.",
          citations: [{ source: "S1", quote: "We serve Santa Clara" }],
        })),
      },
    );
    assert.equal(fabricated.status, "insufficient_evidence");
    assert.equal(fabricated.reason, "unverified_citations");
    assert.equal(fabricated.answer, UNVERIFIED_ANSWER);

    await assert.rejects(
      askRelay(
        { prospectId: comfort.prospectId, question },
        {
          database,
          embed: fakeEmbedder().embed,
          answer: answerFrom(() => ({
            status: "answered",
            answer: "Unlisted source.",
            citations: [{ source: "S99", quote: "Riverbend" }],
          })),
        },
      ),
      /expected schema/,
    );
  });

  await t.test("only prospects with embedded research are offered to Ask Relay", async () => {
    const unindexed = await prospectWithPage(
      "https://unindexed.example.com/",
      "# Not indexed yet",
    );
    const listed = await listIndexedProspects(database);
    const byId = new Map(listed.map((prospect) => [prospect.id, prospect]));
    assert.deepEqual(byId.get(comfort.prospectId), {
      id: comfort.prospectId,
      companyName: "Fixture https://riverbend.example.com/",
      website: "https://riverbend.example.com/",
      embeddedChunks: comfortChunks.length,
    });
    assert.ok(byId.has(counseling.prospectId));
    assert.equal(byId.has(unindexed.prospectId), false);
    const dashboard = await listDashboardProspects(database);
    const dashboardById = new Map(dashboard.map((prospect) => [prospect.id, prospect]));
    assert.equal(dashboardById.get(unindexed.prospectId)?.embeddedChunks, 0);
    assert.equal(dashboardById.get(comfort.prospectId)?.embeddedChunks, comfortChunks.length);
    assert.equal(dashboardById.get(unindexed.prospectId)?.companyName, "Fixture https://unindexed.example.com/");
    // A prospect whose only chunk has no embedding is not offered either.
    assert.ok(
      listed.every((prospect) => prospect.website !== "https://conflict.example.com/"),
    );
  });
});
