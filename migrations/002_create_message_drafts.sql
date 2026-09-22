CREATE TABLE message_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  prospect_id UUID NOT NULL
    REFERENCES prospects(id)
    ON DELETE CASCADE,

  draft_type TEXT NOT NULL DEFAULT 'outreach'
    CHECK (draft_type IN ('outreach', 'follow_up', 'response')),

  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,

  gmail_draft_id TEXT UNIQUE,
  gmail_thread_id TEXT,

  review_status TEXT NOT NULL DEFAULT 'needs_review'
    CHECK (
      review_status IN (
        'needs_review',
        'approved',
        'needs_edit',
        'rejected',
        'sent'
      )
    ),

  review_notes TEXT,

  sent_message_id TEXT,
  sent_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);