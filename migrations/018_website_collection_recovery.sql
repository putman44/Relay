-- A replacement is a separate, auditable attempt. The original held request is never rewritten.
ALTER TABLE prospect_research_requests
  DROP CONSTRAINT prospect_research_requests_prospect_id_key;

ALTER TABLE prospect_research_requests
  ADD COLUMN replaces_request_id UUID,
  ADD COLUMN reconciliation_basis TEXT,
  ADD COLUMN operator_decision TEXT,
  ADD COLUMN operator_id TEXT,
  ADD COLUMN reconciled_at TIMESTAMPTZ,
  ADD CONSTRAINT website_recovery_original_identity
    FOREIGN KEY (prospect_id, replaces_request_id)
    REFERENCES prospect_research_requests (prospect_id, id),
  ADD CONSTRAINT website_recovery_audit_complete CHECK (
    (replaces_request_id IS NULL AND reconciliation_basis IS NULL
      AND operator_decision IS NULL AND operator_id IS NULL AND reconciled_at IS NULL)
    OR
    (replaces_request_id IS NOT NULL AND length(btrim(reconciliation_basis)) BETWEEN 20 AND 2000
      AND operator_decision = 'authorize_one_replacement_collection'
      AND length(btrim(operator_id)) BETWEEN 2 AND 120 AND reconciled_at IS NOT NULL)
  );

-- Preserve the legacy one-root-request rule and allow at most one replacement.
CREATE UNIQUE INDEX website_research_one_root_per_prospect
  ON prospect_research_requests (prospect_id) WHERE replaces_request_id IS NULL;
CREATE UNIQUE INDEX website_research_one_replacement_per_prospect
  ON prospect_research_requests (prospect_id) WHERE replaces_request_id IS NOT NULL;
CREATE UNIQUE INDEX website_research_one_replacement_per_original
  ON prospect_research_requests (replaces_request_id) WHERE replaces_request_id IS NOT NULL;

ALTER TABLE prospect_research_requests DROP CONSTRAINT prospect_research_requests_status_check;
ALTER TABLE prospect_research_requests ADD CONSTRAINT prospect_research_requests_status_check
  CHECK (status IN (
    'researching', 'research_ready', 'folder_creating', 'folder_ready',
    'brief_creating', 'brief_ready', 'draft_creating', 'completed',
    'needs_contact', 'research_review', 'failed', 'needs_reconciliation',
    'recovery_approved'
  ));
