-- Evidence-based lead intake assessments. One row per paid generation attempt,
-- linked to the prospect and the research/index version it analyzed. Rows are
-- history: a completed assessment is never rewritten, and a changed research
-- fingerprint marks it outdated instead of replacing it.
CREATE TABLE lead_intake_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  research_request_id UUID NOT NULL,
  -- SHA-256 over the research request, its documents, and its embedded chunks.
  evidence_fingerprint TEXT NOT NULL CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN (
    'generating', 'completed', 'failed', 'needs_review'
  )),
  model TEXT NOT NULL CHECK (btrim(model) <> ''),
  result JSONB,
  -- Model statements dropped because their quotes could not be verified.
  withheld_count INTEGER NOT NULL DEFAULT 0 CHECK (withheld_count >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (prospect_id, research_request_id)
    REFERENCES prospect_research_requests(prospect_id, id) ON DELETE CASCADE,
  CONSTRAINT lead_intake_assessments_result_matches_status CHECK (
    (status = 'completed') = (result IS NOT NULL)
  )
);

-- At most one in-flight, completed, or held run per evidence version. Only a
-- failed (known-invalid) attempt leaves room for another paid run.
CREATE UNIQUE INDEX lead_intake_assessments_one_run_per_evidence
  ON lead_intake_assessments (prospect_id, evidence_fingerprint)
  WHERE status IN ('generating', 'completed', 'needs_review');

CREATE INDEX lead_intake_assessments_by_prospect
  ON lead_intake_assessments (prospect_id, created_at DESC, id);
