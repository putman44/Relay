ALTER TABLE prospect_research_requests
  ADD COLUMN website_index_status TEXT CHECK (website_index_status IN
    ('researching', 'indexing', 'ready', 'needs_review'));
