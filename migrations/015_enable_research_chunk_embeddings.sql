-- Select the research chunk embedding model: OpenAI text-embedding-3-small,
-- 1536 dimensions. Migration 014 required every embedding to stay NULL until
-- this decision. Changing the model or dimension requires a new migration.
--
-- No approximate-nearest-neighbor index is created. Searches are always scoped
-- to one prospect (research_chunks_by_prospect) and compare that prospect's
-- chunks exactly, so a filtered ANN scan cannot silently drop matches.

ALTER TABLE research_chunks
  DROP CONSTRAINT research_chunks_embedding_model_not_selected;

-- Every existing row has a NULL embedding (enforced by migration 014), so the
-- dimension is applied without converting any stored vector.
ALTER TABLE research_chunks
  ALTER COLUMN embedding TYPE public.vector(1536);

ALTER TABLE research_chunks
  ADD COLUMN embedding_model TEXT;

-- IS NOT DISTINCT FROM keeps the check from evaluating to NULL (which would
-- pass) when an embedding is stored without a model.
ALTER TABLE research_chunks
  ADD CONSTRAINT research_chunks_embedding_model CHECK (
    (embedding IS NULL AND embedding_model IS NULL)
    OR (
      embedding IS NOT NULL
      AND embedding_model IS NOT DISTINCT FROM 'text-embedding-3-small'
    )
  );

COMMENT ON COLUMN research_chunks.embedding IS
  'OpenAI text-embedding-3-small (1536 dimensions) of content, selected in migration 015. NULL until the chunk is embedded.';
COMMENT ON COLUMN research_chunks.embedding_model IS
  'Model that produced embedding. Required exactly when embedding is set.';
