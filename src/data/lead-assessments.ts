import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { FIT_RUBRIC_VERSION } from "../research/fit-rubric.js";
import { RESEARCH_EMBEDDING_MODEL } from "../research/openai-embeddings.js";

type Database = Pick<Pool, "query">;

export const MAX_ASSESSMENT_ATTEMPTS = 3;
export const STALE_ASSESSMENT_MINUTES = 30;
const HISTORY_LIMIT = 10;

export type AssessmentStatus =
  | "generating"
  | "completed"
  | "failed"
  | "needs_review";

export type AssessmentUnavailableCode =
  | "not_eligible"
  | "in_progress"
  | "held"
  | "attempt_limit";

// A refusal made before any paid call. It carries no provider or driver text.
export class AssessmentUnavailableError extends Error {
  constructor(readonly code: AssessmentUnavailableCode) {
    super(
      {
        not_eligible: "This prospect has no complete, indexed website research to assess.",
        in_progress: "An assessment for this research is already running.",
        held: "An earlier assessment for this research needs review before another paid run.",
        attempt_limit: "Assessment attempts for this research reached the limit; review before another paid run.",
      }[code],
    );
    this.name = "AssessmentUnavailableError";
  }
}

export type EvidenceVersion = {
  researchRequestId: string;
  // SHA-256 of the fit rubric version, the research request, its documents, and
  // its embedded chunks. A rubric change therefore outdates earlier assessments.
  fingerprint: string;
  indexStatus: string | null;
  chunks: number;
  embeddedChunks: number;
};

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

