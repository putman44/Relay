import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import "../../scripts/check-test-database.js";
import {
  createEmailCommunication,
  createResearchChunk,
  createResearchDocument,
} from "../../src/data/canonical-data.js";
import { saveResearchPages } from "../../src/data/save-research-pages.js";

test("Canonical data foundation: persistence and relational constraints", async (t) => {
  const connectionString = process.env.RELAY_DRAFT_TEST_DATABASE_URL!;
  const schema = `relay_canonical_data_${randomUUID().replaceAll("-", "")}`;
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

  const prospectId = randomUUID();
  const otherProspectId = randomUUID();
  const researchRequestId = randomUUID();
  await database.query(
    "INSERT INTO prospects (id, company_name, website) VALUES ($1,$2,$3),($4,$5,$6)",
    [
      prospectId,
      "Canonical Data Fixture",
      "https://canonical-data-fixture.com/",
      otherProspectId,
      "Other Fixture",
      "https://other-canonical-fixture.com/",
    ],
  );
  await database.query(
    `INSERT INTO prospect_research_requests (
    id, prospect_id, status, owner_token, input_snapshot, drive_parent_id
  ) VALUES ($1,$2,'researching',$3,$4,$5)`,
    [
      researchRequestId,
      prospectId,
      randomUUID(),
      JSON.stringify({ website: "https://canonical-data-fixture.com/" }),
      "test_drive_parent",
    ],
  );

  let documentId = "";
  await t.test(
    "persists a research document bound to its prospect and request",
    async () => {
      const document = await createResearchDocument(
        {
          prospectId,
          researchRequestId,
          sourceUrl: "https://canonical-data-fixture.com/about",
          pageType: "about",
          title: "About the fixture",
          content: "Durable source content.",
          scrapedAt: new Date("2026-11-02T12:00:00.000Z"),
        },
        database,
      );
      documentId = document.id;
      assert.equal(document.prospect_id, prospectId);
      assert.equal(document.research_request_id, researchRequestId);
      assert.equal(
        document.source_url,
        "https://canonical-data-fixture.com/about",
      );
      await assert.rejects(
        createResearchDocument(
          {
            prospectId: otherProspectId,
            researchRequestId,
            sourceUrl: "https://canonical-data-fixture.com/mismatch",
            pageType: "other",
            title: null,
            content: "Must not persist.",
            scrapedAt: new Date(),
          },
          database,
        ),
      );
    },
  );

  await t.test("saves three Firecrawl pages in one transaction", async () => {
    const website = "https://canonical-data-fixture.com/";
    const scrapedAt = "2026-11-12T01:30:00.000Z";

    const pages = [
      {
        url: website,
        markdown: "# Homepage\n\nOriginal homepage content.",
        links: [],
        scrapedAt,
      },
      {
        url: `${website}relay`,
        markdown: "# Relay\n\nOriginal Relay content.",
        links: [],
        scrapedAt,
      },
      {
        url: `${website}portfolio`,
        markdown: "# Portfolio\n\nOriginal portfolio content.",
        links: [],
        scrapedAt,
      },
    ];

    const client = await database.connect();

    try {
      await client.query("BEGIN");

      const saved = await saveResearchPages(
        {
          prospectId,
          researchRequestId,
          website,
          evidence: { pages, limitations: [] },
        },
        client,
      );

      assert.equal(saved.length, 3);

      for (let i = 0; i < pages.length; i++) {
        assert.equal(saved[i]?.source_url, pages[i]?.url);
        assert.equal(saved[i]?.content, pages[i]?.markdown);
        assert.equal(saved[i]?.scraped_at.toISOString(), scrapedAt);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    // Confirm the documents survived after the transaction committed.
    const result = await database.query(
      `SELECT id
     FROM research_documents
     WHERE research_request_id = $1
       AND source_url = ANY($2::text[])`,
      [researchRequestId, pages.map((page) => page.url)],
    );

    assert.equal(result.rows.length, 3);
  });

  await t.test("rolls back documents when a later page conflicts", async () => {
    const website = "https://canonical-data-fixture.com/";
    const scrapedAt = "2026-11-12T01:30:00.000Z";
    const temporaryUrl = `${website}rollback-check`;

    const pages = [
      {
        // Already saved by our previous test, with matching content.
        url: website,
        markdown: "# Homepage\n\nOriginal homepage content.",
        links: [],
        scrapedAt,
      },
      {
        // This is a new document that should be rolled back.
        url: temporaryUrl,
        markdown: "# Temporary\n\nShould not remain in SQL.",
        links: [],
        scrapedAt,
      },
      {
        // This URL already exists, but the content is different.
        url: `${website}relay`,
        markdown: "# Relay\n\nConflicting content.",
        links: [],
        scrapedAt,
      },
    ];

    const client = await database.connect();

    try {
      await client.query("BEGIN");

      await assert.rejects(
        saveResearchPages(
          {
            prospectId,
            researchRequestId,
            website,
            evidence: { pages, limitations: [] },
          },
          client,
        ),
        /Existing research document conflicts with saved evidence/,
      );

      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const result = await database.query(
      `SELECT id FROM research_documents
     WHERE research_request_id = $1 AND source_url = $2`,
      [researchRequestId, temporaryUrl],
    );

    assert.equal(result.rows.length, 0);
  });

  await t.test(
    "reuses identical research documents and rejects conflicting retries",
    async () => {
      const input = {
        prospectId,
        researchRequestId,
        sourceUrl: "https://canonical-data-fixture.com/about",
        pageType: "about" as const,
        title: "About the fixture",
        content: "Durable source content.",
        scrapedAt: new Date("2026-11-02T12:00:00.000Z"),
      };

      // Test 1: Saving the same page again reuses its ID.
      const repeated = await createResearchDocument(input, database);

      assert.equal(repeated.id, documentId);
      assert.equal(repeated.content, input.content);

      // Test 2: Changing the content must be rejected.
      await assert.rejects(
        createResearchDocument(
          { ...input, content: "Conflicting website content." },
          database,
        ),
        /Existing research document conflicts with saved evidence/,
      );

      // A changed scrape timestamp must also be rejected.
      await assert.rejects(
        createResearchDocument(
          {
            ...input,
            scrapedAt: new Date("2026-11-02T13:00:00.000Z"),
          },
          database,
        ),
        /Existing research document conflicts with saved evidence/,
      );

      // Test 3: The original document remains unchanged.
      const saved = await database.query<{
        id: string;
        content: string;
      }>(
        `SELECT id, content
       FROM research_documents
       WHERE research_request_id = $1
         AND source_url = $2`,
        [researchRequestId, input.sourceUrl],
      );

      assert.equal(saved.rows.length, 1);
      assert.equal(saved.rows[0]?.id, documentId);
      assert.equal(saved.rows[0]?.content, input.content);
    },
  );

  await t.test(
    "persists a research chunk with the document source and no embedding",
    async () => {
      const chunk = await createResearchChunk(
        {
          prospectId,
          researchDocumentId: documentId,
          content: "A smaller durable section.",
          chunkIndex: 0,
        },
        database,
      );
      assert.equal(chunk.research_document_id, documentId);
      assert.equal(
        chunk.source_url,
        "https://canonical-data-fixture.com/about",
      );
      assert.equal(chunk.embedding, null);
      await assert.rejects(
        createResearchChunk(
          {
            prospectId: otherProspectId,
            researchDocumentId: documentId,
            content: "Wrong prospect.",
            chunkIndex: 1,
          },
          database,
        ),
      );
      await assert.rejects(
        database.query(
          `INSERT INTO research_chunks (
      prospect_id, research_document_id, content, source_url, chunk_index
    ) VALUES ($1,$2,$3,$4,$5)`,
          [
            prospectId,
            documentId,
            "Wrong source URL.",
            "https://canonical-data-fixture.com/contact",
            1,
          ],
        ),
      );
      await assert.rejects(
        database.query(
          `INSERT INTO research_chunks (
      prospect_id, research_document_id, content, embedding, source_url, chunk_index
    ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            prospectId,
            documentId,
            "Premature embedding.",
            "[1,2,3]",
            "https://canonical-data-fixture.com/about",
            1,
          ],
        ),
      );
    },
  );

  await t.test(
    "persists inbound and outbound email communications",
    async () => {
      const inbound = await createEmailCommunication(
        {
          prospectId,
          direction: "inbound",
          gmailMessageId: "gmail-inbound-fixture",
          gmailThreadId: "gmail-thread-fixture",
          subject: "Re: Hello",
          body: "Thanks for reaching out.",
          receivedAt: new Date("2026-11-02T13:00:00.000Z"),
        },
        database,
      );
      const outbound = await createEmailCommunication(
        {
          prospectId,
          direction: "outbound",
          gmailMessageId: "gmail-outbound-fixture",
          gmailThreadId: "gmail-thread-fixture",
          subject: "Hello",
          body: "A human-approved message.",
          sentAt: new Date("2026-11-02T12:30:00.000Z"),
        },
        database,
      );
      assert.equal(inbound.status, "received");
      assert.equal(inbound.sent_at, null);
      assert.equal(outbound.status, "sent");
      assert.equal(outbound.received_at, null);
      await assert.rejects(
        createEmailCommunication(
          {
            prospectId: randomUUID(),
            direction: "inbound",
            gmailMessageId: "gmail-missing-prospect",
            gmailThreadId: null,
            subject: "",
            body: "",
            receivedAt: new Date(),
          },
          database,
        ),
      );
    },
  );
});
