ALTER TABLE prospects ADD COLUMN cold_outreach_blocked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE prospects DROP CONSTRAINT prospect_stage_check;
ALTER TABLE prospects ADD CONSTRAINT prospect_stage_check CHECK
  (stage IN ('researching', 'draft_ready', 'outreach_sent', 'send_reconciliation', 'replied'));

CREATE TABLE prospect_replies (
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (prospect_id, gmail_message_id)
);
CREATE INDEX prospect_replies_latest ON prospect_replies (prospect_id, received_at DESC, gmail_message_id);

CREATE TABLE reply_thread_checks (
  draft_id UUID PRIMARY KEY REFERENCES message_drafts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'unavailable')),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
