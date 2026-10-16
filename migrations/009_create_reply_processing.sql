ALTER TABLE prospects ADD COLUMN communication_opted_out BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE message_drafts ADD COLUMN source_reply_message_id TEXT;
ALTER TABLE message_drafts ADD CONSTRAINT message_draft_source_reply_fk
  FOREIGN KEY (prospect_id, source_reply_message_id)
  REFERENCES prospect_replies (prospect_id, gmail_message_id);
CREATE UNIQUE INDEX response_draft_per_reply ON message_drafts (prospect_id, source_reply_message_id)
  WHERE draft_type = 'response' AND source_reply_message_id IS NOT NULL;

CREATE TABLE reply_processing_requests (
  id UUID PRIMARY KEY,
  prospect_id UUID NOT NULL,
  source_reply_message_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'classifying' CHECK
    (status IN ('classifying','creating','created','no_draft','failed','stale','needs_reconciliation')),
  classification JSONB,
  review_status TEXT NOT NULL DEFAULT 'needs_review' CHECK (review_status = 'needs_review'),
  gmail_draft_id TEXT,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prospect_id, source_reply_message_id),
  FOREIGN KEY (prospect_id, source_reply_message_id)
    REFERENCES prospect_replies (prospect_id, gmail_message_id) ON DELETE CASCADE
);
