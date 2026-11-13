import type { Pool, PoolClient } from "pg";
import {
  isResearchEmbedding,
  MAX_EMBEDDING_BATCH,
  RESEARCH_EMBEDDING_MODEL,
  type Embedder,
} from "../research/openai-embeddings.js";
import {
  chunkResearchMarkdown,
  type ResearchTextChunk,
} from "../research/research-chunker.js";

type Database = Pick<Pool, "query">;

type DocumentRow = { id: string; source_url: string; content: string };
type StoredChunk = {
  id: string;
  chunk_index: number;
  content: string;
  embedding_model: string | null;
};

export type ResearchDocumentIndexState = {
  documentId: string;
  sourceUrl: string;
  chunks: number;
  embedded: number;
};

export type ResearchIndexResult = {
  documents: number;
  chunks: number;
  // Chunk embeddings written by this run.
  embedded: number;
  // Chunks that already had an embedding and were left unchanged.
  reused: number;
};

export type RetrievedResearchChunk = {
  id: string;
  researchDocumentId: string;
  sourceUrl: string;
  chunkIndex: number;
  content: string;
  similarity: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function prospectUuid(value: string): string {
  if (!UUID.test(value)) throw new Error("prospectId must be a UUID.");
  return value.toLowerCase();
}

async function transaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await run(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  } finally {
    client.release();
  }
}

async function loadDocuments(
  prospectId: string,
  database: Database,
): Promise<DocumentRow[]> {
  const result = await database.query<DocumentRow>(
    `SELECT id, source_url, content FROM research_documents
    WHERE prospect_id = $1 ORDER BY scraped_at, source_url, id`,
    [prospectId],
  );
  return result.rows;
}

async function loadChunks(
  documentId: string,
  prospectId: string,
  database: Database,
): Promise<StoredChunk[]> {
  const result = await database.query<StoredChunk>(
    `SELECT id, chunk_index, content, embedding_model FROM research_chunks
    WHERE research_document_id = $1 AND prospect_id = $2 ORDER BY chunk_index`,
    [documentId, prospectId],
  );
  return result.rows;
}

// Planned chunks that still need an embedding. Stored chunks must match the
// deterministic chunking exactly; a mismatch stops indexing instead of
// overwriting or deleting stored evidence.
function chunksToEmbed(
  planned: ResearchTextChunk[],
  stored: StoredChunk[],
  documentId: string,
): ResearchTextChunk[] {
  for (const chunk of stored) {
    if (planned[chunk.chunk_index]?.content !== chunk.content)
      throw new Error(
        `Stored chunks for research document ${documentId} differ from its deterministic chunking; inspect before indexing.`,
      );
  }
  const embedded = new Set(
    stored
      .filter((chunk) => chunk.embedding_model !== null)
      .map((chunk) => chunk.chunk_index),
  );
  return planned.filter((chunk) => !embedded.has(chunk.index));
}

// Read-only: how each research document of the prospect would be chunked, and
// how many of those chunks already have embeddings.
export async function previewProspectResearch(
  prospectId: string,
  database: Database,
): Promise<ResearchDocumentIndexState[]> {
  const id = prospectUuid(prospectId);
  const states: ResearchDocumentIndexState[] = [];
  for (const document of await loadDocuments(id, database)) {
    const planned = chunkResearchMarkdown(document.content);
    const missing = chunksToEmbed(
      planned,
      await loadChunks(document.id, id, database),
      document.id,
    );
    states.push({
      documentId: document.id,
      sourceUrl: document.source_url,
      chunks: planned.length,
      embedded: planned.length - missing.length,
    });
  }
  return states;
}

