ALTER TABLE prospects
ADD CONSTRAINT prospect_stage_check
CHECK (
  stage IN (
    'researching',
    'draft_ready',
    'outreach_sent',
    'send_reconciliation'
  )
);