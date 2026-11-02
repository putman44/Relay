CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

ALTER TABLE prospect_intake_requests
  ALTER COLUMN identity_key DROP NOT NULL;

ALTER TABLE prospect_research_requests
  ADD CONSTRAINT prospect_research_request_prospect_identity
  UNIQUE (prospect_id, id);

CREATE TABLE research_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  research_request_id UUID NOT NULL,
  source_url TEXT NOT NULL CHECK (btrim(source_url) <> ''),
  page_type TEXT NOT NULL CHECK (page_type IN (
    'homepage', 'about', 'services', 'contact', 'team', 'faq',
    'case_study', 'blog', 'other'
  )),
  title TEXT CHECK (title IS NULL OR btrim(title) <> ''),
  content TEXT NOT NULL CHECK (btrim(content) <> ''),
  scraped_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (research_request_id, source_url),
  UNIQUE (id, prospect_id),
  FOREIGN KEY (prospect_id, research_request_id)
    REFERENCES prospect_research_requests(prospect_id, id) ON DELETE CASCADE
);

CREATE INDEX research_documents_by_prospect
  ON research_documents (prospect_id, scraped_at DESC, id);

CREATE TABLE research_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  research_document_id UUID NOT NULL,
  content TEXT NOT NULL CHECK (btrim(content) <> ''),
  embedding public.vector,
  source_url TEXT NOT NULL CHECK (btrim(source_url) <> ''),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (research_document_id, chunk_index),
  FOREIGN KEY (research_document_id, prospect_id)
    REFERENCES research_documents(id, prospect_id) ON DELETE CASCADE,
  CONSTRAINT research_chunks_embedding_model_not_selected CHECK (embedding IS NULL)
);

COMMENT ON COLUMN research_chunks.embedding IS
  'Phase 1 placeholder. NULL is required until an embedding model and dimension are selected in a deliberate later migration.';

CREATE INDEX research_chunks_by_prospect
  ON research_chunks (prospect_id, research_document_id, chunk_index);

CREATE TABLE communications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel TEXT NOT NULL CHECK (channel = 'email'),
  gmail_message_id TEXT NOT NULL UNIQUE CHECK (btrim(gmail_message_id) <> ''),
  gmail_thread_id TEXT CHECK (gmail_thread_id IS NULL OR btrim(gmail_thread_id) <> ''),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('sent', 'received')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (direction = 'outbound' AND status = 'sent' AND sent_at IS NOT NULL AND received_at IS NULL)
    OR
    (direction = 'inbound' AND status = 'received' AND received_at IS NOT NULL AND sent_at IS NULL)
  )
);

CREATE INDEX communications_timeline
  ON communications (prospect_id, COALESCE(sent_at, received_at) DESC, id);
