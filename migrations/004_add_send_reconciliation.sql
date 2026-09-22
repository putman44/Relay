ALTER TABLE message_drafts
ADD COLUMN send_error TEXT,
ADD COLUMN reconciliation_at TIMESTAMPTZ;