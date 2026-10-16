ALTER TABLE prospects ADD COLUMN primary_discovery_question TEXT;
ALTER TABLE message_drafts ADD COLUMN follow_up_number SMALLINT;
ALTER TABLE message_drafts ADD COLUMN parent_outreach_draft_id UUID REFERENCES message_drafts(id);
ALTER TABLE message_drafts ADD CONSTRAINT follow_up_number_check CHECK
  (follow_up_number IS NULL OR (draft_type = 'follow_up' AND follow_up_number IN (1,2)));
CREATE UNIQUE INDEX follow_up_draft_per_touch ON message_drafts (prospect_id, follow_up_number)
  WHERE draft_type = 'follow_up' AND follow_up_number IS NOT NULL;

CREATE TABLE follow_up_draft_requests (
  id UUID PRIMARY KEY,
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  parent_outreach_draft_id UUID NOT NULL REFERENCES message_drafts(id),
  follow_up_number SMALLINT NOT NULL CHECK (follow_up_number IN (1,2)),
  time_zone TEXT NOT NULL,
  due_date DATE NOT NULL,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  parent_sent_message_id TEXT NOT NULL,
  parent_rfc_message_id TEXT NOT NULL,
  history_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','created','failed','needs_reconciliation')),
  gmail_draft_id TEXT,
  gmail_message_id TEXT,
  returned_gmail_thread_id TEXT,
  gmail_thread_id TEXT NOT NULL,
  approved_content_hash TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prospect_id, follow_up_number)
);
CREATE TABLE follow_up_send_attempts (
  draft_id UUID PRIMARY KEY REFERENCES message_drafts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('preflight','invoking','sent','blocked','needs_reconciliation')),
  approved_snapshot JSONB NOT NULL,
  sent_message_id TEXT,
  gmail_thread_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
