CREATE TABLE prospect_intake_requests (
  id UUID PRIMARY KEY,
  prospect_id UUID NOT NULL UNIQUE REFERENCES prospects(id),
  identity_key TEXT NOT NULL UNIQUE CHECK (btrim(identity_key) <> ''),
  input_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
