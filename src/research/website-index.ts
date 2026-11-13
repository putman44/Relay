import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { collectResearchEvidence, safeResearchUrl, type PageScraper } from "./research-evidence.js";
import { saveResearchPages } from "../data/save-research-pages.js";
import { countEmbeddedResearchChunks, indexProspectResearch } from "../data/research-embeddings.js";
import type { Embedder } from "./openai-embeddings.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Job = { id: string; status: string; website_index_status: string; evidence: unknown; input_snapshot: { website?: unknown } };

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the first error. */ }
    throw error;
  } finally { client.release(); }
}

// A unique research request is reserved before any paid call. An uncertain
// Firecrawl outcome remains held for operator review; it is never scraped again.
export async function researchAndIndexWebsite(
  prospectId: string,
  deps: { database: Pool; scrape: PageScraper; embed: Embedder },
): Promise<void> {
  if (!UUID.test(prospectId)) throw new Error("Valid prospect ID required.");
  const reservation = await transaction(deps.database, async (client) => {
    const prospect = (await client.query<{ id: string; website: string | null; company_name: string; industry: string | null; contact_email: string | null; contact_name: string | null; primary_discovery_question: string | null; stage: string }>(
      "SELECT * FROM prospects WHERE id = $1 FOR UPDATE", [prospectId],
    )).rows[0];
    if (!prospect) throw new Error("Prospect not found.");
    const current = (await client.query<Job>(
      "SELECT id, status, website_index_status, evidence, input_snapshot FROM prospect_research_requests WHERE prospect_id = $1 FOR UPDATE", [prospectId],
    )).rows[0];
    if (current) {
      if (current.status === "completed" && current.website_index_status === "needs_review" && current.evidence) {
        if (!prospect.website || safeResearchUrl(prospect.website) !== current.input_snapshot.website)
          throw new Error("Prospect website changed; inspect saved research before indexing.");
        await client.query("UPDATE prospect_research_requests SET website_index_status = 'indexing', updated_at = now() WHERE id = $1", [current.id]);
        return { id: current.id, website: prospect.website!, collect: false };
      }
      throw new Error("Existing research requires review or is already indexed.");
    }
    if (prospect.stage !== "researching" || !prospect.website) throw new Error("Prospect is not eligible for website indexing.");
    const website = safeResearchUrl(prospect.website);
    const id = randomUUID();
    await client.query(
      `INSERT INTO prospect_research_requests
       (id, prospect_id, status, owner_token, input_snapshot, drive_parent_id, gmail_draft_allowed, website_index_status)
       VALUES ($1,$2,'researching',$3,$4,'',false,'researching')`,
      [id, prospectId, randomUUID(), JSON.stringify({
        company_name: prospect.company_name, website, industry: prospect.industry,
        contact_email: prospect.contact_email, contact_name: prospect.contact_name,
        primary_discovery_question: prospect.primary_discovery_question,
      })],
    );
    return { id, website, collect: true };
  });
  if (reservation.collect) {
    try {
      const evidence = await collectResearchEvidence(reservation.website, deps.scrape);
      await transaction(deps.database, async (client) => {
        const row = await client.query(
          "SELECT id FROM prospect_research_requests WHERE id = $1 AND website_index_status = 'researching' FOR UPDATE", [reservation.id],
        );
        if (row.rowCount !== 1) throw new Error("Website indexing reservation changed.");
        await saveResearchPages({ prospectId, researchRequestId: reservation.id, website: reservation.website, evidence }, client);
        await client.query(
          "UPDATE prospect_research_requests SET status = 'completed', website_index_status = 'indexing', evidence = $2, updated_at = now() WHERE id = $1",
          [reservation.id, JSON.stringify(evidence)],
        );
      });
    } catch (error) {
      // If the checkpoint write itself is uncertain, the reservation still
      // prevents a second scrape. A human can reconcile it from the DB.
      await deps.database.query(
        `UPDATE prospect_research_requests SET status = 'needs_reconciliation', website_index_status = 'needs_review',
         last_error = 'Website collection outcome uncertain; inspect before retry.', updated_at = now()
         WHERE id = $1 AND status = 'researching' AND website_index_status = 'researching'`, [reservation.id],
      ).catch(() => {});
      throw error;
    }
  }
  try {
    const result = await indexProspectResearch(prospectId, { database: deps.database, embed: deps.embed });
    if (!result.documents || !result.chunks) throw new Error("No indexable research was saved.");
    if (await countEmbeddedResearchChunks(prospectId, deps.database) !== result.chunks)
      throw new Error("Research embeddings are incomplete.");
    await deps.database.query(
      "UPDATE prospect_research_requests SET website_index_status = 'ready', last_error = NULL, updated_at = now() WHERE id = $1 AND website_index_status = 'indexing'",
      [reservation.id],
    );
  } catch (error) {
    await deps.database.query(
      `UPDATE prospect_research_requests SET website_index_status = 'needs_review',
       last_error = 'Indexing did not complete; inspect saved documents before retry.', updated_at = now()
       WHERE id = $1 AND website_index_status = 'indexing'`, [reservation.id],
    ).catch(() => {});
    throw error;
  }
}
