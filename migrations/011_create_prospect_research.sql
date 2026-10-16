ALTER TABLE prospects ADD COLUMN industry TEXT;
ALTER TABLE prospects DROP CONSTRAINT prospect_stage_check;
ALTER TABLE prospects ADD CONSTRAINT prospect_stage_check CHECK (stage IN (
  'researching', 'research_in_progress', 'needs_contact', 'research_review',
  'draft_ready', 'outreach_sent', 'send_reconciliation', 'replied'
));

CREATE TABLE prospect_research_requests (
  id UUID PRIMARY KEY,
  prospect_id UUID NOT NULL UNIQUE REFERENCES prospects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN (
    'researching', 'research_ready', 'folder_creating', 'folder_ready',
    'brief_creating', 'brief_ready', 'draft_creating', 'completed',
    'needs_contact', 'research_review', 'failed', 'needs_reconciliation'
  )),
  owner_token UUID NOT NULL,
  input_snapshot JSONB NOT NULL,
  drive_parent_id TEXT NOT NULL,
  evidence JSONB,
  result JSONB,
  folder_id TEXT,
  brief_id TEXT,
  brief_url TEXT,
  gmail_draft_id TEXT,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE message_drafts ADD COLUMN research_request_id UUID UNIQUE
  REFERENCES prospect_research_requests(id);
