ALTER TABLE message_drafts
ADD COLUMN send_status TEXT NOT NULL DEFAULT 'pending'
CHECK (
  send_status IN (
    'pending',
    'sending',
    'sent',
    'needs_reconciliation'
  )
);