// Chunks and embeds every research document of one prospect. Safe to re-run:
// already embedded chunks are reused without a provider call, and each
// document's new rows are written in one transaction after its embeddings
// succeed, so a failed provider call leaves nothing partial for that document.
export async function indexProspectResearch(
  prospectId: string,
  deps: { database: Pool; embed: Embedder },
): Promise<ResearchIndexResult> {
  const id = prospectUuid(prospectId);
  const documents = await loadDocuments(id, deps.database);
  const result: ResearchIndexResult = {
    documents: documents.length,
    chunks: 0,
    embedded: 0,
    reused: 0,
  };

  for (const document of documents) {
    const planned = chunkResearchMarkdown(document.content);
    result.chunks += planned.length;
    const missing = chunksToEmbed(
      planned,
      await loadChunks(document.id, id, deps.database),
      document.id,
    );
    if (!missing.length) {
      result.reused += planned.length;
      continue;
    }

    // Provider calls happen before any lock is taken.
    const embeddings: number[][] = [];
    for (let start = 0; start < missing.length; start += MAX_EMBEDDING_BATCH) {
      const batch = missing.slice(start, start + MAX_EMBEDDING_BATCH);
      const vectors = await deps.embed(batch.map((chunk) => chunk.content));
      if (
        !Array.isArray(vectors) ||
        vectors.length !== batch.length ||
        !vectors.every(isResearchEmbedding)
      )
        throw new Error("Embedding provider returned an invalid response.");
      embeddings.push(...vectors);
    }

    const written = await transaction(deps.database, async (client) => {
      const locked = await client.query(
        "SELECT id FROM research_documents WHERE id = $1 AND prospect_id = $2 FOR UPDATE",
        [document.id, id],
      );
      if (locked.rowCount !== 1)
        throw new Error("Research document changed during indexing.");

      // Recheck under the lock: another run may have embedded chunks since.
      const stored = await loadChunks(document.id, id, client);
      chunksToEmbed(planned, stored, document.id);
      const byIndex = new Map(stored.map((chunk) => [chunk.chunk_index, chunk]));

      let count = 0;
      for (const [position, chunk] of missing.entries()) {
        const existing = byIndex.get(chunk.index);
        if (existing?.embedding_model) continue;
        const vector = JSON.stringify(embeddings[position]);
        const changed = existing
          ? await client.query(
              `UPDATE research_chunks
              SET embedding = $3::public.vector, embedding_model = $4
              WHERE id = $1 AND prospect_id = $2 AND embedding IS NULL`,
              [existing.id, id, vector, RESEARCH_EMBEDDING_MODEL],
            )
          : await client.query(
              `INSERT INTO research_chunks (
                prospect_id, research_document_id, content, embedding,
                embedding_model, source_url, chunk_index
              )
              SELECT $1, id, $3, $4::public.vector, $5, source_url, $6
              FROM research_documents WHERE id = $2 AND prospect_id = $1`,
              [
                id,
                document.id,
                chunk.content,
                vector,
                RESEARCH_EMBEDDING_MODEL,
                chunk.index,
              ],
            );
        if (changed.rowCount !== 1)
          throw new Error("Research chunk changed during indexing.");
        count++;
      }
      return count;
    });
    result.embedded += written;
    result.reused += planned.length - written;
  }

  return result;
}

export type IndexedProspect = {
  id: string;
  companyName: string;
  website: string | null;
  embeddedChunks: number;
};

// Prospects that Ask Relay can answer for: those with embedded research.
export async function listIndexedProspects(
  database: Database,
): Promise<IndexedProspect[]> {
  const result = await database.query<{
    id: string;
    company_name: string;
    website: string | null;
    embedded_chunks: number;
  }>(
    `SELECT p.id, p.company_name, p.website, count(*)::int AS embedded_chunks
    FROM prospects p
    JOIN research_chunks c ON c.prospect_id = p.id
    WHERE c.embedding IS NOT NULL AND c.embedding_model = $1
    GROUP BY p.id, p.company_name, p.website
    ORDER BY p.company_name, p.id`,
    [RESEARCH_EMBEDDING_MODEL],
  );
  return result.rows.map((row) => ({
    id: row.id,
    companyName: row.company_name,
    website: row.website,
    embeddedChunks: row.embedded_chunks,
  }));
}

export async function countEmbeddedResearchChunks(
  prospectId: string,
  database: Database,
): Promise<number> {
  const result = await database.query<{ count: string }>(
    `SELECT count(*) FROM research_chunks
    WHERE prospect_id = $1 AND embedding IS NOT NULL AND embedding_model = $2`,
    [prospectUuid(prospectId), RESEARCH_EMBEDDING_MODEL],
  );
  return Number(result.rows[0]?.count ?? 0);
}

// Exact cosine-distance search over one prospect's embedded chunks. The
// prospect filter is part of the query itself, so other prospects' chunks are
// never candidates.
export async function searchResearchChunks(
  input: { prospectId: string; embedding: number[]; limit: number },
  database: Database,
): Promise<RetrievedResearchChunk[]> {
  const prospectId = prospectUuid(input.prospectId);
  if (!isResearchEmbedding(input.embedding))
    throw new Error("Search embedding is invalid.");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20)
    throw new Error("Search limit must be between 1 and 20.");
  const result = await database.query<{
    id: string;
    research_document_id: string;
    source_url: string;
    chunk_index: number;
    content: string;
    distance: number;
  }>(
    `SELECT id, research_document_id, source_url, chunk_index, content,
      embedding OPERATOR(public.<=>) $2::public.vector AS distance
    FROM research_chunks
    WHERE prospect_id = $1 AND embedding IS NOT NULL AND embedding_model = $3
    ORDER BY distance, research_document_id, chunk_index
    LIMIT $4`,
    [
      prospectId,
      JSON.stringify(input.embedding),
      RESEARCH_EMBEDDING_MODEL,
      input.limit,
    ],
  );
  return result.rows.map((row) => ({
    id: row.id,
    researchDocumentId: row.research_document_id,
    sourceUrl: row.source_url,
    chunkIndex: row.chunk_index,
    content: row.content,
    similarity: 1 - row.distance,
  }));
}
