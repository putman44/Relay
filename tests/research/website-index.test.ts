import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import "../../scripts/check-test-database.js";
import { listDashboardProspects, listIndexedProspects } from "../../src/data/research-embeddings.js";
import { RESEARCH_EMBEDDING_DIMENSIONS, RESEARCH_EMBEDDING_MODEL, type Embedder } from "../../src/research/openai-embeddings.js";
import { researchAndIndexWebsite } from "../../src/research/website-index.js";
import type { PageScraper } from "../../src/research/research-evidence.js";

test("website research saves evidence, indexes with fake providers, and holds uncertain retries", async (t) => {
  const connectionString = process.env.RELAY_DRAFT_TEST_DATABASE_URL!;
  const schema = `relay_website_index_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const database = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const directory = new URL("../../migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name) && !name.startsWith("016_")).sort())
    await database.query(await readFile(new URL(name, directory), "utf8"));

  const vector = new Array<number>(RESEARCH_EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 1;
  const legacyId = randomUUID(), legacyRequest = randomUUID();
  await database.query("INSERT INTO prospects (id, company_name, website) VALUES ($1,'Legacy demo','https://legacy.testsite.org/')", [legacyId]);
  await database.query(
    `INSERT INTO prospect_research_requests (id, prospect_id, status, owner_token, input_snapshot, drive_parent_id)
     VALUES ($1,$2,'research_review',$3,'{}','ask_relay_demo')`, [legacyRequest, legacyId, randomUUID()],
  );
  const legacyDocument = await database.query<{ id: string }>(
    `INSERT INTO research_documents (prospect_id, research_request_id, source_url, page_type, content, scraped_at)
     VALUES ($1,$2,'https://legacy.testsite.org/','homepage','Legacy research',now()) RETURNING id`, [legacyId, legacyRequest],
  );
  await database.query(
    `INSERT INTO research_chunks (prospect_id, research_document_id, content, source_url, chunk_index, embedding, embedding_model)
     VALUES ($1,$2,'Legacy research','https://legacy.testsite.org/',0,$3::public.vector,$4)`,
    [legacyId, legacyDocument.rows[0]!.id, JSON.stringify(vector), RESEARCH_EMBEDDING_MODEL],
  );
  await database.query(await readFile(new URL("016_add_website_index_status.sql", directory), "utf8"));
  const legacy = await database.query<{ website_index_status: string | null; dimensions: number }>(
    `SELECT r.website_index_status, vector_dims(c.embedding) AS dimensions
     FROM prospect_research_requests r JOIN research_chunks c ON c.prospect_id = r.prospect_id
     WHERE r.prospect_id = $1`, [legacyId],
  );
  assert.deepEqual(legacy.rows, [{ website_index_status: null, dimensions: RESEARCH_EMBEDDING_DIMENSIONS }]);
  assert.ok((await listIndexedProspects(database)).some((item) => item.id === legacyId));
  let embedCalls = 0;
  const embed: Embedder = async (texts) => { embedCalls++; return texts.map(() => vector); };
  const createProspect = async (website: string) => {
    const id = randomUUID();
    await database.query("INSERT INTO prospects (id, company_name, website) VALUES ($1,$2,$3)", [id, `Fixture ${id}`, website]);
    return id;
  };
  const row = async (id: string) => (await database.query<{
    id: string; status: string; website_index_status: string; evidence: { pages: Array<{ url: string }> } | null;
  }>("SELECT id, status, website_index_status, evidence FROM prospect_research_requests WHERE prospect_id = $1", [id])).rows[0]!;
  const counts = async (id: string) => (await database.query<{ documents: number; chunks: number; embedded: number }>(
    `SELECT count(DISTINCT d.id)::int AS documents, count(c.id)::int AS chunks,
      count(c.embedding)::int AS embedded FROM research_documents d
      LEFT JOIN research_chunks c ON c.research_document_id = d.id WHERE d.prospect_id = $1`, [id],
  )).rows[0]!;
  const website = "https://website-index.testsite.org/";
  const contact = `${website}contact`;
  const calls: string[] = [];
  const scrape: PageScraper = async (url) => {
    calls.push(url);
    return { url, markdown: url === website ? "# Fixture\n\nWe provide service." : "# Contact\n\nCall for service.", links: url === website ? [contact] : [], scrapedAt: "2026-11-13T12:00:00.000Z" };
  };

  await t.test("success stores two sourced documents and complete vectors; duplicate start does not scrape", async () => {
    const id = await createProspect(website);
    await researchAndIndexWebsite(id, { database, scrape, embed });
    const saved = await row(id);
    assert.equal(saved.website_index_status, "ready");
    assert.deepEqual(saved.evidence?.pages.map((page) => page.url), [website, contact]);
    assert.deepEqual(await counts(id), { documents: 2, chunks: 2, embedded: 2 });
    assert.deepEqual(calls, [website, contact]);
    assert.equal(embedCalls, 2);
    const sources = await database.query<{ source_url: string; embedding_model: string; dimensions: number }>(
      `SELECT source_url, embedding_model, vector_dims(embedding) AS dimensions
       FROM research_chunks WHERE prospect_id = $1 ORDER BY source_url`, [id],
    );
    assert.deepEqual(sources.rows.map((item) => item.source_url), [website, contact]);
    assert.ok(sources.rows.every((item) => item.embedding_model === RESEARCH_EMBEDDING_MODEL && item.dimensions === RESEARCH_EMBEDDING_DIMENSIONS));
    assert.equal((await listDashboardProspects(database)).find((item) => item.id === id)?.websiteIndexStatus, "ready");
    assert.ok((await listIndexedProspects(database)).some((item) => item.id === id));
    await assert.rejects(researchAndIndexWebsite(id, { database, scrape, embed }), /already indexed/);
    assert.deepEqual(calls, [website, contact]);
    assert.deepEqual(await counts(id), { documents: 2, chunks: 2, embedded: 2 });
  });

  await t.test("embedding failure retains documents; confirmed retry reuses them without Firecrawl", async () => {
    const retryWebsite = "https://retry-index.testsite.org/";
    const id = await createProspect(retryWebsite);
    let scraped = 0;
    const retryScrape: PageScraper = async (url) => { scraped++; return { url, markdown: "# Retry\n\nSaved research.", links: url === retryWebsite ? [`${retryWebsite}contact`] : [], scrapedAt: "2026-11-13T12:00:00.000Z" }; };
    let initialEmbeds = 0;
    await assert.rejects(researchAndIndexWebsite(id, { database, scrape: retryScrape, embed: async (texts) => {
      initialEmbeds++;
      if (initialEmbeds === 2) throw new Error("fake embedding failure");
      return texts.map(() => vector);
    } }), /fake embedding failure/);
    assert.equal((await row(id)).website_index_status, "needs_review");
    assert.deepEqual(await counts(id), { documents: 2, chunks: 1, embedded: 1 });
    let retryEmbeds = 0;
    await researchAndIndexWebsite(id, { database, scrape: retryScrape, embed: async (texts) => {
      retryEmbeds++;
      return texts.map(() => vector);
    } });
    assert.equal(scraped, 2);
    assert.equal(retryEmbeds, 1);
    assert.equal((await row(id)).website_index_status, "ready");
    assert.deepEqual(await counts(id), { documents: 2, chunks: 2, embedded: 2 });
  });

  await t.test("uncertain collection is held and never scraped automatically again", async () => {
    const id = await createProspect("https://uncertain-index.testsite.org/");
    let scraped = 0;
    const uncertain: PageScraper = async () => { scraped++; throw new Error("timeout after provider request"); };
    await assert.rejects(researchAndIndexWebsite(id, { database, scrape: uncertain, embed }), /timeout/);
    assert.equal((await row(id)).website_index_status, "needs_review");
    assert.equal((await row(id)).status, "needs_reconciliation");
    await assert.rejects(researchAndIndexWebsite(id, { database, scrape: uncertain, embed }), /requires review/);
    assert.equal(scraped, 1);
    assert.deepEqual(await counts(id), { documents: 0, chunks: 0, embedded: 0 });
  });

  await t.test("existing indexed demo-style prospects remain Ask Relay eligible", async () => {
    for (let i = 0; i < 3; i++) {
      const id = await createProspect(`https://demo${i}.testsite.org/`);
      const requestId = randomUUID();
      await database.query(
        `INSERT INTO prospect_research_requests (id, prospect_id, status, owner_token, input_snapshot, drive_parent_id)
         VALUES ($1,$2,'research_review',$3,'{}','ask_relay_demo')`, [requestId, id, randomUUID()],
      );
      const document = await database.query<{ id: string }>(
        `INSERT INTO research_documents (prospect_id, research_request_id, source_url, page_type, content, scraped_at)
         VALUES ($1,$2,$3,'homepage','Demo research',now()) RETURNING id`, [id, requestId, `https://demo${i}.testsite.org/`],
      );
      await database.query(
        `INSERT INTO research_chunks (prospect_id, research_document_id, content, source_url, chunk_index, embedding, embedding_model)
         VALUES ($1,$2,'Demo research',$3,0,$4::public.vector,$5)`,
        [id, document.rows[0]!.id, `https://demo${i}.testsite.org/`, JSON.stringify(vector), RESEARCH_EMBEDDING_MODEL],
      );
      assert.ok((await listIndexedProspects(database)).some((item) => item.id === id));
      assert.equal((await listDashboardProspects(database)).find((item) => item.id === id)?.websiteIndexStatus, null);
    }
  });
});
