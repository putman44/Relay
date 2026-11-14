import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { collectResearchEvidence, safeResearchUrl, type PageScraper, type ResearchEvidence } from "./research-evidence.js";
import { saveResearchPages } from "../data/save-research-pages.js";
import { countEmbeddedResearchChunks, indexProspectResearch } from "../data/research-embeddings.js";
import type { Embedder } from "./openai-embeddings.js";
import { FirecrawlScrapeError } from "./firecrawl-scraper.js";
import type { WebsiteDiagnostic, WebsiteDiagnosticKind } from "./website-diagnostic.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Job = { id: string; status: string; website_index_status: string; evidence: unknown; input_snapshot: { website?: unknown } };
type Reservation = { id: string; website: string; collect: boolean };
type Dependencies = { database: Pool; scrape: PageScraper; embed: Embedder };

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
  deps: Dependencies,
): Promise<void> {
  if (!UUID.test(prospectId)) throw new Error("Valid prospect ID required.");
  const reservation = await transaction(deps.database, async (client) => {
    const prospect = (await client.query<{ id: string; website: string | null; company_name: string; industry: string | null; contact_email: string | null; contact_name: string | null; primary_discovery_question: string | null; stage: string }>(
      "SELECT * FROM prospects WHERE id = $1 FOR UPDATE", [prospectId],
    )).rows[0];
    if (!prospect) throw new Error("Prospect not found.");
    const current = (await client.query<Job>(
      "SELECT id, status, website_index_status, evidence, input_snapshot FROM prospect_research_requests WHERE prospect_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE", [prospectId],
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
  await executeReserved(prospectId, reservation, deps);
}

async function executeReserved(prospectId: string, reservation: Reservation, deps: Dependencies): Promise<void> {
  if (reservation.collect) {
    const holdCollection = async (kind: WebsiteDiagnosticKind, error: unknown, provider?: FirecrawlScrapeError) => {
      const diagnostic: WebsiteDiagnostic = { version: 1, kind, stage: kind === "persistence_failed" ? "persistence" : "collection",
        requestId: reservation.id, timestamp: new Date().toISOString() };
      if (provider?.providerRequestId) diagnostic.providerRequestId = provider.providerRequestId;
      if (provider?.httpStatus !== undefined) diagnostic.httpStatus = provider.httpStatus;
      await deps.database.query(
        `UPDATE prospect_research_requests SET status = 'needs_reconciliation', website_index_status = 'needs_review',
         last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'researching' AND website_index_status = 'researching'`,
        [reservation.id, JSON.stringify(diagnostic)],
      ).catch(() => {});
      throw error;
    };
    let evidence: ResearchEvidence;
    let scrapeAttempted = false;
    try {
      evidence = await collectResearchEvidence(reservation.website, (url) => {
        scrapeAttempted = true;
        return deps.scrape(url);
      });
    } catch (error) {
      const provider = error instanceof FirecrawlScrapeError ? error : undefined;
      await holdCollection(provider?.kind ?? (scrapeAttempted ? "provider_uncertain" : "request_not_sent"), error, provider);
    }
    try {
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
    } catch (error) { await holdCollection("persistence_failed", error); }
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
    const diagnostic: WebsiteDiagnostic = { version: 1, kind: "embedding_failed", stage: "embedding",
      requestId: reservation.id, timestamp: new Date().toISOString() };
    await deps.database.query(
      `UPDATE prospect_research_requests SET website_index_status = 'needs_review',
       last_error = $2, updated_at = now()
       WHERE id = $1 AND website_index_status = 'indexing'`, [reservation.id, JSON.stringify(diagnostic)],
    ).catch(() => {});
    throw error;
  }
}

export type WebsiteRecoveryApproval = {
  prospectId: string;
  originalRequestId: string;
  operatorId: string;
  basis: string;
};

// Records one human reconciliation decision. This function never contacts a provider.
export async function approveWebsiteRecovery(input: WebsiteRecoveryApproval, database: Pool): Promise<string> {
  if (!UUID.test(input.prospectId) || !UUID.test(input.originalRequestId) ||
      input.operatorId.trim().length < 2 || input.operatorId.trim().length > 120 ||
      input.basis.trim().length < 20 || input.basis.trim().length > 2000)
    throw new Error("Valid recovery identity, operator and basis required.");
  return transaction(database, async (client) => {
    const prospect = (await client.query<{ website: string | null; stage: string }>(
      "SELECT website, stage FROM prospects WHERE id = $1 FOR UPDATE", [input.prospectId],
    )).rows[0];
    const original = (await client.query<Job>(
      `SELECT id, status, website_index_status, evidence, input_snapshot
       FROM prospect_research_requests WHERE id = $1 AND prospect_id = $2 AND replaces_request_id IS NULL FOR UPDATE`,
      [input.originalRequestId, input.prospectId],
    )).rows[0];
    if (!prospect?.website || prospect.stage !== "researching" ||
      !original || original.status !== "needs_reconciliation" || original.website_index_status !== "needs_review" || original.evidence !== null ||
      safeResearchUrl(prospect.website) !== original.input_snapshot.website)
      throw new Error("Held collection is not eligible for replacement.");
    const artifacts = await client.query<{ documents: string; chunks: string }>(
      `SELECT (SELECT count(*) FROM research_documents WHERE prospect_id = $1) AS documents,
        (SELECT count(*) FROM research_chunks WHERE prospect_id = $1) AS chunks`, [input.prospectId],
    );
    if (Number(artifacts.rows[0]?.documents) !== 0 || Number(artifacts.rows[0]?.chunks) !== 0)
      throw new Error("Saved research requires inspection before replacement.");
    const id = randomUUID();
    await client.query(
      `INSERT INTO prospect_research_requests
        (id, prospect_id, status, owner_token, input_snapshot, drive_parent_id,
         gmail_draft_allowed, website_index_status, replaces_request_id,
         reconciliation_basis, operator_decision, operator_id, reconciled_at)
       VALUES ($1,$2,'recovery_approved',$3,$4,'',false,'needs_review',$5,$6,
         'authorize_one_replacement_collection',$7,now())`,
      [id, input.prospectId, randomUUID(), JSON.stringify(original.input_snapshot), original.id,
        input.basis.trim(), input.operatorId.trim()],
    );
    return id;
  });
}

// A separate explicit action reserves the only replacement before a paid call.
// Any uncertain result stays held; neither a restart nor a second command repeats it.
export async function startApprovedWebsiteRecovery(
  prospectId: string, replacementId: string, deps: Dependencies,
): Promise<void> {
  if (!UUID.test(prospectId) || !UUID.test(replacementId)) throw new Error("Valid recovery identity required.");
  const reservation = await transaction(deps.database, async (client) => {
    const prospect = (await client.query<{ website: string | null; stage: string }>(
      "SELECT website, stage FROM prospects WHERE id = $1 FOR UPDATE", [prospectId],
    )).rows[0];
    const replacement = (await client.query<Job & { replaces_request_id: string }>(
      `SELECT id, status, website_index_status, evidence, input_snapshot, replaces_request_id
       FROM prospect_research_requests WHERE id = $1 AND prospect_id = $2 FOR UPDATE`,
      [replacementId, prospectId],
    )).rows[0];
    if (!prospect?.website || prospect.stage !== "researching" || !replacement || !replacement.replaces_request_id ||
      replacement.status !== "recovery_approved" || replacement.website_index_status !== "needs_review" ||
      safeResearchUrl(prospect.website) !== replacement.input_snapshot.website)
      throw new Error("Replacement is not approved or has already started.");
    const original = (await client.query<Job>(
      "SELECT id, status, website_index_status, evidence FROM prospect_research_requests WHERE id = $1 FOR UPDATE",
      [replacement.replaces_request_id],
    )).rows[0];
    if (!original || original.status !== "needs_reconciliation" || original.website_index_status !== "needs_review" || original.evidence !== null)
      throw new Error("Original hold changed; inspect before recovery.");
    const artifacts = await client.query<{ documents: string; chunks: string }>(
      `SELECT (SELECT count(*) FROM research_documents WHERE prospect_id = $1) AS documents,
        (SELECT count(*) FROM research_chunks WHERE prospect_id = $1) AS chunks`, [prospectId],
    );
    if (Number(artifacts.rows[0]?.documents) !== 0 || Number(artifacts.rows[0]?.chunks) !== 0)
      throw new Error("Research appeared after approval; inspect before recovery.");
    await client.query(
      `UPDATE prospect_research_requests SET status = 'researching', website_index_status = 'researching',
       updated_at = now() WHERE id = $1`, [replacement.id],
    );
    return { id: replacement.id, website: prospect.website, collect: true };
  });
  await executeReserved(prospectId, reservation, deps);
}
