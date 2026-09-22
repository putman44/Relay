CREATE TABLE prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  company_name TEXT NOT NULL,
  website TEXT,
  contact_name TEXT,
  contact_email TEXT,

  stage TEXT NOT NULL DEFAULT 'researching',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);