// The research/index and rubric version an assessment analyzes. Read-only: it
// changes whenever a document, a chunk, an embedding model, or the fit rubric changes.
export async function currentEvidenceVersion(
  prospectId: string,
  database: Database,
): Promise<EvidenceVersion | null> {
  const request = (
    await database.query<{ id: string; website_index_status: string | null }>(
      "SELECT id, website_index_status FROM prospect_research_requests WHERE prospect_id = $1",
      [prospectId],
    )
  ).rows[0];
  if (!request) return null;
  const documents = (
    await database.query<{ source_url: string; content: string }>(
      `SELECT source_url, content FROM research_documents
      WHERE prospect_id = $1 AND research_request_id = $2 ORDER BY source_url, id`,
      [prospectId, request.id],
    )
  ).rows;
  const chunks = (
    await database.query<{
      source_url: string;
      chunk_index: number;
      content: string;
      embedding_model: string | null;
    }>(
      `SELECT d.source_url, c.chunk_index, c.content, c.embedding_model
      FROM research_chunks c
      JOIN research_documents d ON d.id = c.research_document_id
      WHERE c.prospect_id = $1 AND d.research_request_id = $2
      ORDER BY d.source_url, c.chunk_index`,
      [prospectId, request.id],
    )
  ).rows;
  return {
    researchRequestId: request.id,
    fingerprint: sha256(
      JSON.stringify([
        FIT_RUBRIC_VERSION,
        request.id,
        documents.map((row) => [row.source_url, sha256(row.content)]),
        chunks.map((row) => [
          row.source_url,
          row.chunk_index,
          sha256(row.content),
          row.embedding_model,
        ]),
      ]),
    ),
    indexStatus: request.website_index_status,
    chunks: chunks.length,
    embeddedChunks: chunks.filter(
      (row) => row.embedding_model === RESEARCH_EMBEDDING_MODEL,
    ).length,
  };
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

type AssessmentRefusal = { kind: "refused"; code: AssessmentUnavailableCode };

export type AssessmentReservation =
  | {
      kind: "reserved";
      id: string;
      researchRequestId: string;
      fingerprint: string;
    }
  | { kind: "existing"; id: string };

// Reserves the one paid run allowed for this prospect's current evidence before
// any provider call. A completed assessment for the same evidence is returned
// instead; an in-flight or held one refuses. The prospect row lock serializes
// concurrent starts, and the partial unique index backs it up.
export async function reserveAssessment(
  prospectId: string,
  deps: { database: Pool; model: string },
): Promise<AssessmentReservation> {
  try {
    // Refusals are returned, not thrown, so the stale-run hold below commits.
    const outcome = await transaction<AssessmentReservation | AssessmentRefusal>(deps.database, async (client) => {
      const prospect = await client.query(
        "SELECT id FROM prospects WHERE id = $1 FOR UPDATE",
        [prospectId],
      );
      if (prospect.rowCount !== 1) throw new Error("Prospect not found.");

      // A run that never reported back may still be spending: hold it.
      await client.query(
        `UPDATE lead_intake_assessments
        SET status = 'needs_review',
          last_error = 'Assessment run did not finish; inspect before another paid run.',
          updated_at = now()
        WHERE prospect_id = $1 AND status = 'generating'
          AND updated_at < now() - make_interval(mins => $2)`,
        [prospectId, STALE_ASSESSMENT_MINUTES],
      );

      const version = await currentEvidenceVersion(prospectId, client);
      if (
        !version ||
        (version.indexStatus !== null && version.indexStatus !== "ready") ||
        !version.chunks ||
        version.embeddedChunks !== version.chunks
      )
        return { kind: "refused", code: "not_eligible" };

      const rows = (
        await client.query<{ id: string; status: AssessmentStatus }>(
          `SELECT id, status FROM lead_intake_assessments
          WHERE prospect_id = $1 AND evidence_fingerprint = $2`,
          [prospectId, version.fingerprint],
        )
      ).rows;
      const completed = rows.find((row) => row.status === "completed");
      if (completed) return { kind: "existing", id: completed.id };
      if (rows.some((row) => row.status === "generating"))
        return { kind: "refused", code: "in_progress" };
      if (rows.some((row) => row.status === "needs_review"))
        return { kind: "refused", code: "held" };
      if (rows.length >= MAX_ASSESSMENT_ATTEMPTS)
        return { kind: "refused", code: "attempt_limit" };

      const id = randomUUID();
      await client.query(
        `INSERT INTO lead_intake_assessments (
          id, prospect_id, research_request_id, evidence_fingerprint, status, model
        ) VALUES ($1, $2, $3, $4, 'generating', $5)`,
        [id, prospectId, version.researchRequestId, version.fingerprint, deps.model],
      );
      return {
        kind: "reserved",
        id,
        researchRequestId: version.researchRequestId,
        fingerprint: version.fingerprint,
      };
    });
    if (outcome.kind === "refused") throw new AssessmentUnavailableError(outcome.code);
    return outcome;
  } catch (error) {
    if ((error as { code?: unknown }).code === "23505")
      throw new AssessmentUnavailableError("in_progress");
    throw error;
  }
}

// Only a generating row can finish, so a held or stale run is never overwritten.
export async function completeAssessment(
  id: string,
  result: unknown,
  withheldCount: number,
  database: Database,
): Promise<void> {
  const updated = await database.query(
    `UPDATE lead_intake_assessments
    SET status = 'completed', result = $2, withheld_count = $3,
      last_error = NULL, updated_at = now()
    WHERE id = $1 AND status = 'generating'`,
    [id, JSON.stringify(result), withheldCount],
  );
  if (updated.rowCount !== 1)
    throw new Error("Assessment changed before it could be saved.");
}

// failed: a response arrived but was unusable (a known outcome). needs_review:
// the provider outcome is uncertain, so the run is held for a human.
export async function endAssessmentWithoutResult(
  id: string,
  status: "failed" | "needs_review",
  error: string,
  database: Database,
): Promise<void> {
  await database.query(
    `UPDATE lead_intake_assessments
    SET status = $2, last_error = $3, updated_at = now()
    WHERE id = $1 AND status = 'generating'`,
    [id, status, error],
  );
}

export type AssessmentRecord = {
  id: string;
  status: AssessmentStatus;
  researchRequestId: string;
  evidenceFingerprint: string;
  model: string;
  result: unknown;
  withheldCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  // Completed against research that has since changed.
  outdated: boolean;
};

export type AssessmentHistory = {
  // Null when the prospect has no research request.
  current: EvidenceVersion | null;
  // Newest first; the assessments are never rewritten.
  records: AssessmentRecord[];
};

export async function listAssessments(
  prospectId: string,
  database: Database,
): Promise<AssessmentHistory> {
  const current = await currentEvidenceVersion(prospectId, database);
  const rows = (
    await database.query<{
      id: string;
      status: AssessmentStatus;
      research_request_id: string;
      evidence_fingerprint: string;
      model: string;
      result: unknown;
      withheld_count: number;
      last_error: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, research_request_id, evidence_fingerprint, model, result,
        withheld_count, last_error, created_at, updated_at,
        CASE WHEN status = 'generating'
          AND updated_at < now() - make_interval(mins => $2)
          THEN 'needs_review' ELSE status END AS status
      FROM lead_intake_assessments WHERE prospect_id = $1
      ORDER BY created_at DESC, id LIMIT ${HISTORY_LIMIT}`,
      [prospectId, STALE_ASSESSMENT_MINUTES],
    )
  ).rows;
  return {
    current,
    records: rows.map((row) => ({
      id: row.id,
      status: row.status,
      researchRequestId: row.research_request_id,
      evidenceFingerprint: row.evidence_fingerprint,
      model: row.model,
      result: row.result,
      withheldCount: row.withheld_count,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      outdated:
        row.status === "completed" &&
        row.evidence_fingerprint !== current?.fingerprint,
    })),
  };
}
